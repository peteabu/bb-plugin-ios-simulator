// Everything the panel, the CLI, and the agent tools share: which simulator
// belongs to which thread, booting and shutting devices down, streaming,
// screenshots, gestures, and the consent record. The service is plain
// TypeScript over injected collaborators so it is unit-testable.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARDWARE_BUTTONS,
  HID,
  keyEventsForText,
  type HardwareButton,
  type Orientation,
} from "../lib/sim-protocol";
import { formatAxSnapshot, normalizeAxTree, type AxSnapshot } from "./ax";
import {
  isBooted,
  matchDevice,
  pickDefaultDevice,
  type Exec,
  type SimDevice,
  type Simctl,
} from "./simctl";
import type { StreamManager, StreamSession } from "./stream-manager";

export interface KvLike {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface LogLike {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SimulatorServiceOptions {
  simctl: Simctl;
  exec: Exec;
  streams: StreamManager;
  kv: KvLike;
  log: LogLike;
  publish(channel: string, payload: unknown): void;
  idleShutdownMs(): Promise<number>;
  screenshotMaxDimension(): Promise<number>;
  tmpDir?: string;
}

export interface AttachResult {
  device: SimDevice;
  session: StreamSession;
  booted: boolean;
}

export interface Screenshot {
  data: string;
  mimeType: string;
  bytes: number;
}

export class SimulatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatorError";
  }
}

const KV_ATTACHMENTS = "attachments";
const KV_BOOTED = "booted-by-plugin";
const KV_CONSENT = "consent";
const DTUHIDD_FLAG = "com.apple.coredevice.dtuhidd.active";

export const CHANNELS = {
  sessions: "sessions-changed",
  attached: "attached",
  activity: "agent-activity",
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SimulatorService {
  private readonly attachments = new Map<string, Set<string>>();
  private readonly bootedByPlugin = new Set<string>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly textOperations = new Map<string, Promise<void>>();
  private readonly loaded: Promise<void>;
  private disposed = false;

  constructor(private readonly options: SimulatorServiceOptions) {
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      const attachments =
        (await this.options.kv.get<Record<string, string[]>>(KV_ATTACHMENTS)) ?? {};
      for (const [threadId, udids] of Object.entries(attachments)) {
        if (Array.isArray(udids) && udids.length > 0) {
          this.attachments.set(threadId, new Set(udids));
        }
      }
      for (const udid of (await this.options.kv.get<string[]>(KV_BOOTED)) ?? []) {
        this.bootedByPlugin.add(udid);
      }
    } catch (error) {
      this.options.log.warn(`could not load saved simulator state: ${describe(error)}`);
    }
  }

  private async persist(): Promise<void> {
    const attachments: Record<string, string[]> = {};
    for (const [threadId, udids] of this.attachments) {
      if (udids.size > 0) attachments[threadId] = [...udids];
    }
    await this.options.kv.set(KV_ATTACHMENTS, attachments);
    await this.options.kv.set(KV_BOOTED, [...this.bootedByPlugin]);
  }

  async ready(): Promise<void> {
    await this.loaded;
  }

  attachedTo(threadId: string): string[] {
    return [...(this.attachments.get(threadId) ?? [])];
  }

  threadsFor(udid: string): string[] {
    return [...this.attachments]
      .filter(([, udids]) => udids.has(udid))
      .map(([threadId]) => threadId);
  }

  bootedDevices(): string[] {
    return [...this.bootedByPlugin];
  }

  sessions(): StreamSession[] {
    return this.options.streams.list();
  }

  devices(signal?: AbortSignal): Promise<SimDevice[]> {
    return this.options.simctl.list(signal);
  }

  /**
   * Pick the device a request means: an explicit udid/name, else the thread's
   * attached device, else the only booted device, else (when allowed) a default.
   */
  async resolveDevice(
    threadId: string | null,
    query: string | null | undefined,
    options: { allowDefault?: boolean; signal?: AbortSignal } = {},
  ): Promise<SimDevice> {
    await this.loaded;
    const devices = await this.devices(options.signal);
    if (devices.length === 0) {
      throw new SimulatorError(
        "Xcode lists no iOS simulators. Install the iOS platform from Xcode → Settings → Components, or run `xcodebuild -downloadPlatform iOS`.",
      );
    }
    if (query && query.trim() !== "") {
      const match = matchDevice(devices, query);
      if (!match) {
        throw new SimulatorError(
          `No simulator matches "${query}". Available: ${devices
            .filter((device) => device.isAvailable)
            .slice(0, 12)
            .map((device) => `${device.name} (${device.runtime})`)
            .join(", ")}.`,
        );
      }
      return match;
    }
    if (threadId) {
      for (const udid of this.attachedTo(threadId)) {
        const attached = devices.find((device) => device.udid === udid);
        if (attached) return attached;
      }
    }
    const booted = devices.filter((device) => isBooted(device));
    if (booted.length === 1) return booted[0]!;
    if (booted.length > 1) {
      throw new SimulatorError(
        `Several simulators are booted (${booted.map((device) => device.name).join(", ")}). Name the one to use.`,
      );
    }
    if (options.allowDefault) {
      const fallback = pickDefaultDevice(devices);
      if (fallback) return fallback;
    }
    throw new SimulatorError(
      "No simulator is attached to this thread. Attach one first (ios_sim_attach, or the iOS Simulator panel).",
    );
  }

  /** Boot if needed, start the stream, and tie the device to the thread. */
  async attach(
    threadId: string,
    query: string | null | undefined,
    options: { allowDefault?: boolean; signal?: AbortSignal } = {},
  ): Promise<AttachResult> {
    const device = await this.resolveDevice(threadId, query, options);
    let booted = false;
    if (!isBooted(device)) {
      this.options.log.info(`booting ${device.name} (${device.udid})`);
      await this.options.simctl.boot(device.udid, options.signal);
      this.bootedByPlugin.add(device.udid);
      booted = true;
      device.state = "Booted";
    }
    this.cancelIdleShutdown(device.udid);
    const session = await this.options.streams.ensure(device.udid, options.signal);
    const set = this.attachments.get(threadId) ?? new Set<string>();
    const isNew = !set.has(device.udid);
    set.add(device.udid);
    this.attachments.set(threadId, set);
    await this.persist();
    if (isNew || booted) {
      this.options.publish(CHANNELS.attached, { threadId, udid: device.udid, name: device.name });
    }
    this.options.publish(CHANNELS.sessions, { udid: device.udid });
    return { device, session, booted };
  }

  /** Drop the thread's claim; stop streaming and optionally shut down when nobody else uses it. */
  async detach(
    threadId: string,
    udid: string,
    options: { shutdown?: boolean } = {},
  ): Promise<void> {
    await this.loaded;
    const set = this.attachments.get(threadId);
    set?.delete(udid);
    if (set && set.size === 0) this.attachments.delete(threadId);
    await this.persist();
    if (this.threadsFor(udid).length === 0) {
      await this.options.streams.stop(udid);
      if (options.shutdown) {
        await this.shutdownDevice(udid);
      } else if (this.bootedByPlugin.has(udid)) {
        await this.scheduleIdleShutdown(udid);
      }
    }
    this.options.publish(CHANNELS.sessions, { udid });
  }

  async shutdownDevice(udid: string): Promise<void> {
    this.cancelIdleShutdown(udid);
    await this.options.streams.stop(udid);
    try {
      await this.options.simctl.shutdown(udid);
    } finally {
      this.bootedByPlugin.delete(udid);
      await this.persist();
      this.options.publish(CHANNELS.sessions, { udid });
    }
  }

  /** A thread went away: release its devices, shutting down those this plugin booted. */
  async releaseThread(threadId: string): Promise<void> {
    await this.loaded;
    for (const udid of this.attachedTo(threadId)) {
      const lastUser = this.threadsFor(udid).length === 1;
      await this.detach(threadId, udid, {
        shutdown: lastUser && this.bootedByPlugin.has(udid),
      });
    }
  }

  private async scheduleIdleShutdown(udid: string): Promise<void> {
    this.cancelIdleShutdown(udid);
    const delay = await this.options.idleShutdownMs();
    if (!(delay > 0) || this.disposed) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(udid);
      if (this.threadsFor(udid).length > 0 || !this.bootedByPlugin.has(udid)) return;
      this.options.log.info(`shutting down idle simulator ${udid}`);
      this.shutdownDevice(udid).catch((error) =>
        this.options.log.warn(`idle shutdown of ${udid} failed: ${describe(error)}`),
      );
    }, delay);
    timer.unref?.();
    this.idleTimers.set(udid, timer);
  }

  private cancelIdleShutdown(udid: string): void {
    const timer = this.idleTimers.get(udid);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(udid);
  }

  async screenshot(udid: string, signal?: AbortSignal): Promise<Screenshot> {
    const dir = await mkdtemp(join(this.options.tmpDir ?? tmpdir(), "bb-ios-sim-"));
    try {
      const png = join(dir, "screen.png");
      await this.options.simctl.screenshot(udid, png, signal);
      const maxDimension = await this.options.screenshotMaxDimension();
      const jpeg = join(dir, "screen.jpg");
      const resized = await this.options.exec(
        "sips",
        ["-Z", String(maxDimension), "-s", "format", "jpeg", "-s", "formatOptions", "82", png, "--out", jpeg],
        { timeoutMs: 20_000, signal },
      );
      const file = resized.code === 0 ? jpeg : png;
      const bytes = await readFile(file);
      return {
        data: bytes.toString("base64"),
        mimeType: resized.code === 0 ? "image/jpeg" : "image/png",
        bytes: bytes.byteLength,
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async screenshotPng(udid: string, signal?: AbortSignal): Promise<Uint8Array> {
    const dir = await mkdtemp(join(this.options.tmpDir ?? tmpdir(), "bb-ios-sim-"));
    try {
      const png = join(dir, "screen.png");
      await this.options.simctl.screenshot(udid, png, signal);
      return new Uint8Array(await readFile(png));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async accessibility(udid: string, signal?: AbortSignal): Promise<AxSnapshot> {
    try {
      return normalizeAxTree(await this.options.streams.rawAccessibility(udid, signal));
    } catch (error) {
      if (/noFrontmostApplication/.test(describe(error))) {
        throw new SimulatorError("Xcode's accessibility service returned no frontmost application. Use ios_sim_screenshot to inspect the visible screen, then ios_sim_tap with normalized x/y coordinates. No accessibility elements were returned.");
      }
      throw error;
    }
  }

  async describeUi(
    udid: string,
    options: { filter?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    return formatAxSnapshot(await this.accessibility(udid, options.signal), options);
  }

  async tap(udid: string, x: number, y: number, holdMs = 60): Promise<void> {
    await this.options.streams.withHid(udid, async (hid) => {
      hid.send(HID.TOUCH, { type: "begin", x, y });
      await sleep(holdMs);
      hid.send(HID.TOUCH, { type: "end", x, y });
    });
  }

  async swipe(
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs = 300,
  ): Promise<void> {
    const steps = Math.max(4, Math.min(40, Math.round(durationMs / 16)));
    await this.options.streams.withHid(udid, async (hid) => {
      hid.send(HID.TOUCH, { type: "begin", x: from.x, y: from.y });
      for (let step = 1; step <= steps; step++) {
        await sleep(durationMs / steps);
        const t = step / steps;
        hid.send(HID.TOUCH, {
          type: "move",
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
        });
      }
      await sleep(20);
      hid.send(HID.TOUCH, { type: "end", x: to.x, y: to.y });
    });
  }

  private async serializeText(udid: string, work: () => Promise<void>): Promise<void> {
    const previous = this.textOperations.get(udid) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.textOperations.set(udid, pending);
    try { await pending; }
    finally { if (this.textOperations.get(udid) === pending) this.textOperations.delete(udid); }
  }

  /** Serialize the clipboard write and shortcut so concurrent pastes cannot exchange text. */
  pasteText(udid: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.serializeText(udid, () => this.paste(udid, text, signal));
  }

  private async paste(udid: string, text: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (text.length === 0) return;
    await this.options.simctl.copyText(udid, text, signal);
    signal?.throwIfAborted();
    await this.options.streams.withHid(udid, async (hid) => {
      signal?.throwIfAborted();
      // USB HID left GUI (Command) + V. Always release the modifier.
      hid.send(HID.KEY, { type: "down", usage: 227 });
      try {
        hid.send(HID.KEY, { type: "down", usage: 25 });
        await sleep(40);
      } finally {
        for (const usage of [25, 227]) {
          try { hid.send(HID.KEY, { type: "up", usage }); } catch { /* Release remaining keys even if the socket closed. */ }
        }
      }
      await sleep(100);
    });
  }

  typeText(udid: string, text: string, method: "paste" | "keys" = "paste", signal?: AbortSignal): Promise<void> {
    return this.serializeText(udid, () => this.type(udid, text, method, signal));
  }

  private async type(udid: string, text: string, method: "paste" | "keys", signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (method === "paste") {
      // Keep the tool's existing Return and Tab semantics; ios_sim_paste
      // inserts multiline text literally when that is the intended action.
      for (const part of text.replace(/\r/g, "").split(/([\n\t])/)) {
        if (part === "\n" || part === "\t") await this.type(udid, part, "keys", signal);
        else if (part) await this.paste(udid, part, signal);
      }
      return;
    }
    const { events, unsupported } = keyEventsForText(text);
    if (unsupported.length > 0) {
      throw new SimulatorError(
        `Only US-keyboard ASCII can be typed. Unsupported: ${unsupported.map((char) => JSON.stringify(char)).join(" ")}`,
      );
    }
    await this.options.streams.withHid(udid, async (hid) => {
      const held = new Set<number>();
      try {
        for (const event of events) {
          signal?.throwIfAborted();
          hid.send(HID.KEY, event);
          if (event.type === "down") held.add(event.usage);
          else held.delete(event.usage);
          await sleep(4);
        }
      } finally {
        for (const usage of held) {
          try { hid.send(HID.KEY, { type: "up", usage }); } catch { /* Connection already closed. */ }
        }
      }
    });
  }

  async pressButton(udid: string, button: HardwareButton): Promise<void> {
    const spec = HARDWARE_BUTTONS[button];
    await this.options.streams.withHid(udid, async (hid) => {
      hid.send(HID.BUTTON, spec);
      await sleep(40);
    });
  }

  async rotate(udid: string, orientation: Orientation): Promise<void> {
    await this.options.streams.withHid(udid, async (hid) => {
      hid.send(HID.ORIENTATION, { orientation });
      await sleep(80);
    });
  }

  async installAndLaunch(
    udid: string,
    appPath: string,
    options: { bundleId?: string; launchArgs?: string[]; signal?: AbortSignal } = {},
  ): Promise<{ bundleId: string; output: string }> {
    await this.options.simctl.install(udid, appPath, options.signal);
    const bundleId =
      options.bundleId ?? (await this.options.simctl.bundleIdentifier(appPath, options.signal));
    await this.options.simctl.terminate(udid, bundleId, options.signal);
    const output = await this.options.simctl.launch(udid, bundleId, {
      args: options.launchArgs,
      signal: options.signal,
    });
    return { bundleId, output };
  }

  async launch(
    udid: string,
    bundleId: string,
    options: { terminateFirst?: boolean; launchArgs?: string[]; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (options.terminateFirst !== false) {
      await this.options.simctl.terminate(udid, bundleId, options.signal);
    }
    return this.options.simctl.launch(udid, bundleId, {
      args: options.launchArgs,
      signal: options.signal,
    });
  }

  openUrl(udid: string, url: string, signal?: AbortSignal): Promise<void> {
    return this.options.simctl.openUrl(udid, url, signal);
  }

  setAppearance(udid: string, appearance: "light" | "dark", signal?: AbortSignal): Promise<void> {
    return this.options.simctl.setAppearance(udid, appearance, signal);
  }

  /**
   * Xcode 27's Device Hub takes over simulator input (it sets the
   * com.apple.coredevice.dtuhidd.active flag in the guest). While it holds it,
   * the legacy HID messages serve-sim injects are accepted but ignored.
   */
  async inputShadowed(udid: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.options.exec(
      "xcrun",
      ["simctl", "spawn", udid, "notifyutil", "-g", DTUHIDD_FLAG],
      { timeoutMs: 8_000, signal },
    );
    return result.code === 0 && result.stdout.trim().endsWith(`${DTUHIDD_FLAG} 1`);
  }

  /**
   * Hand input back from Device Hub: clear the flag and restart backboardd,
   * which restarts SpringBoard and closes running apps, then restart the
   * stream so serve-sim reconnects its guest services. Explicit, never
   * automatic, because it closes the app under test.
   */
  async repairInput(udid: string, signal?: AbortSignal): Promise<{ repaired: boolean }> {
    const shadowed = await this.inputShadowed(udid, signal);
    if (!shadowed) return { repaired: false };
    const spawn = ["simctl", "spawn", udid];
    await this.options.exec("xcrun", [...spawn, "notifyutil", "-s", DTUHIDD_FLAG, "0"], {
      timeoutMs: 8_000,
      signal,
    });
    await this.options.exec(
      "xcrun",
      [...spawn, "launchctl", "kickstart", "-k", "system/com.apple.backboardd"],
      { timeoutMs: 15_000, signal },
    );
    const hadStream = this.options.streams.get(udid) !== null;
    if (hadStream) {
      await this.options.streams.stop(udid);
      await sleep(2_500);
      await this.options.streams.ensure(udid, signal);
    }
    this.options.publish(CHANNELS.sessions, { udid });
    return { repaired: true };
  }

  /** After a plugin reload, bring back streams for devices threads still hold and that are booted. */
  async restoreSessions(): Promise<void> {
    await this.loaded;
    const wanted = new Set([...this.attachments.values()].flatMap((udids) => [...udids]));
    if (wanted.size === 0) return;
    let devices: SimDevice[];
    try {
      devices = await this.devices();
    } catch (error) {
      this.options.log.warn(`could not list simulators to restore streams: ${describe(error)}`);
      return;
    }
    for (const udid of wanted) {
      const device = devices.find((entry) => entry.udid === udid);
      if (!device || !isBooted(device)) continue;
      try {
        await this.options.streams.ensure(udid);
        this.options.log.info(`restored stream for ${device.name}`);
      } catch (error) {
        this.options.log.warn(`could not restore stream for ${device.name}: ${describe(error)}`);
      }
    }
    this.options.publish(CHANNELS.sessions, {});
  }

  async consent(): Promise<Record<string, boolean>> {
    return (await this.options.kv.get<Record<string, boolean>>(KV_CONSENT)) ?? {};
  }

  async setConsent(udid: string, allow: boolean): Promise<void> {
    const current = await this.consent();
    current[udid] = allow;
    await this.options.kv.set(KV_CONSENT, current);
    this.options.publish(CHANNELS.sessions, { udid });
  }

  agentActivity(udid: string, active: boolean): void {
    this.options.publish(CHANNELS.activity, { udid, active });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    await this.options.streams.stopAll();
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
