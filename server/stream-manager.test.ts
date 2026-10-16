import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { StreamManager, resolveNodeCommand, resolveServeSimEntry } from "./stream-manager";

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
    freePort: async () => 43210,
    onChange,
    healthTimeoutMs: 2_000,
    pollIntervalMs: 5,
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
