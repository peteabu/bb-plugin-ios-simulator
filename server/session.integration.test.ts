import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createPlugin, type SimulatorState } from "../server";
import { decodeHid, encodeHid, HID } from "../lib/sim-protocol";
import type { TimelineEvent } from "../lib/session-types";
import type { ReplayRecorder } from "./replay";
import type { Exec } from "./simctl";
import type { HidConnection, StreamManager, StreamSession } from "./stream-manager";

const UDID = "SESSION-PHONE";
const OWNER = { threadId: "thread-owner", projectId: "project-test" };
const OBSERVER = { threadId: "thread-observer", projectId: "project-test" };
const INPUT_FLAG = "com.apple.coredevice.dtuhidd.active";
const cleanups: Array<() => Promise<void>> = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeStreams() {
  const sessions = new Map<string, StreamSession>();
  const sent: Array<{ opcode: number; payload: unknown }> = [];
  const connections: HidConnection[] = [];
  let observe: ((opcode: number, payload: unknown) => void) | undefined;
  function connection(): HidConnection {
    let closed = false;
    const closeListeners = new Set<() => void>();
    const send = (opcode: number, payload: unknown) => {
      if (closed) throw new Error("Input connection closed");
      sent.push({ opcode, payload });
      observe?.(opcode, payload);
    };
    const hid: HidConnection = {
      config: { width: 393, height: 852, orientation: "portrait" },
      send,
      sendRaw(data) { const message = decodeHid(data); if (message) send(message.opcode, message.payload); },
      onMessage: () => () => {},
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(() => {
        if (closed) return;
        closed = true;
        for (const listener of closeListeners) listener();
        closeListeners.clear();
      }),
    };
    connections.push(hid);
    return hid;
  }
  const agent = connection();
  const streams = {
    list: () => [...sessions.values()],
    get: (udid: string) => sessions.get(udid) ?? null,
    helperUrl: (udid: string, path: string) => `http://127.0.0.1:1/helper/${udid}${path}`,
    ensure: vi.fn(async (udid: string, _signal?: AbortSignal) => {
      const session = sessions.get(udid) ?? { udid, port: 50000, pid: 1, startedAt: 1 };
      sessions.set(udid, session);
      return session;
    }),
    stop: vi.fn(async (udid: string) => { sessions.delete(udid); }),
    stopAll: vi.fn(async () => { sessions.clear(); for (const hid of connections) hid.close(); }),
    screenConfig: async () => agent.config,
    rawAccessibility: vi.fn(async () => JSON.stringify([{
      frame: { x: 0, y: 0, width: 393, height: 852 },
      children: [{ AXLabel: "Sign in", role_description: "button", frame: { x: 96, y: 700, width: 200, height: 50 }, children: [] }],
    }])),
    openHid: vi.fn(async () => connection()),
    withHid: async <T,>(_udid: string, work: (hid: HidConnection) => Promise<T>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return work(agent);
    },
  };
  return { streams, sent, connections, observe: (callback: typeof observe) => { observe = callback; } };
}

async function load(agentControl: "always" | "ask" | "never" = "always", deviceIds = [UDID]) {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  let inputShadowed = false;
  const exec: Exec = async (file, args, options) => {
    options?.signal?.throwIfAborted();
    calls.push({ file, args, input: options?.input });
    let stdout = "";
    if (file === "xcode-select") stdout = "/Applications/Xcode.app/Contents/Developer";
    if (args[1] === "list") stdout = JSON.stringify({ devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": deviceIds.map((udid) => ({ udid, name: "Session phone", state: "Booted", isAvailable: true })),
    } });
    if (args.includes("notifyutil") && args.includes("-g")) stdout = `${INPUT_FLAG} ${inputShadowed ? 1 : 0}\n`;
    if (args.includes("notifyutil") && args.includes("-s")) inputShadowed = false;
    return { stdout, stderr: "", code: 0 };
  };
  const events = new Map<string, TimelineEvent[]>();
  const replay = {
    ensure: vi.fn(), stop: vi.fn(), dispose: vi.fn(), setConfig: vi.fn(), watchApp: vi.fn(),
    record(udid: string, event: Omit<TimelineEvent, "id" | "at">) {
      const list = events.get(udid) ?? [];
      list.push({ ...event, id: String(list.length), at: Date.now() });
      events.set(udid, list);
    },
    events: (udid: string) => events.get(udid) ?? [],
    status: () => ({ recording: false, bufferedMs: 0, bytes: 0, error: null, app: null, diagnostics: null, clips: [] }),
  };
  const fake = fakeStreams();
  const { bb, harness } = createFakePluginHost({ pluginId: "ios-simulator", settings: { agentControl } });
  await createPlugin({ exec, streams: fake.streams as unknown as StreamManager, replay: replay as unknown as ReplayRecorder })(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  const state = async (threadId = OWNER.threadId) => await harness.behavior.callRpc("state", { threadId }) as SimulatorState;
  const attachAgent = () => harness.behavior.callAgentTool("ios_sim_attach", { device: UDID }, OWNER);
  const attachHuman = () => harness.behavior.callRpc("attach", { threadId: OWNER.threadId, device: UDID });
  const handoff = (mode: "human" | "agent") => harness.behavior.callRpc("control", { threadId: OWNER.threadId, udid: UDID, mode });
  return { bb, harness, calls, state, attachAgent, attachHuman, handoff, setInputShadowed: (value: boolean) => { inputShadowed = value; }, ...fake };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("iOS session control through the SDK host", () => {
  it("blocks another thread's agent tools and panel mutations while allowing its accessibility observation", async () => {
    const { harness, attachAgent, state, sent, calls, streams } = await load();
    await attachAgent();
    await harness.behavior.callAgentTool("ios_sim_attach", { device: UDID }, OBSERVER);
    const mutations: Array<[string, Record<string, unknown>]> = [
      ["ios_sim_tap", { x: 0.5, y: 0.5 }], ["ios_sim_swipe", { direction: "up" }],
      ["ios_sim_type", { text: "hello", method: "keys" }], ["ios_sim_paste", { text: "hello" }],
      ["ios_sim_press_button", { button: "home" }], ["ios_sim_rotate", { orientation: "landscape_right" }],
      ["ios_sim_install_and_launch", { appPath: "/tmp/Session.app", bundleId: "test.session" }],
      ["ios_sim_launch", { bundleId: "test.session" }], ["ios_sim_open_url", { url: "https://example.com" }],
      ["ios_sim_set_appearance", { appearance: "dark" }], ["ios_sim_repair_input", {}],
    ];
    for (const [name, input] of mutations) {
      const result = await harness.behavior.callAgentTool(name, { device: UDID, ...input }, OBSERVER);
      expect(result, name).toMatchObject({ isError: true });
      expect(JSON.stringify(result), name).toContain("controlled by thread thread-owner");
    }
    const panelMutations: Array<[string, Record<string, unknown>]> = [
      ["button", { button: "home" }], ["rotate", { orientation: "landscape_right" }],
      ["openUrl", { url: "https://example.com" }], ["pasteText", { text: "hello" }],
      ["repairInput", {}], ["detach", { shutdown: true }],
    ];
    for (const [method, input] of panelMutations) {
      await expect(harness.behavior.callRpc(method, { threadId: OBSERVER.threadId, udid: UDID, ...input }), method)
        .rejects.toThrow("controlled by thread thread-owner");
    }
    const ax = await harness.behavior.callAgentTool("ios_sim_describe_ui", { device: UDID }, OBSERVER);
    expect(ax).toContain("Sign in");
    expect(streams.rawAccessibility).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(calls.filter(({ args }) => ["install", "terminate", "launch", "openurl", "ui", "shutdown", "pbcopy"].includes(args[1] ?? ""))).toEqual([]);
    expect(calls.some(({ input }) => input !== undefined)).toBe(false);
    expect((await state()).controls[UDID]).toMatchObject({ threadId: OWNER.threadId, mode: "agent" });
  });

  it("aborts a long agent tap on handoff, releases its touch, and requires control to be returned before the next input", async () => {
    const { harness, attachAgent, handoff, sent, observe } = await load();
    await attachAgent();
    const began = deferred();
    observe((opcode, payload) => {
      if (opcode === HID.TOUCH && (payload as { type: string }).type === "begin") began.resolve();
    });
    const tap = harness.behavior.callAgentTool("ios_sim_tap", { x: 0.4, y: 0.6, holdMs: 5000 }, OWNER);
    await began.promise;
    await handoff("human");
    expect(await tap).toMatchObject({ isError: true });
    expect(sent).toEqual([
      { opcode: HID.TOUCH, payload: { type: "begin", x: 0.4, y: 0.6 } },
      { opcode: HID.TOUCH, payload: { type: "end", x: 0.4, y: 0.6 } },
    ]);
    const blocked = await harness.behavior.callAgentTool("ios_sim_press_button", { button: "home" }, OWNER);
    expect(blocked).toMatchObject({ isError: true });
    expect(JSON.stringify(blocked)).toContain("Let agent drive");
    expect(sent).toHaveLength(2);
    await handoff("agent");
    expect(await harness.behavior.callAgentTool("ios_sim_press_button", { button: "home" }, OWNER)).toContain("Pressed home");
    expect(sent.at(-1)?.opcode).toBe(HID.BUTTON);
  });

  it("closes and balances a human HID socket on handoff so returning control cannot revive its old input", async () => {
    const { harness, attachHuman, handoff, sent } = await load();
    await attachHuman();
    const socket = await harness.behavior.experimental_openWebSocket(`/hid?udid=${UDID}&threadId=${OWNER.threadId}`);
    await socket.receive(encodeHid(HID.TOUCH, { type: "begin", x: 0.2, y: 0.3 }));
    await socket.receive(encodeHid(HID.KEY, { type: "down", usage: 225 }));
    await handoff("agent");
    expect(socket.closeCalls).toContainEqual({ code: 1000, reason: "Control changed" });
    expect(sent).toEqual([
      { opcode: HID.TOUCH, payload: { type: "begin", x: 0.2, y: 0.3 } },
      { opcode: HID.KEY, payload: { type: "down", usage: 225 } },
      { opcode: HID.TOUCH, payload: { type: "end", x: 0.2, y: 0.3 } },
      { opcode: HID.KEY, payload: { type: "up", usage: 225 } },
    ]);
    await handoff("human");
    await expect(socket.receive(encodeHid(HID.KEY, { type: "down", usage: 4 }))).rejects.toThrow("not open");
    expect(sent).toHaveLength(4);
    const replacement = await harness.behavior.experimental_openWebSocket(`/hid?udid=${UDID}&threadId=${OWNER.threadId}`);
    await replacement.receive(encodeHid(HID.KEY, { type: "down", usage: 5 }));
    expect(sent.at(-1)).toEqual({ opcode: HID.KEY, payload: { type: "down", usage: 5 } });
    await replacement.close();
    await socket.close();
  });

  it("invalidates a pending HID handshake across human-agent-human handoff and closes its late upstream connection", async () => {
    const { harness, attachHuman, handoff, streams, connections, sent } = await load();
    await attachHuman();
    const started = deferred(), resume = deferred();
    const open = streams.openHid.getMockImplementation()!;
    streams.openHid.mockImplementationOnce(async () => {
      started.resolve();
      await resume.promise;
      return open();
    });
    const opening = harness.behavior.experimental_openWebSocket(`/hid?udid=${UDID}&threadId=${OWNER.threadId}`);
    await started.promise;
    try {
      await handoff("agent");
      await handoff("human");
    } finally { resume.resolve(); }
    const stale = await opening;
    expect(stale.closeCalls).toContainEqual({ code: 1000, reason: "Control changed" });
    expect(connections.at(-1)!.close).toHaveBeenCalledOnce();
    await expect(stale.receive(encodeHid(HID.BUTTON, { button: "home" }))).rejects.toThrow("not open");
    expect(sent).toEqual([]);

    const fresh = await harness.behavior.experimental_openWebSocket(`/hid?udid=${UDID}&threadId=${OWNER.threadId}`);
    await fresh.receive(encodeHid(HID.BUTTON, { button: "home" }));
    expect(sent).toEqual([{ opcode: HID.BUTTON, payload: { button: "home" } }]);
    await fresh.close();
    await stale.close();
  });

  it("requires an attached controlling thread for HID input and a thread id for panel RPC input", async () => {
    const { harness, attachHuman, sent } = await load();
    await attachHuman();
    await harness.behavior.callAgentTool("ios_sim_attach", { device: UDID }, OBSERVER);
    for (const [suffix, reason] of [["", "Attach this simulator"], [`&threadId=${OBSERVER.threadId}`, "controlled by thread thread-owner"]] as const) {
      const socket = await harness.behavior.experimental_openWebSocket(`/hid?udid=${UDID}${suffix}`);
      await socket.receive(encodeHid(HID.BUTTON, { button: "home" }));
      expect(socket.closeCalls).toEqual([{ code: 1011, reason: expect.stringContaining(reason) }]);
      await socket.close();
    }
    await expect(harness.behavior.callRpc("button", { udid: UDID, button: "home" })).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it("prevents an owning agent from detaching human control while allowing an observer to detach", async () => {
    const { harness, attachHuman, state, streams } = await load();
    await attachHuman();
    await harness.behavior.callAgentTool("ios_sim_attach", { device: UDID }, OBSERVER);
    const refused = await harness.behavior.callAgentTool("ios_sim_detach", {}, OWNER);
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain("Let agent drive");
    expect((await state()).attached).toEqual([UDID]);
    expect((await state()).controls[UDID]).toMatchObject({ threadId: OWNER.threadId, mode: "human" });
    expect(await harness.behavior.callAgentTool("ios_sim_detach", {}, OBSERVER)).toContain("Detached Session phone");
    expect((await state(OBSERVER.threadId)).attached).toEqual([]);
    expect((await state()).controls[UDID]).toMatchObject({ threadId: OWNER.threadId, mode: "human" });
    expect(streams.stop).not.toHaveBeenCalled();
  });

  it("does not recreate an attachment or control claim when the thread is archived during stream startup", async () => {
    const { harness, attachAgent, state, streams } = await load();
    const started = deferred(), resume = deferred();
    const ensure = streams.ensure.getMockImplementation()!;
    streams.ensure.mockImplementationOnce(async (udid, signal) => {
      started.resolve();
      await resume.promise;
      return ensure(udid, signal);
    });
    const attaching = attachAgent();
    await started.promise;
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: OWNER.threadId }) });
    resume.resolve();
    const result = await attaching;
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("thread closed while its simulator was attaching");
    expect(await state()).toMatchObject({ attached: [], controls: {}, sessions: [] });
    expect(streams.stop).toHaveBeenCalledWith(UDID);
    expect(await attachAgent()).toMatchObject({ isError: true });
    expect(streams.ensure).toHaveBeenCalledOnce();
  });

  it("restores the stream for its attached human owner when handoff aborts an input repair", async () => {
    const { harness, attachAgent, handoff, setInputShadowed, state, streams, calls } = await load();
    await attachAgent();
    setInputShadowed(true);
    const repairing = harness.behavior.callAgentTool("ios_sim_repair_input", {}, OWNER);
    await vi.waitFor(() => expect(streams.stop).toHaveBeenCalledWith(UDID));
    const startsBeforeHandoff = streams.ensure.mock.calls.length;
    await handoff("human");
    expect(await repairing).toMatchObject({ isError: true });
    expect(streams.ensure).toHaveBeenCalledTimes(startsBeforeHandoff + 1);
    expect(await state()).toMatchObject({
      attached: [UDID], controls: { [UDID]: { threadId: OWNER.threadId, mode: "human" } },
      sessions: [{ udid: UDID }],
    });
    expect(calls.some(({ args }) => args.includes("kickstart"))).toBe(true);
  });

  it("does not restore an orphan stream when archiving the thread aborts an input repair", async () => {
    const { harness, attachAgent, setInputShadowed, state, streams } = await load();
    await attachAgent();
    setInputShadowed(true);
    const repairing = harness.behavior.callAgentTool("ios_sim_repair_input", {}, OWNER);
    await vi.waitFor(() => expect(streams.stop).toHaveBeenCalledWith(UDID));
    const startsBeforeArchive = streams.ensure.mock.calls.length;
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: OWNER.threadId }) });
    expect(await repairing).toMatchObject({ isError: true });
    await vi.waitFor(async () => expect(await state()).toMatchObject({ attached: [], controls: {}, sessions: [] }));
    expect(streams.ensure).toHaveBeenCalledTimes(startsBeforeArchive);
  });

  it.each([["repair-input", UDID], ["detach", UDID, "--shutdown"]])("denies the CLI %s action when agent control is globally off", async (...args) => {
    const { harness, setInputShadowed, calls, streams } = await load("never");
    expect((await harness.behavior.runCli(["attach", UDID], { threadId: OWNER.threadId })).exitCode).toBe(0);
    setInputShadowed(true);
    const result = await harness.behavior.runCli(args, { threadId: OWNER.threadId });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("turned off");
    expect(calls.some(({ args }) => args.includes("kickstart") || args[1] === "shutdown" || (args.includes("notifyutil") && args.includes("-s")))).toBe(false);
    expect(streams.stop).not.toHaveBeenCalled();
  });

  it("cancels a pending CLI shutdown approval on human handoff without releasing human control or detaching", async () => {
    const { harness, handoff, state, streams, calls } = await load("ask");
    expect((await harness.behavior.runCli(["attach", UDID], { threadId: OWNER.threadId })).exitCode).toBe(0);
    const detaching = harness.behavior.runCli(["detach", UDID, "--shutdown"], { threadId: OWNER.threadId });
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    await handoff("human");
    const result = await detaching;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Control of simulator");
    expect(harness.pendingInteractions).toHaveLength(0);
    expect(await state()).toMatchObject({ attached: [UDID], controls: { [UDID]: { threadId: OWNER.threadId, mode: "human" } } });
    expect(streams.stop).not.toHaveBeenCalled();
    expect(calls.some(({ args }) => args[1] === "shutdown")).toBe(false);
  });

  it("cleans up a detached lease and orphan stream when CLI shutdown is cancelled during attachment persistence", async () => {
    const { bb, harness, attachAgent, state, streams, calls } = await load();
    await attachAgent();
    const persisting = deferred(), resume = deferred();
    const write = bb.storage.kv.set.bind(bb.storage.kv);
    const writeSpy = vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === "attachments") {
        persisting.resolve();
        await resume.promise;
      }
      await write(key, value);
    });
    const controller = new AbortController();
    try {
      const detaching = harness.behavior.runCli(["detach", UDID, "--shutdown"], { threadId: OWNER.threadId, signal: controller.signal });
      await persisting.promise;
      controller.abort(new Error("CLI request cancelled"));
      resume.resolve();
      expect((await detaching).exitCode).toBe(1);
      expect(await state()).toMatchObject({ attached: [], controls: {}, sessions: [] });
      expect(streams.stop).toHaveBeenCalledWith(UDID);
      expect(calls.some(({ args }) => args[1] === "shutdown")).toBe(false);
    } finally {
      resume.resolve();
      writeSpy.mockRestore();
    }
    // State only lists live streams, so attach a new owner to prove the old
    // lease was released rather than merely hidden with the stopped stream.
    await harness.behavior.callAgentTool("ios_sim_attach", { device: UDID }, OBSERVER);
    expect((await state(OBSERVER.threadId)).controls[UDID]).toMatchObject({ threadId: OBSERVER.threadId, mode: "agent" });
  });

  it("denies agent tool shutdown when agent control is globally off without detaching its owner", async () => {
    const { harness, attachAgent, state, streams, calls } = await load("never");
    await attachAgent();
    const result = await harness.behavior.callAgentTool("ios_sim_detach", { shutdown: true }, OWNER);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("turned off");
    expect(await state()).toMatchObject({ attached: [UDID], controls: { [UDID]: { threadId: OWNER.threadId, mode: "agent" } } });
    expect(streams.stop).not.toHaveBeenCalled();
    expect(calls.some(({ args }) => args[1] === "shutdown")).toBe(false);
  });

  it("cancels pending consent without recording a decline, then grants consent when the user explicitly returns agent control", async () => {
    const { harness, attachAgent, handoff, state, sent } = await load("ask");
    await attachAgent();
    const first = harness.behavior.callAgentTool("ios_sim_press_button", { button: "home" }, OWNER);
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    await handoff("human");
    expect(await first).toMatchObject({ isError: true });
    expect((await state()).consent[UDID]).toBeUndefined();
    expect(harness.pendingInteractions).toHaveLength(0);
    expect(sent).toEqual([]);

    await handoff("agent");
    expect((await state()).consent[UDID]).toBe(true);
    expect(await harness.behavior.callAgentTool("ios_sim_press_button", { button: "home" }, OWNER)).toContain("Pressed home");
    expect(harness.pendingInteractions).toHaveLength(0);
    expect(sent).toEqual([{ opcode: HID.BUTTON, payload: { button: "home" } }]);
  });

  it("asks again after the user cancels a consent form without transferring control", async () => {
    const { harness, attachAgent, state, sent } = await load("ask");
    await attachAgent();
    const first = harness.behavior.callAgentTool("ios_sim_press_button", { button: "home" }, OWNER);
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    harness.behavior.cancelInteraction(harness.pendingInteractions[0]!.id);
    expect(await first).toMatchObject({ isError: true });
    expect((await state()).consent[UDID]).toBeUndefined();
    expect(harness.pendingInteractions).toHaveLength(0);
    expect(sent).toEqual([]);

    const retry = harness.behavior.callAgentTool("ios_sim_press_button", { button: "home" }, OWNER);
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { allow: true });
    expect(await retry).toContain("Pressed home");
    expect((await state()).consent[UDID]).toBe(true);
    expect(sent).toEqual([{ opcode: HID.BUTTON, payload: { button: "home" } }]);
  });

  it("preserves parallel consent grants on two devices and makes agents wait for the grants when control is published", async () => {
    const devices = [UDID, "SESSION-SECOND-PHONE"];
    const { bb, harness, state, sent } = await load("ask", devices);
    for (const device of devices) {
      await harness.behavior.callRpc("attach", { threadId: OWNER.threadId, device });
    }
    const writing = deferred(), allowWrites = deferred();
    const write = bb.storage.kv.set.bind(bb.storage.kv);
    const writeSpy = vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === "consent") {
        writing.resolve();
        await allowWrites.promise;
      }
      await write(key, value);
    });
    const immediateInputs: Array<ReturnType<typeof harness.behavior.callAgentTool>> = [];
    const publish = bb.realtime.publish.bind(bb.realtime);
    const publishSpy = vi.spyOn(bb.realtime, "publish").mockImplementation((channel, payload) => {
      publish(channel, payload);
      if (channel === "control-changed") {
        const change = payload as { udid: string; control: { mode: string } | null };
        if (change.control?.mode === "agent") {
          immediateInputs.push(harness.behavior.callAgentTool("ios_sim_press_button", { device: change.udid, button: "home" }, OWNER));
        }
      }
    });
    try {
      const handoffs = devices.map((udid) => harness.behavior.callRpc("control", { threadId: OWNER.threadId, udid, mode: "agent" }));
      await writing.promise;
      // The consent write is deliberately pending while both publication-triggered
      // tools run through the host's asynchronous attachment and consent reads.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(immediateInputs).toHaveLength(2);
      expect(harness.pendingInteractions).toHaveLength(0);
      expect(sent).toEqual([]);

      allowWrites.resolve();
      await Promise.all(handoffs);
      const results = await Promise.all(immediateInputs);
      expect(results).toEqual(["Pressed home.", "Pressed home."]);
      expect((await state()).consent).toMatchObject(Object.fromEntries(devices.map((udid) => [udid, true])));
      expect(harness.pendingInteractions).toHaveLength(0);
      expect(sent).toEqual([
        { opcode: HID.BUTTON, payload: { button: "home" } },
        { opcode: HID.BUTTON, payload: { button: "home" } },
      ]);
    } finally {
      allowWrites.resolve();
      writeSpy.mockRestore();
      publishSpy.mockRestore();
    }
  });

  it("rejects an explicit agent handoff when the global agent-control setting is never", async () => {
    const { attachHuman, handoff, state, harness, sent } = await load("never");
    await attachHuman();
    const before = (await state()).controls[UDID];
    await expect(handoff("agent")).rejects.toThrow(/turned off|never/i);
    expect((await state()).controls[UDID]).toEqual(before);
    expect((await state()).consent[UDID]).toBeUndefined();
    expect(harness.pendingInteractions).toHaveLength(0);
    expect(sent).toEqual([]);
  });
});
