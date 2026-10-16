import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "./server";
import type { Exec, ExecResult } from "./server/simctl";
import { DEVICE_LIST } from "./server/simctl.test";
import type { HidConnection, StreamManager, StreamSession } from "./server/stream-manager";
import { HID, decodeHid } from "./lib/sim-protocol";

function fakeExec(overrides: (file: string, args: string[]) => Partial<ExecResult> | undefined = () => undefined) {
  const calls: string[][] = [];
  const inputs: string[] = [];
  let clipboard = "";
  const exec: Exec = async (file, args, options) => {
    calls.push([file, ...args]);
    if (options?.input !== undefined) { inputs.push(options.input); clipboard = options.input; }
    const custom = overrides(file, args);
    if (custom) return { stdout: "", stderr: "", code: 0, ...custom };
    if (args[1] === "pbpaste") return { stdout: clipboard, stderr: "", code: 0 };
    if (file === "xcode-select") return { stdout: "/Applications/Xcode.app/Contents/Developer\n", stderr: "", code: 0 };
    if (args[1] === "list") return { stdout: DEVICE_LIST, stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  return { exec, calls, inputs };
}

function fakeStreams() {
  const sessions = new Map<string, StreamSession>();
  const sent: Array<{ opcode: number; payload: unknown }> = [];
  let observeFrame: ((opcode: number, payload: unknown) => void) | undefined;
  const hid: HidConnection = {
    config: { width: 393, height: 852, orientation: "portrait" },
    send: (opcode, payload) => { sent.push({ opcode, payload }); observeFrame?.(opcode, payload); },
    sendRaw: (data) => {
      const decoded = decodeHid(data);
      if (decoded) sent.push(decoded);
    },
    onMessage: () => () => {},
    onClose: () => () => {},
    close: () => {},
  };
  const streams = {
    list: () => [...sessions.values()],
    get: (udid: string) => sessions.get(udid) ?? null,
    helperUrl: (udid: string, path: string) => `http://127.0.0.1:1/helper/${udid}${path}`,
    ensure: vi.fn(async (udid: string) => {
      const session = sessions.get(udid) ?? { udid, port: 50000, pid: 1, startedAt: 1 };
      sessions.set(udid, session);
      return session;
    }),
    stop: vi.fn(async (udid: string) => {
      sessions.delete(udid);
    }),
    stopAll: vi.fn(async () => sessions.clear()),
    screenConfig: async () => ({ width: 393, height: 852, orientation: "portrait" }),
    rawAccessibility: async () =>
      JSON.stringify([
        {
          frame: { x: 0, y: 0, width: 393, height: 852 },
          children: [
            { AXLabel: "Sign in", frame: { x: 96, y: 700, width: 200, height: 50 }, role_description: "button", children: [] },
          ],
        },
      ]),
    openHid: async () => hid,
    withHid: async <T,>(_udid: string, work: (connection: HidConnection) => Promise<T>) => work(hid),
  };
  return { streams: streams as unknown as StreamManager, sessions, sent,
    observeHid: (callback: typeof observeFrame) => { observeFrame = callback; } };
}

async function load(options: { settings?: Record<string, unknown>; execScript?: Parameters<typeof fakeExec>[0] } = {}) {
  const { exec, calls, inputs } = fakeExec(options.execScript);
  const fake = fakeStreams();
  const { bb, harness } = createFakePluginHost({
    pluginId: "ios-simulator",
    settings: { agentControl: "always", ...options.settings },
  });
  await createPlugin({ exec, streams: fake.streams })(bb);
  return { bb, harness, calls, inputs, ...fake };
}

const CTX = { threadId: "thr_1", projectId: "proj_1" };

describe("iOS Simulator plugin", () => {
  it("registers the agent tools, routes, and CLI", async () => {
    const { harness } = await load();
    const tools = harness.registrations.agentTools.map((tool) => tool.name).filter((name) => name.startsWith("ios_sim_")).sort();
    expect(tools).toEqual([
      "ios_sim_attach", "ios_sim_describe_ui", "ios_sim_detach", "ios_sim_install_and_launch",
      "ios_sim_launch", "ios_sim_list_devices", "ios_sim_open_url", "ios_sim_paste", "ios_sim_press_button",
      "ios_sim_repair_input", "ios_sim_rotate", "ios_sim_screenshot", "ios_sim_set_appearance", "ios_sim_swipe",
      "ios_sim_tap", "ios_sim_type",
    ]);
    expect(harness.registrations.httpRoutes.map((route) => route.path)).toEqual(expect.arrayContaining(["/screenshot", "/stream", "/video"]));
    expect(harness.registrations.cli?.name).toBe("ios-simulator");
  });

  it("lists devices and marks the attached one", async () => {
    const { harness } = await load();
    const before = await harness.behavior.callAgentTool("ios_sim_list_devices", {}, CTX);
    expect(before).toContain("- iPhone 17 — iOS 26.0 — Booted — AAAA-2");
    await harness.behavior.callAgentTool("ios_sim_attach", {}, CTX);
    const after = await harness.behavior.callAgentTool("ios_sim_list_devices", {}, CTX);
    expect(after).toContain("* iPhone 17 — iOS 26.0 — Booted (attached to this thread) — AAAA-2");
  });

  it("attaches the booted device by default, boots a named one, and signals the panel", async () => {
    const { harness, calls, streams } = await load();
    const result = await harness.behavior.callAgentTool("ios_sim_attach", { device: "iPhone 17 Pro" }, CTX);
    expect(result).toContain("Booted and attached iPhone 17 Pro");
    expect(calls).toContainEqual(["xcrun", "simctl", "boot", "AAAA-1"]);
    expect(calls).toContainEqual(["xcrun", "simctl", "bootstatus", "AAAA-1"]);
    expect(streams.ensure).toHaveBeenCalledWith("AAAA-1", expect.anything());
    const attached = harness.realtimeSignals.find((signal) => signal.channel === "attached");
    expect(attached?.payload).toMatchObject({ threadId: "thr_1", udid: "AAAA-1" });
    const state = await harness.behavior.callRpc("state", { threadId: "thr_1" });
    expect(state).toMatchObject({ attached: ["AAAA-1"], bootedByPlugin: ["AAAA-1"], agentControl: "always" });
  });

  it("promotes explicit attachments and reattachments without ordinary tools changing the default", async () => {
    const { harness, calls } = await load({
      execScript: (_file, args) => args[1] === "list"
        ? { stdout: DEVICE_LIST.replaceAll('"Shutdown"', '"Booted"') } : undefined,
    });
    await harness.behavior.callAgentTool("ios_sim_attach", { device: "AAAA-2" }, CTX);
    await harness.behavior.callAgentTool("ios_sim_attach", { device: "AAAA-1" }, CTX);
    expect(await harness.behavior.callRpc("state", { threadId: "thr_1" }))
      .toMatchObject({ attached: ["AAAA-1", "AAAA-2"] });
    await harness.behavior.callAgentTool("ios_sim_open_url", { url: "https://example.com" }, CTX);
    expect(calls).toContainEqual(["xcrun", "simctl", "openurl", "AAAA-1", "https://example.com"]);

    const selectionSignals = () => harness.realtimeSignals.filter((signal) => signal.channel === "attached");
    const before = selectionSignals().length;
    await harness.behavior.callAgentTool("ios_sim_open_url", { device: "AAAA-2", url: "https://example.org" }, CTX);
    expect(selectionSignals()).toHaveLength(before);
    expect(await harness.behavior.callRpc("state", { threadId: "thr_1" }))
      .toMatchObject({ attached: ["AAAA-1", "AAAA-2"] });

    await harness.behavior.callAgentTool("ios_sim_attach", { device: "AAAA-2" }, CTX);
    expect(selectionSignals()).toHaveLength(before + 1);
    expect(selectionSignals().at(-1)?.payload).toMatchObject({ threadId: "thr_1", udid: "AAAA-2" });
    expect(await harness.behavior.callRpc("state", { threadId: "thr_1" }))
      .toMatchObject({ attached: ["AAAA-2", "AAAA-1"] });
  });

  it("taps by accessibility label through the HID socket", async () => {
    const { harness, sent } = await load();
    const result = await harness.behavior.callAgentTool("ios_sim_tap", { element: "sign in" }, CTX);
    expect(result).toContain('Tapped "Sign in"');
    expect(sent.map((frame) => frame.opcode)).toEqual([HID.TOUCH, HID.TOUCH]);
    expect(sent[0]!.payload).toMatchObject({ type: "begin", x: expect.closeTo(0.4987, 3), y: expect.closeTo(0.851, 2) });
    expect(sent[1]!.payload).toMatchObject({ type: "end" });
    const activity = harness.realtimeSignals.filter((signal) => signal.channel === "agent-activity");
    expect(activity.map((signal) => (signal.payload as { active: boolean }).active)).toEqual([true, false]);
  });

  it("explains the screenshot fallback when Xcode returns an empty accessibility response", async () => {
    const { harness, streams, sent } = await load();
    vi.spyOn(streams, "rawAccessibility").mockRejectedValue(new Error("Accessibility snapshot failed (503): noFrontmostApplication"));
    const result = await harness.behavior.callAgentTool("ios_sim_tap", { element: "Sign in" }, CTX);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("ios_sim_screenshot");
    expect(sent).toEqual([]);
  });

  it("refuses to drive a device when agent control is off", async () => {
    const { harness, sent } = await load({ settings: { agentControl: "never" } });
    const result = await harness.behavior.callAgentTool("ios_sim_press_button", { button: "home" }, CTX);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/turned off/);
    expect(sent).toEqual([]);
  });

  it("installs, reads the bundle id, relaunches, and types text", async () => {
    const { harness, calls, sent } = await load({
      execScript: (file, args) => {
        if (file === "plutil") return { stdout: "com.acme.App" };
        if (args[1] === "launch") return { stdout: "com.acme.App: 77" };
        return undefined;
      },
    });
    const launch = await harness.behavior.callAgentTool(
      "ios_sim_install_and_launch",
      { appPath: "/tmp/build/Acme.app" },
      CTX,
    );
    expect(launch).toContain("Installed and launched com.acme.App on iPhone 17");
    expect(calls).toContainEqual(["xcrun", "simctl", "install", "AAAA-2", "/tmp/build/Acme.app"]);
    expect(calls).toContainEqual(["xcrun", "simctl", "terminate", "AAAA-2", "com.acme.App"]);
    expect(calls).toContainEqual(["xcrun", "simctl", "launch", "AAAA-2", "com.acme.App"]);
    await harness.behavior.callAgentTool("ios_sim_type", { text: "ok", method: "keys" }, CTX);
    expect(sent.map((frame) => frame.opcode)).toEqual([HID.KEY, HID.KEY, HID.KEY, HID.KEY]);
  });

  it("pastes Unicode through guest stdin and releases Command-V without per-character events", async () => {
    const { harness, calls, inputs, sent } = await load();
    const result = await harness.behavior.callAgentTool("ios_sim_paste", { text: "Café 東京\nline two" }, CTX);
    expect(result).toContain("Pasted");
    expect(calls.some((call) => call[0] === "xcrun" && (call[2] === "pbcopy" || (call[2] === "spawn" && call[4]?.endsWith("simulator-pasteboard"))))).toBe(true);
    expect(inputs).toEqual(["Café 東京\nline two"]);
    expect(sent.map((frame) => frame.payload)).toEqual([
      { type: "down", usage: 227 }, { type: "down", usage: 25 },
      { type: "up", usage: 25 }, { type: "up", usage: 227 },
    ]);
  });

  it("keeps Return and Tab semantics when typing with paste by default", async () => {
    const { harness, inputs, sent } = await load();
    await harness.behavior.callAgentTool("ios_sim_type", { text: "Café\t東京\n" }, CTX);
    expect(inputs).toEqual(["Café", "東京"]);
    expect(sent.filter((frame) => (frame.payload as {usage:number}).usage === 43).map((frame) => frame.payload)).toEqual([{type:"down",usage:43},{type:"up",usage:43}]);
    expect(sent.filter((frame) => (frame.payload as {usage:number}).usage === 40).map((frame) => frame.payload)).toEqual([{type:"down",usage:40},{type:"up",usage:40}]);
  });

  it("reports pasteboard failure before sending any paste shortcut", async () => {
    const { harness, sent } = await load({ execScript: (_file,args) => args[1] === "pbcopy" || args.some((arg) => arg.endsWith("simulator-pasteboard")) ? {code:1,stderr:"pasteboard unavailable"}:undefined });
    const result = await harness.behavior.callAgentTool("ios_sim_paste", {text:"hello"},CTX);
    expect(result).toMatchObject({isError:true});
    expect(JSON.stringify(result)).toContain("pasteboard unavailable");
    expect(sent).toEqual([]);
  });

  it("refuses paste when the clipboard write exits zero but retains nothing", async () => {
    const {harness,sent} = await load({execScript:(_file,args)=>args[1] === "pbpaste" ? {stdout:""}:undefined});
    const result = await harness.behavior.callAgentTool("ios_sim_paste",{text:"must persist"},CTX);
    expect(result).toMatchObject({isError:true});
    expect(JSON.stringify(result)).toContain("did not retain");
    expect(sent).toEqual([]);
  });

  it("serializes concurrent paste operations on the same device", async () => {
    const {harness,inputs,sent} = await load();
    await Promise.all([
      harness.behavior.callAgentTool("ios_sim_paste", {text:"first"}, CTX),
      harness.behavior.callAgentTool("ios_sim_paste", {text:"second"}, CTX),
    ]);
    expect(inputs).toEqual(["first", "second"]);
    expect(sent.map((frame) => frame.payload)).toEqual([
      {type:"down",usage:227},{type:"down",usage:25},{type:"up",usage:25},{type:"up",usage:227},
      {type:"down",usage:227},{type:"down",usage:25},{type:"up",usage:25},{type:"up",usage:227},
    ]);
  });

  it("stops typing on cancellation and releases a held modifier", async () => {
    const { harness, sent, observeHid } = await load();
    const controller = new AbortController();
    observeHid(() => controller.abort());
    const result = await harness.behavior.callAgentTool("ios_sim_type",
      { text: "ABC", method: "keys" }, { ...CTX, signal: controller.signal });
    expect(result).toMatchObject({ isError: true });
    expect(sent.map((frame) => frame.payload)).toEqual([
      { type: "down", usage: 225 }, { type: "up", usage: 225 },
    ]);
  });

  it("shuts down devices it booted when their thread is archived", async () => {
    const { harness, calls, streams } = await load();
    await harness.behavior.callAgentTool("ios_sim_attach", { device: "iPhone 17 Pro" }, CTX);
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_1" }) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(streams.stop).toHaveBeenCalledWith("AAAA-1");
    expect(calls).toContainEqual(["xcrun", "simctl", "shutdown", "AAAA-1"]);
    const state = await harness.behavior.callRpc("state", { threadId: "thr_1" });
    expect(state).toMatchObject({ attached: [], bootedByPlugin: [] });
  });

  it("reports Device Hub input capture, refuses to tap, and repairs on request", async () => {
    const SHADOWED = "com.apple.coredevice.dtuhidd.active 1\n";
    const { harness, calls, sent, streams } = await load({
      execScript: (_file, args) => (args.includes("notifyutil") && args.includes("-g") ? { stdout: SHADOWED } : undefined),
    });
    await harness.behavior.callAgentTool("ios_sim_attach", {}, CTX);
    const state = (await harness.behavior.callRpc("state", { threadId: "thr_1" })) as { inputShadowed: string[] };
    expect(state.inputShadowed).toEqual(["AAAA-2"]);
    const tap = await harness.behavior.callAgentTool("ios_sim_tap", { x: 0.5, y: 0.5 }, CTX);
    expect(tap).toMatchObject({ isError: true });
    expect(JSON.stringify(tap)).toMatch(/Device Hub/);
    expect(sent).toEqual([]);
    const repair = await harness.behavior.callAgentTool("ios_sim_repair_input", {}, CTX);
    expect(repair).toMatch(/Input repaired/);
    expect(calls).toContainEqual(["xcrun", "simctl", "spawn", "AAAA-2", "notifyutil", "-s", "com.apple.coredevice.dtuhidd.active", "0"]);
    expect(calls).toContainEqual(["xcrun", "simctl", "spawn", "AAAA-2", "launchctl", "kickstart", "-k", "system/com.apple.backboardd"]);
    expect(streams.stop).toHaveBeenCalledWith("AAAA-2");
    expect(streams.ensure.mock.calls.at(-1)?.[0]).toBe("AAAA-2"); // restarted after repair
  }, 15_000);

  it("restores streams for attached booted devices after a reload", async () => {
    const { exec } = fakeExec();
    const fake = fakeStreams();
    const { bb, harness } = createFakePluginHost({ pluginId: "ios-simulator", settings: { agentControl: "always" } });
    await createPlugin({ exec, streams: fake.streams })(bb);
    await harness.behavior.callAgentTool("ios_sim_attach", {}, CTX);
    expect(fake.streams.ensure).toHaveBeenCalledTimes(1);
    fake.sessions.clear(); // the old generation's processes are gone
    await harness.lifecycle.reload(createPlugin({ exec, streams: fake.streams }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.streams.ensure).toHaveBeenCalledTimes(2);
    expect(fake.streams.ensure).toHaveBeenLastCalledWith("AAAA-2");
  });

  it("stops every stream on dispose", async () => {
    const { harness, streams } = await load();
    await harness.behavior.callAgentTool("ios_sim_attach", {}, CTX);
    await harness.lifecycle.dispose();
    expect(streams.stopAll).toHaveBeenCalled();
  });
});
