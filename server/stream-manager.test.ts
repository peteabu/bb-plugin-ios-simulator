import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";
import { StreamManager, resolveNodeCommand, resolveServeSimEntry } from "./stream-manager";
import { HID, decodeHid } from "../lib/sim-protocol";

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? "SIGTERM");
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal ?? null));
    return true;
  }
}

function manager(options: {
  child?: FakeChild;
  healthyAfter?: number;
  node?: ReturnType<typeof resolveNodeCommand>;
  webSocket?: typeof WebSocket;
  freePort?: () => Promise<number>;
}) {
  const child = options.child ?? new FakeChild();
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  let polls = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    polls += 1;
    if (url.endsWith("/health") && polls >= (options.healthyAfter ?? 1)) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url.endsWith("/config")) {
      return new Response(JSON.stringify({ width: 393, height: 852, orientation: "portrait" }));
    }
    throw new Error("ECONNREFUSED");
  });
  const onChange = vi.fn();
  const streams = new StreamManager({
    log,
    node: () => ("node" in options ? options.node! : { command: "/usr/bin/node", args: [], source: "test" }),
    serveSim: () => ({ kind: "script", path: "/plugin/node_modules/serve-sim/dist/serve-sim.js", source: "dependency" }),
    spawn: spawn as never,
    fetch: fetchFn as unknown as typeof fetch,
    freePort: options.freePort ?? (async () => 43210),
    onChange,
    healthTimeoutMs: 2_000,
    pollIntervalMs: 5,
    webSocket: options.webSocket,
  });
  return { streams, spawn, fetchFn, child, onChange };
}

describe("resolveNodeCommand", () => {
  it("prefers the setting, then PATH, then Electron's node mode", () => {
    expect(resolveNodeCommand({ override: "/opt/node/bin/node" })).toMatchObject({
      command: "/opt/node/bin/node",
      source: "setting",
    });
    const onPath = resolveNodeCommand({
      env: { PATH: "/nowhere:/opt/homebrew/bin" },
      home: "/Users/nobody",
      executable: (path) => path === "/opt/homebrew/bin/node",
    });
    expect(onPath).toMatchObject({ command: "/opt/homebrew/bin/node" });
    const electron = resolveNodeCommand({
      env: { PATH: "" },
      home: "/Users/nobody",
      executable: () => false,
      isElectron: true,
      execPath: "/Applications/bb.app/Contents/MacOS/bb",
    });
    expect(electron).toMatchObject({
      command: "/Applications/bb.app/Contents/MacOS/bb",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(
      resolveNodeCommand({ env: { PATH: "" }, home: "/x", executable: () => false, isElectron: false, execPath: "/x/bun" }),
    ).toBeNull();
  });
});

function fakeWebSockets(autoOpen = true) {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventEmitter {
    readonly OPEN = 1;
    readonly CONNECTING = 0;
    readyState = 0;
    binaryType = "";
    sent: Uint8Array[] = [];
    closes = 0;
    constructor(readonly url: string) {
      super(); sockets.push(this);
      if (autoOpen) queueMicrotask(() => this.open());
    }
    open() { if (this.readyState === 0) { this.readyState = 1; this.emit("open"); } }
    send(data: Uint8Array) { this.sent.push(data); }
    close() {
      if (this.readyState === 3) return;
      this.closes++; this.readyState = 3;
      queueMicrotask(() => this.emit("close"));
    }
    terminate() { this.close(); }
  }
  return { sockets, WebSocket: FakeSocket as unknown as typeof WebSocket };
}

describe("session-owned HID controls", () => {
  it("shares a persistent connection across concurrent and later actions", async () => {
    const fake = fakeWebSockets();
    const { streams } = manager({ webSocket: fake.WebSocket });
    await streams.ensure("UDID");
    const send = () => streams.withHid("UDID", async (hid) => hid.send(HID.BUTTON, { button: "home" }));
    await Promise.all([send(), send()]); await send();
    expect(fake.sockets).toHaveLength(1);
    expect(fake.sockets[0]!.sent.map((data) => decodeHid(data)?.payload)).toEqual([
      { button: "home" }, { button: "home" }, { button: "home" },
    ]);
    expect(fake.sockets[0]!.closes).toBe(0);
    await streams.stop("UDID");
    expect(fake.sockets[0]!.closes).toBe(1);
  });

  it("reconnects for the next action after closure without replaying an earlier action", async () => {
    const fake = fakeWebSockets();
    const { streams } = manager({ webSocket: fake.WebSocket });
    await streams.ensure("UDID");
    await streams.withHid("UDID", async (hid) => hid.send(HID.BUTTON, { button: "home" }));
    fake.sockets[0]!.close(); await Promise.resolve();
    await streams.withHid("UDID", async (hid) => hid.send(HID.BUTTON, { button: "lock" }));
    expect(fake.sockets).toHaveLength(2);
    expect(fake.sockets.map((socket) => socket.sent.map((data) => decodeHid(data)?.payload)))
      .toEqual([[{ button: "home" }], [{ button: "lock" }]]);
    await streams.stopAll();
    expect(fake.sockets.every((socket) => socket.closes === 1)).toBe(true);
  });

  it("reports a disconnected send instead of silently dropping the action", async () => {
    const fake = fakeWebSockets();
    const { streams } = manager({ webSocket: fake.WebSocket });
    await streams.ensure("UDID");
    await expect(streams.withHid("UDID", async (hid) => {
      fake.sockets[0]!.close();
      hid.send(HID.BUTTON, { button: "home" });
    })).rejects.toThrow("input connection closed");
    expect(fake.sockets[0]!.sent).toHaveLength(0);
    await streams.stopAll();
  });

  it("closes both the control and browser-relay sockets when the helper exits", async () => {
    const fake = fakeWebSockets();
    const { streams, child } = manager({ webSocket: fake.WebSocket });
    await streams.ensure("UDID");
    await streams.withHid("UDID", async () => {});
    const browserRelay = await streams.openHid("UDID");
    const onClose = vi.fn(); browserRelay.onClose(onClose);
    child.emit("exit", 1, null); await Promise.resolve();
    expect(fake.sockets).toHaveLength(2);
    expect(fake.sockets.every((socket) => socket.closes === 1)).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    await expect(streams.withHid("UDID", async () => {})).rejects.toThrow("No stream");
  });

  it("cancels an action waiting for the shared connection without cancelling other callers", async () => {
    const fake = fakeWebSockets(false);
    const { streams } = manager({ webSocket: fake.WebSocket });
    await streams.ensure("UDID");
    const controller = new AbortController();
    const cancelledWork = vi.fn(async () => {}), otherWork = vi.fn(async () => {});
    const cancelled = streams.withHid("UDID", cancelledWork, controller.signal).catch((error) => error);
    const other = streams.withHid("UDID", otherWork);
    controller.abort();
    expect(await cancelled).toBeInstanceOf(DOMException);
    expect(cancelledWork).not.toHaveBeenCalled();
    fake.sockets[0]!.open(); await other;
    expect(fake.sockets).toHaveLength(1); expect(otherWork).toHaveBeenCalledOnce();
    await streams.stopAll();
  });

  it("aborts a pending connection when its simulator session stops", async () => {
    const fake = fakeWebSockets(false);
    const { streams } = manager({ webSocket: fake.WebSocket });
    await streams.ensure("UDID");
    const work = vi.fn(async () => {});
    const pending = streams.withHid("UDID", work).catch((error) => error);
    await streams.stop("UDID");
    expect(await pending).toBeInstanceOf(Error);
    expect(work).not.toHaveBeenCalled();
    expect(fake.sockets[0]!.closes).toBe(1);
  });
});

describe("resolveServeSimEntry", () => {
  it("uses an override or the installed dependency", () => {
    expect(resolveServeSimEntry({ override: "/tmp/serve-sim.js" })).toMatchObject({ kind: "script" });
    expect(resolveServeSimEntry({ override: "/usr/local/bin/serve-sim" })).toMatchObject({ kind: "binary" });
    const found = resolveServeSimEntry({ importMetaUrl: import.meta.url });
    expect(found?.path.endsWith("/serve-sim/dist/serve-sim.js")).toBe(true);
    expect(resolveServeSimEntry({ importMetaUrl: import.meta.url, exists: () => false })).toBeNull();
  });
});

describe("StreamManager", () => {
  it("does not allocate or spawn for an already cancelled startup", async () => {
    const freePort = vi.fn(async () => 43210);
    const { streams, spawn } = manager({ freePort });
    const controller = new AbortController(); controller.abort();
    await expect(streams.ensure("UDID", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(freePort).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn a helper when cancellation happens during free-port allocation", async () => {
    let resolvePort!: (port: number) => void;
    const freePort = vi.fn(() => new Promise<number>(resolve => { resolvePort = resolve; }));
    const { streams, spawn } = manager({ freePort });
    const controller = new AbortController();
    const pending = streams.ensure("UDID", controller.signal);
    controller.abort(); resolvePort(43210);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled(); expect(streams.list()).toEqual([]);
  });

  it("spawns serve-sim for a device and resolves once the helper is healthy", async () => {
    const { streams, spawn, child, onChange } = manager({ healthyAfter: 3 });
    const session = await streams.ensure("UDID-1");
    expect(session).toMatchObject({ udid: "UDID-1", port: 43210, pid: 4242 });
    const [command, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe("/usr/bin/node");
    expect(args).toEqual([
      "/plugin/node_modules/serve-sim/dist/serve-sim.js",
      "UDID-1",
      "--port", "43210",
      "--host", "127.0.0.1",
      "--panes", "none",
      "--quiet",
      "--exit-on-simulator-shutdown",
    ]);
    expect(streams.helperUrl("UDID-1", "/ax")).toBe("http://127.0.0.1:43210/helper/UDID-1/ax");
    expect(await streams.screenConfig("UDID-1")).toEqual({ width: 393, height: 852, orientation: "portrait" });
    expect(onChange).toHaveBeenCalled();
    await expect(streams.ensure("UDID-1")).resolves.toEqual(session); // reused
    await streams.stop("UDID-1");
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(streams.get("UDID-1")).toBeNull();
  });

  it("fails with the process output when serve-sim exits early", async () => {
    const child = new FakeChild();
    const { streams } = manager({ child, healthyAfter: 1_000 });
    const pending = streams.ensure("UDID-2");
    await new Promise((resolve) => setTimeout(resolve, 20)); // let spawn attach listeners
    child.stderr.emit("data", "Device UDID-2 failed to reach booted state\n");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/failed to reach booted state/);
    expect(streams.list()).toEqual([]);
  });

  it("explains a missing Node.js instead of spawning", async () => {
    const { streams, spawn } = manager({ node: null });
    await expect(streams.ensure("UDID-3")).rejects.toThrow(/Node\.js was not found/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
