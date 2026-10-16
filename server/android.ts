import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ChildProcess } from "node:child_process";
import {
  ANDROID_BUTTONS, AndroidAdb, createAndroidExec, pngDimensions, resolveAndroidTools,
  spawnAndroidEmulator, type AndroidDevice, type AndroidExec, type AndroidSpawn, type AndroidTools,
} from "./android-adb";

const coordinate = z.number().min(0).max(1);
const thread = z.string().min(1).max(200);
const serial = z.string().regex(/^emulator-\d{4,5}$/);
const device = z.string().min(1).max(200).nullable();
const session = { threadId: thread, serial };
const ok = z.object({ ok: z.literal(true) });
const button = z.enum(ANDROID_BUTTONS);
const swipe = { fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate,
  durationMs: z.number().int().min(50).max(5000).default(300) };

export const androidRpcContract = defineRpcContract({
  androidState: {
    input: z.object({ threadId: thread.nullable() }).strict(),
    output: z.object({
      ready: z.object({ ok: z.boolean(), problems: z.array(z.string()), adb: z.string().nullable(), emulator: z.string().nullable() }),
      devices: z.array(z.object({ id: z.string(), name: z.string(), serial: z.string().nullable(), state: z.enum(["Booted", "Shutdown", "Offline"]) })),
      attached: z.array(z.string()), bootedByPlugin: z.array(z.string()),
      consent: z.record(z.string(), z.boolean()), agentControl: z.enum(["ask", "always", "never"]),
      error: z.string().nullable(),
    }),
  },
  androidAttach: { input: z.object({ threadId: thread, device }).strict(), output: z.object({ serial, name: z.string() }) },
  androidDetach: { input: z.object({ ...session, shutdown: z.boolean() }).strict(), output: ok },
  androidTap: { input: z.object({ ...session, x: coordinate, y: coordinate, holdMs: z.number().int().min(0).max(5000).default(0) }).strict(), output: ok },
  androidSwipe: { input: z.object({ ...session, ...swipe }).strict(), output: ok },
  androidText: { input: z.object({ ...session, text: z.string().min(1).max(2000) }).strict(), output: ok },
  androidButton: { input: z.object({ ...session, button }).strict(), output: ok },
  androidSetConsent: { input: z.object({ ...session, allow: z.boolean() }).strict(), output: ok },
  androidInstallAndLaunch: { input: z.object({ ...session, apkPath: z.string().min(1).max(4096), packageName: z.string().min(1).max(200) }).strict(), output: ok },
});
export type AndroidState = z.infer<typeof androidRpcContract.androidState.output>;
type AgentControl = "ask" | "always" | "never";
interface RunningEmulator { child: ChildProcess; failed: Error | null }

/** State lives for this plugin load. Existing emulators are never owned implicitly. */
export class AndroidService {
  private attached = new Map<string, Set<string>>();
  private devicesBySerial = new Map<string, AndroidDevice>();
  private processes = new Map<string, RunningEmulator>();
  private starting = new Map<string, Promise<AndroidDevice>>();
  private grants = new Map<string, Map<string, boolean>>();
  private screenshots = new Map<string, Promise<Buffer>>();
  private shutdown = new AbortController();
  private disposed = false;
  readonly adb: AndroidAdb;
  constructor(private options: {
    exec: AndroidExec; tools: () => AndroidTools; spawn: AndroidSpawn;
    publish: (channel: string, payload: Record<string, unknown>) => void;
  }) {
    this.adb = new AndroidAdb({ ...options, exec: (file, args, execOptions = {}) =>
      options.exec(file, args, { ...execOptions, signal: this.signal(execOptions.signal) }) });
  }

  owned(): string[] { return [...this.processes.keys()]; }
  attachedTo(threadId: string): string[] { return [...(this.attached.get(threadId) ?? [])]; }
  private signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
  }
  private publish(channel = "android-changed", payload: Record<string, unknown> = {}) {
    if (!this.disposed) this.options.publish(channel, payload);
  }
  async devices(signal?: AbortSignal) {
    return this.adb.devices(this.signal(signal));
  }
  async resolve(threadId: string, query: string | null | undefined, allowDefault = false, signal?: AbortSignal): Promise<AndroidDevice> {
    const devices = await this.devices(signal);
    if (query) {
      const matches = devices.filter((d) => d.id === query || d.serial === query || d.name.toLowerCase() === query.toLowerCase());
      if (matches.length !== 1) throw new Error(matches.length ? `More than one emulator matches ${query}; use its serial.` : `No Android emulator matches ${query}. Use android_sim_list_devices.`);
      return matches[0]!;
    }
    const attached = devices.filter((d) => d.serial !== null && this.attachedTo(threadId).includes(d.serial));
    if (attached.length === 1) return attached[0]!;
    if (attached.length > 1) throw new Error("Several Android emulators are attached to this thread; specify a device.");
    if (!allowDefault) throw new Error("No Android emulator is attached to this thread. Call android_sim_attach first.");
    const selected = devices.find((d) => d.state === "Booted") ?? devices.find((d) => d.state === "Shutdown");
    if (!selected) throw new Error("No usable Android emulators were found. Create an Android Virtual Device in Android Studio's Device Manager.");
    return selected;
  }

  async attach(threadId: string, selected: AndroidDevice, signal?: AbortSignal): Promise<AndroidDevice & { serial: string }> {
    let device = selected;
    if (device.state === "Offline") throw new Error(`${device.name} is offline. Start it in Android Studio, then attach again.`);
    if (!device.serial) {
      let start = this.starting.get(device.name);
      if (!start) {
        start = this.boot(device, this.signal(signal));
        this.starting.set(device.name, start);
        void start.finally(() => this.starting.delete(device.name)).catch(() => undefined);
      }
      device = await start;
    }
    this.signal(signal).throwIfAborted();
    const serial = device.serial!;
    const owned = this.attached.get(threadId) ?? new Set<string>();
    owned.add(serial);
    this.attached.set(threadId, owned);
    this.devicesBySerial.set(serial, device);
    this.publish("android-attached", { threadId, serial });
    this.publish();
    return { ...device, serial };
  }

  private async boot(device: AndroidDevice, signal: AbortSignal): Promise<AndroidDevice> {
    const executable = this.options.tools().emulator;
    if (!executable) throw new Error("The Android emulator executable was not found. Install Android Emulator in Android Studio's SDK Manager.");
    const used = new Set((await this.devices(signal)).flatMap((d) => d.serial ? [Number(d.serial.split("-")[1])] : []));
    for (const key of this.processes.keys()) used.add(Number(key.split("-")[1]));
    let port = 5554;
    while (used.has(port) && port <= 5682) port += 2;
    if (port > 5682) throw new Error("No free Android emulator console port is available.");
    const serial = `emulator-${port}`;
    const child = this.options.spawn(executable, ["-avd", device.name, "-port", String(port), "-no-window", "-no-audio", "-no-snapshot-save"]);
    const process: RunningEmulator = { child, failed: null };
    const processEnded = new AbortController();
    this.processes.set(serial, process);
    child.once("error", (error) => { process.failed = error; processEnded.abort(error); });
    child.once("exit", (code, reason) => {
      process.failed = new Error(`Android emulator exited (${reason ?? code ?? "unknown"}).`);
      processEnded.abort(process.failed);
      this.processes.delete(serial);
      for (const devices of this.attached.values()) devices.delete(serial);
      this.publish();
    });
    const bootSignal = AbortSignal.any([signal, processEnded.signal, AbortSignal.timeout(120_000)]);
    try {
      // `wait-for-device` alone completes before Android's package manager and UI.
      await this.adb.device(serial, ["wait-for-device"], { signal: bootSignal, timeoutMs: 120_000 });
      while (true) {
        if (process.failed) throw process.failed;
        const complete = await this.adb.device(serial, ["shell", "getprop", "sys.boot_completed"], { signal: bootSignal });
        if (complete.toString("utf8").trim() === "1") break;
        await pause(500, bootSignal);
      }
      const actualName = (await this.adb.device(serial, ["emu", "avd", "name"], { signal: bootSignal }))
        .toString("utf8").trim().split(/\r?\n/)[0];
      if (actualName !== device.name)
        throw new Error(`Android emulator port ${port} belongs to ${actualName || "an unknown virtual device"}, not ${device.name}. Attach the intended emulator by name after checking Device Manager.`);
      return { id: serial, serial, name: device.name, state: "Booted" };
    } catch (error) {
      const failure = process.failed ?? error;
      await stopChild(child);
      this.processes.delete(serial);
      throw failure;
    }
  }

  assertAttached(threadId: string, serial: string): AndroidDevice {
    if (this.disposed) throw new Error("The Android simulator plugin is stopping.");
    if (!this.attached.get(threadId)?.has(serial)) throw new Error("This Android emulator is not attached to this thread.");
    const device = this.devicesBySerial.get(serial);
    if (!device) throw new Error("The Android emulator session ended; attach it again.");
    return device;
  }
  consentFor(threadId: string, device: AndroidDevice): boolean | undefined { return this.grants.get(threadId)?.get(device.name); }
  consent(threadId: string): Record<string, boolean> {
    return Object.fromEntries(this.attachedTo(threadId).flatMap((serial) => {
      const device = this.devicesBySerial.get(serial);
      const grant = device && this.consentFor(threadId, device);
      return typeof grant === "boolean" ? [[serial, grant]] : [];
    }));
  }
  setConsent(threadId: string, device: AndroidDevice, allow: boolean) {
    const grants = this.grants.get(threadId) ?? new Map<string, boolean>();
    grants.set(device.name, allow); this.grants.set(threadId, grants); this.publish();
  }
  async screenshot(threadId: string, serial: string, signal?: AbortSignal): Promise<Buffer> {
    this.assertAttached(threadId, serial);
    // HTTP preview polling, downloads, and agent screenshots share one capture.
    let pending = this.screenshots.get(serial);
    if (!pending) {
      pending = this.adb.screenshot(serial, this.signal(signal));
      this.screenshots.set(serial, pending);
      void pending.finally(() => this.screenshots.delete(serial)).catch(() => undefined);
    }
    return pending;
  }
  async detach(threadId: string, serial: string, shutdown: boolean, signal?: AbortSignal) {
    this.assertAttached(threadId, serial);
    const otherOwner = [...this.attached].some(([id, devices]) => id !== threadId && devices.has(serial));
    if (shutdown && otherOwner) throw new Error("Another thread is using this emulator. Detach here without shutting it down.");
    if (shutdown) {
      const running = this.processes.get(serial);
      await this.adb.device(serial, ["emu", "kill"], { signal: this.signal(signal) });
      if (running) await stopChild(running.child);
      this.processes.delete(serial);
    }
    this.attached.get(threadId)?.delete(serial);
    this.publish();
  }
  async releaseThread(threadId: string) {
    const devices = this.attachedTo(threadId);
    this.attached.delete(threadId); this.grants.delete(threadId);
    for (const serial of devices) {
      const used = [...this.attached.values()].some((set) => set.has(serial));
      if (!used && this.processes.has(serial)) {
        const running = this.processes.get(serial)!;
        await this.adb.device(serial, ["emu", "kill"], { signal: this.signal() }).catch(() => undefined);
        await stopChild(running.child);
        this.processes.delete(serial);
      }
    }
    this.publish();
  }
  async dispose() {
    this.disposed = true; this.shutdown.abort();
    const stops = [...this.processes.values()].map((process) => stopChild(process.child));
    this.processes.clear(); this.attached.clear(); this.grants.clear();
    await Promise.allSettled([...stops, ...this.screenshots.values(), ...this.starting.values()]);
  }
}

export interface AndroidDependencies {
  exec?: AndroidExec; tools?: () => AndroidTools; spawn?: AndroidSpawn;
  agentControl?: () => AgentControl;
}
export function registerAndroid(bb: BbPluginApi, dependencies: AndroidDependencies = {}) {
  const tools = dependencies.tools ?? (() => resolveAndroidTools());
  const service = new AndroidService({ exec: dependencies.exec ?? createAndroidExec(), tools,
    spawn: dependencies.spawn ?? spawnAndroidEmulator,
    publish: (channel, payload) => bb.realtime.publish(channel, payload) });
  const mode = () => dependencies.agentControl?.() ?? "ask";
  const controlled = async <T,>(threadId: string, serial: string, work: () => Promise<T>) => {
    service.assertAttached(threadId, serial);
    return work();
  };
  bb.rpc.register(androidRpcContract, {
    async androidState({ threadId }) {
      const paths = tools(), problems: string[] = [];
      if (!paths.adb) problems.push("Android platform-tools (adb) were not found. Install them in Android Studio's SDK Manager, or set ANDROID_HOME / ANDROID_SDK_ROOT to an existing SDK.");
      if (!paths.emulator) problems.push("Android Emulator was not found. Running emulators can still attach if adb is available; install Android Emulator in SDK Manager to start saved virtual devices here.");
      let devices: AndroidDevice[] = [], error: string | null = null;
      if (paths.adb) try { devices = await service.devices(); } catch (cause) { error = describe(cause); }
      return { ready: { ok: Boolean(paths.adb), problems, ...paths }, devices,
        attached: threadId ? service.attachedTo(threadId).filter((serial) => devices.some((d) => d.serial === serial && d.state === "Booted")) : [],
        bootedByPlugin: service.owned(), consent: threadId ? service.consent(threadId) : {}, agentControl: mode(), error };
    },
    async androidAttach({ threadId, device }) {
      const selected = await service.resolve(threadId, device, true);
      const result = await service.attach(threadId, selected);
      return { serial: result.serial, name: result.name };
    },
    async androidDetach({ threadId, serial, shutdown }) { await service.detach(threadId, serial, shutdown); return { ok: true as const }; },
    async androidTap({ threadId, serial, x, y, holdMs }) { await controlled(threadId, serial, () => service.adb.tap(serial, x, y, holdMs)); return { ok: true as const }; },
    async androidSwipe({ threadId, serial, fromX, fromY, toX, toY, durationMs }) { await controlled(threadId, serial, () => service.adb.swipe(serial, fromX, fromY, toX, toY, durationMs)); return { ok: true as const }; },
    async androidText({ threadId, serial, text }) { await controlled(threadId, serial, () => service.adb.text(serial, text)); return { ok: true as const }; },
    async androidButton({ threadId, serial, button }) { await controlled(threadId, serial, () => service.adb.button(serial, button)); return { ok: true as const }; },
    async androidSetConsent({ threadId, serial, allow }) { service.setConsent(threadId, service.assertAttached(threadId, serial), allow); return { ok: true as const }; },
    async androidInstallAndLaunch({ threadId, serial, apkPath, packageName }) { await controlled(threadId, serial, () => service.adb.installAndLaunch(serial, apkPath, packageName)); return { ok: true as const }; },
  });
  bb.http.route("GET", "/android/screenshot", async (c) => {
    const threadId = c.req.query("threadId") ?? "", serial = c.req.query("serial") ?? "";
    try {
      const bytes = await service.screenshot(threadId, serial, c.req.raw.signal);
      const headers: Record<string, string> = { "content-type": "image/png", "cache-control": "no-store" };
      if (c.req.query("download") === "1") headers["content-disposition"] = `attachment; filename="android-${Date.now()}.png"`;
      return new Response(new Uint8Array(bytes) as unknown as BodyInit, { headers });
    } catch (error) { return c.json({ error: describe(error) }, 400); }
  });

  async function consent(threadId: string, device: AndroidDevice, signal: AbortSignal) {
    if (mode() === "never") throw new Error("Agent control of emulators is turned off in the simulator plugin settings. The user can still use the panel.");
    if (mode() === "always" || service.consentFor(threadId, device) === true) return;
    if (service.consentFor(threadId, device) === false) throw new Error(`The user declined agent control of ${device.name}. They can allow it in the Android panel.`);
    const answer = await bb.ui.requestInput({ threadId, rendererId: "device-consent",
      title: `Allow the agent to control ${device.name}`, payload: { name: device.name, runtime: "Android emulator" } }, { signal });
    const allow = answer.outcome === "submitted" && answer.value !== null && typeof answer.value === "object" && (answer.value as { allow?: unknown }).allow === true;
    service.setConsent(threadId, device, allow);
    if (!allow) throw new Error(`The user declined agent control of ${device.name}. They can use the Android panel themselves.`);
  }
  type ToolCtx = { threadId: string; signal: AbortSignal };
  type ToolOutput = string | { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
  const failure = (cause: unknown): ToolOutput => ({ content: [{ type: "text", text: describe(cause) }], isError: true });
  async function withDevice(ctx: ToolCtx, query: string | undefined, allowDefault: boolean, work: (device: AndroidDevice & { serial: string }) => Promise<ToolOutput>): Promise<ToolOutput> {
    try {
      const selected = await service.resolve(ctx.threadId, query, allowDefault, ctx.signal);
      await consent(ctx.threadId, selected, ctx.signal);
      const device = await service.attach(ctx.threadId, selected, ctx.signal);
      bb.realtime.publish("android-agent-activity", { serial: device.serial, active: true });
      try { return await work(device); }
      finally { bb.realtime.publish("android-agent-activity", { serial: device.serial, active: false }); }
    } catch (error) { return failure(error); }
  }
  const deviceParam = z.string().min(1).max(200).optional().describe("Android virtual-device name or emulator serial; defaults to this thread's attached emulator.");
  bb.agents.registerTool({ name: "android_sim_list_devices", description: "List installed Android virtual devices and running emulators. Physical devices are excluded.", parameters: z.object({}),
    async execute(_params, ctx) {
      try {
        const devices = await service.devices(ctx.signal);
        const attached = service.attachedTo(ctx.threadId);
        return devices.length ? devices.map((d) => `${d.serial && attached.includes(d.serial) ? "*" : "-"} ${d.name} — ${d.state} — ${d.id}`).join("\n") : "No Android virtual devices found. Create one in Android Studio's Device Manager.";
      } catch (error) { return failure(error); }
    } });
  bb.agents.registerTool({ name: "android_sim_attach", description: "Start an existing Android emulator if needed and show its screenshot preview in the simulator panel beside this thread. Requires an installed Android SDK and AVD; does not control physical devices.", parameters: z.object({ device: deviceParam }),
    execute: ({ device }, ctx) => withDevice(ctx, device, true, async (d) => `Attached ${d.name} (${d.serial}). The Android panel refreshes screenshots about once per second; tap and swipe it directly.`) });
  bb.agents.registerTool({ name: "android_sim_screenshot", description: "Capture this thread's attached Android emulator as PNG. Use after launching an app and after UI changes to verify what is shown.", parameters: z.object({ device: deviceParam }),
    execute: ({ device }, ctx) => withDevice(ctx, device, false, async (d) => {
      const bytes = await service.screenshot(ctx.threadId, d.serial, ctx.signal);
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("The Android screenshot exceeds the 4 MiB agent image limit. Reduce the emulator display resolution, then capture again.");
      const { width, height } = pngDimensions(bytes);
      return { content: [{ type: "text", text: `${d.name} — ${width}×${height}` }, { type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] };
    }) });
  bb.agents.registerTool({ name: "android_sim_tap", description: "Tap normalized x/y coordinates (0–1) on the attached Android emulator. Optional holdMs performs a long press.", parameters: z.object({ device: deviceParam, x: coordinate, y: coordinate, holdMs: z.number().int().min(0).max(5000).optional() }),
    execute: ({ device, x, y, holdMs }, ctx) => withDevice(ctx, device, false, async (d) => { await service.adb.tap(d.serial, x, y, holdMs, ctx.signal); return `Tapped ${d.name} at ${x}, ${y}.`; }) });
  bb.agents.registerTool({ name: "android_sim_swipe", description: "Swipe between normalized coordinates on the attached Android emulator. Duration is 50–5000 ms.", parameters: z.object({ device: deviceParam, ...swipe }),
    execute: ({ device, fromX, fromY, toX, toY, durationMs }, ctx) => withDevice(ctx, device, false, async (d) => { await service.adb.swipe(d.serial, fromX, fromY, toX, toY, durationMs, ctx.signal); return `Swiped on ${d.name}.`; }) });
  bb.agents.registerTool({ name: "android_sim_type", description: "Type into the focused Android field: printable ASCII and newline only, at most 2000 characters. Percent signs and Unicode are not supported by adb input.", parameters: z.object({ device: deviceParam, text: z.string().min(1).max(2000) }),
    execute: ({ device, text }, ctx) => withDevice(ctx, device, false, async (d) => { await service.adb.text(d.serial, text, ctx.signal); return `Typed ${text.length} characters on ${d.name}.`; }) });
  bb.agents.registerTool({ name: "android_sim_press_button", description: "Press an Android emulator hardware/navigation button: home, back, overview, power, volume, enter or backspace.", parameters: z.object({ device: deviceParam, button }),
    execute: ({ device, button }, ctx) => withDevice(ctx, device, false, async (d) => { await service.adb.button(d.serial, button, ctx.signal); return `Pressed ${button} on ${d.name}.`; }) });
  bb.agents.registerTool({ name: "android_sim_install_and_launch", description: "Install an APK from an absolute path on the BB server host and launch its Android package. Attach an emulator first. packageName is required (for example com.example.app).", parameters: z.object({ device: deviceParam, apkPath: z.string().min(1).max(4096), packageName: z.string().min(1).max(200) }),
    execute: ({ device, apkPath, packageName }, ctx) => withDevice(ctx, device, false, async (d) => { await service.adb.installAndLaunch(d.serial, apkPath, packageName, ctx.signal); return `Installed and launched ${packageName} on ${d.name}.`; }) });
  bb.agents.registerTool({ name: "android_sim_launch", description: "Launch an installed Android package on the attached emulator.", parameters: z.object({ device: deviceParam, packageName: z.string().min(1).max(200) }),
    execute: ({ device, packageName }, ctx) => withDevice(ctx, device, false, async (d) => { await service.adb.launch(d.serial, packageName, ctx.signal); return `Launched ${packageName} on ${d.name}.`; }) });
  bb.agents.registerTool({ name: "android_sim_detach", description: "Detach this thread's Android emulator. Optional shutdown also stops it, provided no other thread is attached. Leave it attached unless the user asks otherwise.", parameters: z.object({ device: deviceParam, shutdown: z.boolean().optional() }),
    async execute({ device, shutdown }, ctx) {
      try {
        const selected = await service.resolve(ctx.threadId, device, false, ctx.signal);
        if (!selected.serial) throw new Error("That emulator is not running.");
        if (shutdown) await consent(ctx.threadId, selected, ctx.signal);
        await service.detach(ctx.threadId, selected.serial, shutdown ?? false, ctx.signal);
        return `${shutdown ? "Shut down" : "Detached"} ${selected.name}.`;
      } catch (error) { return failure(error); }
    } });
  const release = (threadId: string) => { void service.releaseThread(threadId).catch((error) => bb.log.warn(`Android emulator cleanup failed: ${describe(error)}`)); };
  bb.events.on("thread.archived", ({ thread }) => release(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => release(thread.id));
  bb.onDispose(() => service.dispose());
  return service;
}

function describe(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 3000); }
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); child.off("exit", done); resolve(); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 1000);
    child.once("exit", done);
    if (!child.kill("SIGTERM")) done();
  });
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
