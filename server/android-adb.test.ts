import { describe, expect, it, vi } from "vitest";
import { AndroidAdb, parseAndroidDevices, pngDimensions, resolveAndroidTools, type AndroidExec } from "./android-adb";

export function androidPng(width = 100, height = 200) {
  const png = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  return png;
}

describe("Android SDK boundary", () => {
  it("uses existing SDK tools without requiring Xcode", () => {
    const files = new Set(["/sdk/platform-tools/adb", "/sdk/emulator/emulator"]);
    expect(resolveAndroidTools({ env: { ANDROID_HOME: "/sdk", PATH: "/bin" }, home: "/empty", executable: (file) => files.has(file) }))
      .toEqual({ adb: "/sdk/platform-tools/adb", emulator: "/sdk/emulator/emulator" });
    expect(resolveAndroidTools({ env: { PATH: "/bin" }, home: "/empty", executable: () => false })).toEqual({ adb: null, emulator: null });
  });
  it("excludes physical and network-connected devices", () => {
    expect(parseAndroidDevices("List of devices attached\nABC123 device usb:1-1\n192.168.1.1:5555 device\nemulator-5554 device product:sdk\nemulator-5556 offline\n"))
      .toEqual([{ id: "emulator-5554", serial: "emulator-5554", name: "emulator-5554", state: "Booted" },
        { id: "emulator-5556", serial: "emulator-5556", name: "emulator-5556", state: "Offline" }]);
  });
  it("rejects invalid screenshot bytes and sizes", () => {
    expect(pngDimensions(androidPng(400, 800))).toEqual({ width: 400, height: 800 });
    expect(() => pngDimensions(Buffer.from("not a screenshot"))).toThrow("PNG");
    expect(() => pngDimensions(androidPng(0, 100))).toThrow("dimensions");
  });
});

describe("Android adb operations", () => {
  function load() {
    const calls: string[][] = [];
    const exec: AndroidExec = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: args.includes("screencap") ? androidPng() : Buffer.from(""), stderr: "", code: 0 };
    };
    return { calls, adb: new AndroidAdb({ exec, tools: () => ({ adb: "/sdk/adb", emulator: null }) }) };
  }
  it("maps normalized coordinates to current PNG dimensions and supports long press", async () => {
    const { adb, calls } = load();
    await adb.tap("emulator-5554", 1, 0.5);
    expect(calls.at(-1)).toEqual(["/sdk/adb", "-s", "emulator-5554", "shell", "input", "tap", "99", "100"]);
    await adb.tap("emulator-5554", 0, 1, 1000);
    expect(calls.at(-1)).toEqual(["/sdk/adb", "-s", "emulator-5554", "shell", "input", "swipe", "0", "199", "0", "199", "1000"]);
    await expect(adb.tap("emulator-5554", 2, 0)).rejects.toThrow("Coordinates");
    await expect(adb.button("physical-device", "home")).rejects.toThrow("physical devices");
  });
  it("quotes remote shell text and handles newlines without command interpolation", async () => {
    const { adb, calls } = load();
    await adb.text("emulator-5554", "hi';$(id)\nthere");
    const text = calls.filter((call) => call.includes("text"));
    expect(text[0]?.at(-1)).toBe("'hi'\\'';$(id)'");
    expect(text[1]?.at(-1)).toBe("'there'");
    expect(calls).toContainEqual(["/sdk/adb", "-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_ENTER"]);
    await expect(adb.text("emulator-5554", "50%")).rejects.toThrow("percent");
    await expect(adb.text("emulator-5554", "😀")).rejects.toThrow("ASCII");
  });
  it("installs APKs using argv and validates the launch package", async () => {
    const { adb, calls } = load();
    await adb.installAndLaunch("emulator-5554", "/tmp/my app.apk", "com.example.app");
    expect(calls[0]).toEqual(["/sdk/adb", "-s", "emulator-5554", "install", "-r", "/tmp/my app.apk"]);
    expect(calls[1]).toEqual(["/sdk/adb", "-s", "emulator-5554", "shell", "monkey", "-p", "com.example.app", "-c", "android.intent.category.LAUNCHER", "1"]);
    await expect(adb.launch("emulator-5554", "com.example;id")).rejects.toThrow("application id");
    await expect(adb.installAndLaunch("emulator-5554", "relative.apk", "com.example.app")).rejects.toThrow("absolute");
  });
  it("keeps text and buttons in order per emulator and skips cancelled queued input", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[][] = [];
    const exec: AndroidExec = async (_file, args) => {
      calls.push(args);
      if (args.at(-1) === "'first'") await gate;
      return { stdout: Buffer.alloc(0), stderr: "", code: 0 };
    };
    const adb = new AndroidAdb({ exec, tools: () => ({ adb: "/sdk/adb", emulator: null }) });
    const first = adb.text("emulator-5554", "first\nsecond");
    const button = adb.button("emulator-5554", "home");
    const controller = new AbortController();
    const cancelled = adb.text("emulator-5554", "cancelled", controller.signal).catch((error) => error);
    controller.abort();
    await adb.text("emulator-5556", "independent");
    await vi.waitFor(() => expect(calls.some((args) => args.at(-1) === "'first'")).toBe(true));
    expect(calls.some((args) => args.at(-1) === "KEYCODE_HOME")).toBe(false);
    release(); await first; await button;
    expect(calls.filter((args) => args[1] === "emulator-5554").map((args) => args.at(-1)))
      .toEqual(["'first'", "KEYCODE_ENTER", "'second'", "KEYCODE_HOME"]);
    expect(await cancelled).toBeInstanceOf(DOMException);
  });
});
