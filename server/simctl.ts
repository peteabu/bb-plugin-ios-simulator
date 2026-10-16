// Thin, testable wrapper over `xcrun simctl`. Every command runs through an
// injected Exec so tests can replay canned output without Xcode.
import { guestPasteboardHelperPath } from "./simulator-pasteboard";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Signal used when the timeout fires; recordings need SIGINT to finalize. */
  killSignal?: NodeJS.Signals;
  signal?: AbortSignal;
  input?: string;
  env?: Record<string, string>;
}

export type Exec = (
  file: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export class SimctlError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult | null = null,
  ) {
    super(message);
    this.name = "SimctlError";
  }
}

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  runtimeId: string;
  deviceType: string | null;
  isAvailable: boolean;
}

interface RawDevice {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
  availability?: unknown;
  deviceTypeIdentifier?: unknown;
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-0" → "iOS 26.0". */
export function runtimeLabel(runtimeId: string): string {
  const tail = runtimeId.split(".").pop() ?? runtimeId;
  const match = /^([A-Za-z]+)-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(tail);
  if (!match) return tail;
  const [, platform, major, minor, patch] = match;
  return `${platform} ${[major, minor, patch].filter(Boolean).join(".")}`;
}

export function runtimeVersion(runtimeId: string): number[] {
  const tail = runtimeId.split(".").pop() ?? "";
  return tail
    .split("-")
    .slice(1)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareVersionsDesc(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function parseDeviceList(json: string): SimDevice[] {
  let parsed: { devices?: Record<string, RawDevice[]> };
  try {
    parsed = JSON.parse(json) as { devices?: Record<string, RawDevice[]> };
  } catch (cause) {
    throw new SimctlError(
      `simctl returned unreadable JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const devices: SimDevice[] = [];
  for (const [runtimeId, list] of Object.entries(parsed.devices ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw.udid !== "string" || typeof raw.name !== "string") continue;
      const available =
        typeof raw.isAvailable === "boolean"
          ? raw.isAvailable
          : raw.availability === "(available)";
      devices.push({
        udid: raw.udid,
        name: raw.name,
        state: typeof raw.state === "string" ? raw.state : "Unknown",
        runtime: runtimeLabel(runtimeId),
        runtimeId,
        deviceType:
          typeof raw.deviceTypeIdentifier === "string"
            ? raw.deviceTypeIdentifier
            : null,
        isAvailable: available,
      });
    }
  }
  return sortDevices(devices);
}

/** Booted first, then newest runtime, then name. */
export function sortDevices(devices: SimDevice[]): SimDevice[] {
  return [...devices].sort((a, b) => {
    const bootDiff = Number(b.state === "Booted") - Number(a.state === "Booted");
    if (bootDiff !== 0) return bootDiff;
    const versionDiff = compareVersionsDesc(
      runtimeVersion(a.runtimeId),
      runtimeVersion(b.runtimeId),
    );
    if (versionDiff !== 0) return versionDiff;
    return a.name.localeCompare(b.name);
  });
}

/** Resolve a udid or a (partial) name. Exact matches win over prefixes over substrings. */
export function matchDevice(
  devices: SimDevice[],
  query: string,
): SimDevice | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  const available = devices.filter((device) => device.isAvailable);
  const pool = available.length > 0 ? available : devices;
  const byUdid = pool.find((device) => device.udid.toLowerCase() === needle);
  if (byUdid) return byUdid;
  const tiers: Array<(name: string) => boolean> = [
    (name) => name === needle,
    (name) => name.startsWith(needle),
    (name) => name.includes(needle),
  ];
  for (const tier of tiers) {
    const hits = sortDevices(pool.filter((device) => tier(device.name.toLowerCase())));
    if (hits.length > 0) return hits[0]!;
  }
  return null;
}

/** A sensible default: a booted iPhone, else the newest available iPhone, else anything. */
export function pickDefaultDevice(devices: SimDevice[]): SimDevice | null {
  const available = sortDevices(devices.filter((device) => device.isAvailable));
  const phones = available.filter((device) => /iphone/i.test(device.name));
  return phones[0] ?? available[0] ?? null;
}

export function isBooted(device: SimDevice | null | undefined): boolean {
  return device?.state === "Booted";
}

function failure(action: string, result: ExecResult): SimctlError {
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
  return new SimctlError(
    `${action} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
    result,
  );
}

export class Simctl {
  constructor(
    private readonly exec: Exec,
    private readonly xcrun = "xcrun",
  ) {}

  private async run(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.exec(this.xcrun, ["simctl", ...args], options);
  }

  async xcodePath(): Promise<string | null> {
    const result = await this.exec("xcode-select", ["-p"], { timeoutMs: 10_000 });
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  async list(signal?: AbortSignal): Promise<SimDevice[]> {
    const result = await this.run(["list", "devices", "-j"], {
      timeoutMs: 30_000,
      signal,
    });
    if (result.code !== 0) throw failure("Listing simulators", result);
    return parseDeviceList(result.stdout);
  }

  async get(udid: string, signal?: AbortSignal): Promise<SimDevice | null> {
    const devices = await this.list(signal);
    return devices.find((device) => device.udid === udid) ?? null;
  }

  /** Boot and wait until the device is usable. Already-booted devices are fine. */
  async boot(udid: string, signal?: AbortSignal): Promise<void> {
    const boot = await this.run(["boot", udid], { timeoutMs: 60_000, signal });
    if (boot.code !== 0) {
      const text = `${boot.stderr} ${boot.stdout}`.toLowerCase();
      if (!text.includes("current state: booted") && !text.includes("already booted")) {
        throw failure("Booting the simulator", boot);
      }
    }
    const status = await this.run(["bootstatus", udid], {
      timeoutMs: 180_000,
      signal,
    });
    if (status.code !== 0) {
      const device = await this.get(udid, signal);
      if (!isBooted(device)) throw failure("Waiting for the simulator to boot", status);
    }
  }

  async shutdown(udid: string, signal?: AbortSignal): Promise<void> {
    const result = await this.run(["shutdown", udid], { timeoutMs: 60_000, signal });
    if (result.code !== 0) {
      const text = `${result.stderr} ${result.stdout}`.toLowerCase();
      if (!text.includes("current state: shutdown")) {
        throw failure("Shutting down the simulator", result);
      }
    }
  }

  async install(udid: string, appPath: string, signal?: AbortSignal): Promise<void> {
    const result = await this.run(["install", udid, appPath], {
      timeoutMs: 180_000,
      signal,
    });
    if (result.code !== 0) throw failure(`Installing ${appPath}`, result);
  }

  async terminate(udid: string, bundleId: string, signal?: AbortSignal): Promise<void> {
    await this.run(["terminate", udid, bundleId], { timeoutMs: 30_000, signal });
  }

  async launch(
    udid: string,
    bundleId: string,
    options: { args?: string[]; signal?: AbortSignal } = {},
  ): Promise<string> {
    const result = await this.run(
      ["launch", udid, bundleId, ...(options.args ?? [])],
      { timeoutMs: 60_000, signal: options.signal },
    );
    if (result.code !== 0) throw failure(`Launching ${bundleId}`, result);
    return result.stdout.trim();
  }

  async openUrl(udid: string, url: string, signal?: AbortSignal): Promise<void> {
    const result = await this.run(["openurl", udid, url], { timeoutMs: 30_000, signal });
    if (result.code !== 0) throw failure(`Opening ${url}`, result);
  }

  async copyText(udid: string, text: string, signal?: AbortSignal): Promise<void> {
    const helper = guestPasteboardHelperPath();
    const result = await this.run(helper ? ["spawn", udid, helper] : ["pbcopy", udid], {
      input: text,
      timeoutMs: 10_000,
      signal,
    });
    if (result.code !== 0) throw failure("Copying text to the simulator", result);
    // Xcode 27's pbcopy can exit zero while writing an empty promised item.
    const copied = await this.run(["pbpaste", udid], { timeoutMs: 10_000, signal });
    if (copied.code !== 0 || copied.stdout !== text) {
      throw new SimctlError("The simulator did not retain the clipboard text. Run npm run build:pasteboard in the plugin directory and try again.");
    }
  }

  async screenshot(udid: string, outPath: string, signal?: AbortSignal): Promise<void> {
    const result = await this.run(
      ["io", udid, "screenshot", "--type=png", outPath],
      { timeoutMs: 30_000, signal },
    );
    if (result.code !== 0) throw failure("Taking a screenshot", result);
  }

  async setAppearance(
    udid: string,
    appearance: "light" | "dark",
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.run(["ui", udid, "appearance", appearance], {
      timeoutMs: 30_000,
      signal,
    });
    if (result.code !== 0) throw failure("Setting the appearance", result);
  }

  /**
   * Record the screen with Apple's own capture for `seconds`; the timeout's
   * SIGINT is what ends and finalizes the recording. Diagnostic only.
   */
  async recordVideo(udid: string, outPath: string, seconds: number, signal?: AbortSignal): Promise<void> {
    const result = await this.run(
      ["io", udid, "recordVideo", "--codec", "h264", "--force", outPath],
      { timeoutMs: Math.round(seconds * 1000), killSignal: "SIGINT", signal },
    );
    const text = `${result.stderr} ${result.stdout}`;
    if (/error|failed/i.test(text) && !/Recording started|Wrote video/i.test(text)) {
      throw failure("Recording the screen", result);
    }
  }

  /** CFBundleIdentifier from an .app bundle's Info.plist. */
  async bundleIdentifier(appPath: string, signal?: AbortSignal): Promise<string> {
    const result = await this.exec(
      "plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", `${appPath.replace(/\/+$/, "")}/Info.plist`],
      { timeoutMs: 10_000, signal },
    );
    const id = result.stdout.trim();
    if (result.code !== 0 || id === "") {
      throw new SimctlError(
        `Could not read CFBundleIdentifier from ${appPath}/Info.plist; pass bundleId explicitly.`,
        result,
      );
    }
    return id;
  }
}
