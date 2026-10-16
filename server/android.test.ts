import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { AndroidService, registerAndroid } from "./android";
import type { AndroidExec, AndroidTools } from "./android-adb";

function androidPng() {
  const bytes = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(100, 16); bytes.writeUInt32BE(200, 20);
  return bytes;
}

const CTX = { threadId: "thr_1", projectId: "proj_1" };
function fakeSdk() {
  const calls: string[][] = [];
  const running = new Map([["emulator-5554", "Pixel"]]);
  const processes: Array<{ child: ChildProcess; kill: ReturnType<typeof vi.fn> }> = [];
  const exec: AndroidExec = async (file, args, options) => {
    options?.signal?.throwIfAborted(); calls.push([file, ...args]);
    let output = "";
    if (args[0] === "devices") output = `List of devices attached\nPHYSICAL device usb:1\n${[...running.keys()].map((serial) => `${serial} device`).join("\n")}\n`;
    if (args[0] === "-list-avds") output = "Pixel\nTablet\n";
    if (args.includes("avd")) output = `${running.get(args[1]!)}\nOK\n`;
    if (args.includes("sys.boot_completed")) output = "1\n";
    if (args.includes("kill")) running.delete(args[1]!);
    return { stdout: args.includes("screencap") ? androidPng() : Buffer.from(output), stderr: "", code: 0 };
  };
  const spawn = vi.fn((_file: string, args: string[]) => {
    const serial = `emulator-${args[3]}`;
    running.set(serial, args[1]!);
    const child = new EventEmitter() as ChildProcess;
    const kill = vi.fn(() => { running.delete(serial); child.emit("exit", 0, "SIGTERM"); return true; });
    child.kill = kill; processes.push({ child, kill }); return child;
  });
  const tools = (): AndroidTools => ({ adb: "/sdk/adb", emulator: "/sdk/emulator" });
  return { exec, spawn, tools, running, processes, calls };
}
async function load(agentControl: "ask" | "always" | "never" = "always") {
  const sdk = fakeSdk();
  const { bb, harness } = createFakePluginHost({ pluginId: "android-test" });
  const service = registerAndroid(bb, { ...sdk, agentControl: () => agentControl });
  return { ...sdk, service, bb, harness };
}

describe("Android plugin integration", () => {
  it("registers Android tools and reports missing SDK without trying to install one", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "android-test" });
    const exec = vi.fn<AndroidExec>();
    registerAndroid(bb, { exec, tools: () => ({ adb: null, emulator: null }) });
    expect(harness.registrations.agentTools.map((tool) => tool.name)).toEqual([
      "android_sim_list_devices", "android_sim_attach", "android_sim_screenshot", "android_sim_tap", "android_sim_swipe", "android_sim_type", "android_sim_press_button", "android_sim_install_and_launch", "android_sim_launch", "android_sim_detach",
    ]);
    expect(await harness.behavior.callRpc("androidState", { threadId: "thr_1" })).toMatchObject({ ready: { ok: false }, devices: [], attached: [] });
    expect(exec).not.toHaveBeenCalled(); await harness.lifecycle.dispose();
  });
  it("lists only emulators, attaches the running device, captures PNG, and enforces RPC ownership", async () => {
    const { harness } = await load();
    const devices = await harness.behavior.callAgentTool("android_sim_list_devices", {}, CTX);
    expect(devices).toContain("Pixel"); expect(devices).not.toContain("PHYSICAL");
    await harness.behavior.callAgentTool("android_sim_attach", {}, CTX);
    expect(await harness.behavior.callRpc("androidState", { threadId: "thr_1" })).toMatchObject({ attached: ["emulator-5554"] });
    const screenshot = await harness.behavior.callAgentTool("android_sim_screenshot", {}, CTX);
    expect(screenshot).toMatchObject({ content: [{ type: "text" }, { type: "image", mimeType: "image/png" }] });
    await expect(harness.behavior.callRpc("androidButton", { threadId: "thr_2", serial: "emulator-5554", button: "home" })).rejects.toThrow("not attached");
    const response = await harness.behavior.fetchHttp("GET", "/android/screenshot?threadId=thr_2&serial=emulator-5554");
    expect(response.status).toBe(400);
    await harness.lifecycle.dispose();
  });
  it("refuses agent control before starting an emulator when the setting is never", async () => {
    const { harness, spawn, calls } = await load("never");
    const result = await harness.behavior.callAgentTool("android_sim_attach", { device: "Tablet" }, CTX);
    expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).toContain("turned off");
    expect(spawn).not.toHaveBeenCalled(); expect(calls.some((call) => call.includes("screencap"))).toBe(false);
    // Manual panel controls still work under this setting.
    await harness.behavior.callRpc("androidAttach", { threadId: "thr_1", device: "Pixel" });
    await harness.behavior.callRpc("androidButton", { threadId: "thr_1", serial: "emulator-5554", button: "home" });
    await harness.lifecycle.dispose();
  });
  it("starts a saved AVD on a free port and shuts down only owned devices on thread archive", async () => {
    const { harness, calls, spawn, processes } = await load();
    await harness.behavior.callAgentTool("android_sim_attach", { device: "Tablet" }, CTX);
    expect(spawn).toHaveBeenCalledWith("/sdk/emulator", ["-avd", "Tablet", "-port", "5556", "-no-window", "-no-audio", "-no-snapshot-save"]);
    expect(await harness.behavior.callRpc("androidState", { threadId: "thr_1" })).toMatchObject({ attached: ["emulator-5556"], bootedByPlugin: ["emulator-5556"] });
    await harness.behavior.callAgentTool("android_sim_attach", { device: "Pixel" }, CTX);
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_1" }) });
    await vi.waitFor(() => expect(processes[0]!.kill).toHaveBeenCalled());
    expect(calls).toContainEqual(["/sdk/adb", "-s", "emulator-5556", "emu", "kill"]);
    expect(calls).not.toContainEqual(["/sdk/adb", "-s", "emulator-5554", "emu", "kill"]);
    await harness.lifecycle.dispose();
  });
  it("refuses a different AVD racing onto the selected console port", async () => {
    const sdk = fakeSdk();
    const { bb, harness } = createFakePluginHost({ pluginId: "android-test" });
    registerAndroid(bb, { ...sdk, agentControl: () => "always", spawn: (file, args) => {
      const child = sdk.spawn(file, args);
      sdk.running.set(`emulator-${args[3]}`, "Unexpected_AVD");
      return child;
    } });
    const result = await harness.behavior.callAgentTool("android_sim_attach", { device: "Tablet" }, CTX);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("belongs to Unexpected_AVD, not Tablet");
    expect(await harness.behavior.callRpc("androidState", { threadId: "thr_1" })).toMatchObject({ attached: [], bootedByPlugin: [] });
    expect(sdk.processes[0]?.kill).toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });
  it("does not shut down an emulator while another thread is attached", async () => {
    const { harness, service, processes } = await load();
    await harness.behavior.callAgentTool("android_sim_attach", { device: "Tablet" }, CTX);
    await harness.behavior.callRpc("androidAttach", { threadId: "thr_2", device: "emulator-5556" });
    await expect(harness.behavior.callRpc("androidDetach", { threadId: "thr_1", serial: "emulator-5556", shutdown: true })).rejects.toThrow("Another thread");
    await service.releaseThread("thr_1");
    expect(processes[0]!.kill).not.toHaveBeenCalled();
    await service.releaseThread("thr_2");
    expect(processes[0]!.kill).toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });
  it("keeps agent consent scoped to this thread and stops owned processes on disposal", async () => {
    const { harness, processes } = await load("ask");
    await harness.behavior.callRpc("androidAttach", { threadId: "thr_1", device: "Tablet" });
    await harness.behavior.callRpc("androidSetConsent", { threadId: "thr_1", serial: "emulator-5556", allow: true });
    await harness.behavior.callAgentTool("android_sim_press_button", { button: "home" }, CTX);
    await harness.behavior.callRpc("androidAttach", { threadId: "thr_2", device: "emulator-5556" });
    expect(await harness.behavior.callRpc("androidState", { threadId: "thr_2" })).toMatchObject({ consent: {} });
    await harness.behavior.callRpc("androidSetConsent", { threadId: "thr_1", serial: "emulator-5556", allow: false });
    expect(await harness.behavior.callAgentTool("android_sim_press_button", { button: "home" }, CTX)).toMatchObject({ isError: true });
    await harness.lifecycle.dispose(); expect(processes[0]!.kill).toHaveBeenCalled();
  });
});

describe("Android screenshot lifecycle", () => {
  it("coalesces concurrent screenshots into one adb process and aborts it on dispose", async () => {
    const sdk = fakeSdk();
    let finish!: (bytes: { stdout: Buffer; stderr: string; code: number }) => void;
    let captureSignal: AbortSignal | undefined;
    const capture = vi.fn<AndroidExec>(async (_file, _args, options) => {
      captureSignal = options?.signal;
      return new Promise((resolve, reject) => {
        finish = resolve;
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    });
    const exec: AndroidExec = (file, args, options) => args.includes("screencap") ? capture(file, args, options) : sdk.exec(file, args, options);
    const service = new AndroidService({ ...sdk, exec, publish: () => {} });
    await service.attach("thr_1", { id: "emulator-5554", name: "Pixel", serial: "emulator-5554", state: "Booted" });
    const a = service.screenshot("thr_1", "emulator-5554"), b = service.screenshot("thr_1", "emulator-5554");
    expect(capture).toHaveBeenCalledTimes(1);
    finish({ stdout: androidPng(), stderr: "", code: 0 });
    expect(await a).toEqual(await b);
    const pending = service.screenshot("thr_1", "emulator-5554").catch((error) => error);
    await service.dispose(); expect(captureSignal?.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(DOMException);
  });
});
