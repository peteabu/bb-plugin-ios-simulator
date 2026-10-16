import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface AndroidTools { adb: string | null; emulator: string | null }
export interface AndroidExecResult { stdout: Buffer; stderr: string; code: number }
export type AndroidExec = (file: string, args: string[], options?: {
  signal?: AbortSignal; timeoutMs?: number; maxBytes?: number;
}) => Promise<AndroidExecResult>;
export type AndroidSpawn = (file: string, args: string[]) => ChildProcess;

/** Existing SDK installations only; finding tools never downloads an SDK. */
export function resolveAndroidTools(options: {
  env?: NodeJS.ProcessEnv; home?: string; executable?: (path: string) => boolean;
} = {}): AndroidTools {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const executable = options.executable ?? ((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  const sdkRoots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME,
    join(home, "Library/Android/sdk"), join(home, "Android/Sdk"),
    join(home, ".android/sdk"), "/opt/android-sdk", "/usr/local/share/android-sdk"]
    .filter((root): root is string => Boolean(root));
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const find = (name: "adb" | "emulator", directory: string) => {
    const binary = process.platform === "win32" ? `${name}.exe` : name;
    return [...pathDirs.map((dir) => join(dir, binary)),
      ...sdkRoots.map((root) => join(root, directory, binary))].find(executable) ?? null;
  };
  return { adb: find("adb", "platform-tools"), emulator: find("emulator", "emulator") };
}

export const createAndroidExec = (): AndroidExec => (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(file, args, {
      encoding: "buffer", timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBytes ?? 256 * 1024, signal: options.signal,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ stdout: Buffer.from(stdout ?? ""), code,
        stderr: Buffer.from(stderr ?? "").toString("utf8") || (error?.message ?? "") });
    });
  });

export const spawnAndroidEmulator: AndroidSpawn = (file, args) =>
  spawn(file, args, { stdio: "ignore", windowsHide: true });

export interface AndroidDevice {
  id: string;
  name: string;
  serial: string | null;
  state: "Booted" | "Shutdown" | "Offline";
}
export const EMULATOR_SERIAL = /^emulator-\d{4,5}$/;
const AVD_NAME = /^[A-Za-z0-9_.-]{1,180}$/;

/** Explicitly excludes USB and network-connected physical Android devices. */
export function parseAndroidDevices(output: string): AndroidDevice[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const [serial, status] = line.trim().split(/\s+/);
    if (!serial || !EMULATOR_SERIAL.test(serial)) return [];
    return [{ id: serial, serial, name: serial,
      state: status === "device" ? "Booted" as const : "Offline" as const }];
  }).slice(0, 100);
}

export class AndroidAdb {
  private readonly inputQueues = new Map<string, Promise<void>>();
  constructor(readonly options: { exec: AndroidExec; tools: () => AndroidTools }) {}

  /** Keep multi-command text input contiguous with taps, swipes, and buttons. */
  private input(serial: string, signal: AbortSignal | undefined, work: () => Promise<void>): Promise<void> {
    const previous = this.inputQueues.get(serial) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => {
      signal?.throwIfAborted();
      return work();
    });
    this.inputQueues.set(serial, pending);
    void pending.finally(() => {
      if (this.inputQueues.get(serial) === pending) this.inputQueues.delete(serial);
    }).catch(() => undefined);
    return pending;
  }

  async run(args: string[], options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<Buffer> {
    const adb = this.options.tools().adb;
    if (!adb) throw new Error("Android platform-tools (adb) were not found. Install them in Android Studio's SDK Manager or add an existing SDK to ANDROID_HOME/PATH.");
    options.signal?.throwIfAborted();
    const result = await this.options.exec(adb, args, options);
    options.signal?.throwIfAborted();
    if (result.code !== 0) throw new Error(`adb ${args.slice(0, 3).join(" ")} failed: ${result.stderr.slice(0, 2_000) || result.stdout.toString("utf8").slice(0, 2_000) || `exit ${result.code}`}`);
    return result.stdout;
  }

  device(serial: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}) {
    if (!EMULATOR_SERIAL.test(serial)) throw new Error("Only Android emulator serials are supported; physical devices cannot be controlled by this plugin.");
    return this.run(["-s", serial, ...args], options);
  }

  async devices(signal?: AbortSignal): Promise<AndroidDevice[]> {
    const devices = parseAndroidDevices((await this.run(["devices", "-l"], { signal })).toString("utf8"));
    for (const device of devices) {
      if (device.state !== "Booted") continue;
      const result = await this.device(device.serial!, ["emu", "avd", "name"], { signal }).catch(() => null);
      const name = result?.toString("utf8").trim().split(/\r?\n/)[0];
      if (name && AVD_NAME.test(name)) device.name = name;
    }
    const emulator = this.options.tools().emulator;
    if (emulator) {
      const result = await this.options.exec(emulator, ["-list-avds"], { signal, timeoutMs: 10_000 });
      if (result.code === 0) {
        for (const name of result.stdout.toString("utf8").split(/\r?\n/).slice(0, 100)) {
          if (AVD_NAME.test(name) && !devices.some((device) => device.name === name))
            devices.push({ id: `avd:${name}`, name, serial: null, state: "Shutdown" });
        }
      }
    }
    return devices;
  }

  async screenshot(serial: string, signal?: AbortSignal): Promise<Buffer> {
    const bytes = await this.device(serial, ["exec-out", "screencap", "-p"], {
      signal, timeoutMs: 10_000, maxBytes: 12 * 1024 * 1024,
    });
    pngDimensions(bytes);
    return bytes;
  }

  async dimensions(serial: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
    // A screenshot reports the current rotation; `wm size` reports natural dimensions.
    return pngDimensions(await this.screenshot(serial, signal));
  }

  async tap(serial: string, x: number, y: number, holdMs = 0, signal?: AbortSignal) {
    return this.input(serial, signal, async () => {
      const { width, height } = await this.dimensions(serial, signal);
      const point = [pixel(x, width), pixel(y, height)];
      await this.device(serial, ["shell", "input", ...(holdMs > 0
        ? ["swipe", ...point, ...point, String(holdMs)] : ["tap", ...point])], { signal });
    });
  }

  async swipe(serial: string, fromX: number, fromY: number, toX: number, toY: number, durationMs: number, signal?: AbortSignal) {
    return this.input(serial, signal, async () => {
      const { width, height } = await this.dimensions(serial, signal);
      await this.device(serial, ["shell", "input", "swipe", pixel(fromX, width), pixel(fromY, height),
        pixel(toX, width), pixel(toY, height), String(durationMs)], { signal });
    });
  }

  async text(serial: string, value: string, signal?: AbortSignal) {
    // `adb shell` joins arguments into a remote shell command. Quote text rather
    // than assuming execFile argv also protects against Android shell expansion.
    if (!/^[\x20-\x7e\n]{1,2000}$/.test(value) || value.includes("%"))
      throw new Error("Android input supports 1–2000 printable ASCII characters and newlines; percent signs and Unicode are unavailable through adb input.");
    return this.input(serial, signal, async () => {
      const lines = value.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await this.device(serial, ["shell", "input", "keyevent", BUTTON_CODES.enter], { signal });
        if (lines[i]) await this.device(serial, ["shell", "input", "text", shellQuote(lines[i]!.replaceAll(" ", "%s"))], { signal });
      }
    });
  }

  async button(serial: string, button: AndroidButton, signal?: AbortSignal) {
    return this.input(serial, signal, async () => {
      await this.device(serial, ["shell", "input", "keyevent", BUTTON_CODES[button]], { signal });
    });
  }

  async installAndLaunch(serial: string, apkPath: string, packageName: string, signal?: AbortSignal) {
    if (!isAbsolute(apkPath) || !apkPath.toLowerCase().endsWith(".apk") || apkPath.includes("\0"))
      throw new Error("apkPath must be an absolute path to an APK on the BB server host.");
    validatePackage(packageName);
    await this.device(serial, ["install", "-r", apkPath], { signal, timeoutMs: 120_000 });
    await this.launch(serial, packageName, signal);
  }

  async launch(serial: string, packageName: string, signal?: AbortSignal) {
    validatePackage(packageName);
    const result = await this.device(serial, ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"], { signal });
    if (/No activities found|monkey aborted|Error:/i.test(result.toString("utf8")))
      throw new Error(`Could not launch ${packageName}: ${result.toString("utf8").slice(0, 1000)}`);
  }
}

export const ANDROID_BUTTONS = ["home", "back", "overview", "power", "volume-up", "volume-down", "enter", "backspace"] as const;
export type AndroidButton = (typeof ANDROID_BUTTONS)[number];
const BUTTON_CODES: Record<AndroidButton, string> = {
  home: "KEYCODE_HOME", back: "KEYCODE_BACK", overview: "KEYCODE_APP_SWITCH",
  power: "KEYCODE_POWER", "volume-up": "KEYCODE_VOLUME_UP", "volume-down": "KEYCODE_VOLUME_DOWN",
  enter: "KEYCODE_ENTER", backspace: "KEYCODE_DEL",
};
function pixel(value: number, size: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Coordinates must be between 0 and 1.");
  return String(Math.round(value * (size - 1)));
}
function shellQuote(value: string) { return `'${value.replaceAll("'", `'\\''`)}'`; }
function validatePackage(value: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value))
    throw new Error("packageName must be an Android application id such as com.example.app.");
}
export function pngDimensions(bytes: Buffer) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw new Error("Android screencap did not return a PNG image.");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) throw new Error("Android screenshot dimensions are invalid.");
  return { width, height };
}
