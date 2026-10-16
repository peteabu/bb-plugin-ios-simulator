import { describe, expect, it } from "vitest";
import {
  Simctl,
  matchDevice,
  parseDeviceList,
  pickDefaultDevice,
  runtimeLabel,
  type Exec,
  type ExecResult,
} from "./simctl";

export const DEVICE_LIST = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: "AAAA-1",
        name: "iPhone 17 Pro",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      },
      { udid: "AAAA-2", name: "iPhone 17", state: "Booted", isAvailable: true },
      { udid: "AAAA-3", name: "iPad Pro 13-inch (M5)", state: "Shutdown", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-4": [
      { udid: "BBBB-1", name: "iPhone SE (3rd generation)", state: "Shutdown", isAvailable: true },
      { udid: "BBBB-9", name: "Broken", state: "Shutdown", isAvailable: false },
    ],
  },
});

describe("parseDeviceList", () => {
  it("flattens runtimes, labels them, and sorts booted then newest", () => {
    const devices = parseDeviceList(DEVICE_LIST);
    expect(devices.map((device) => device.udid)).toEqual(["AAAA-2", "AAAA-3", "AAAA-1", "BBBB-9", "BBBB-1"]);
    expect(devices[0]).toMatchObject({ runtime: "iOS 26.0", state: "Booted", isAvailable: true });
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-18-4")).toBe("iOS 18.4");
  });

  it("matches by udid, exact name, prefix, then substring, preferring available devices", () => {
    const devices = parseDeviceList(DEVICE_LIST);
    expect(matchDevice(devices, "aaaa-1")?.name).toBe("iPhone 17 Pro");
    expect(matchDevice(devices, "iphone 17")?.udid).toBe("AAAA-2");
    expect(matchDevice(devices, "iPhone SE")?.udid).toBe("BBBB-1");
    expect(matchDevice(devices, "ipad")?.udid).toBe("AAAA-3");
    expect(matchDevice(devices, "broken")).toBeNull();
    expect(matchDevice(devices, "pixel")).toBeNull();
  });

  it("picks a booted iPhone, else the newest available iPhone", () => {
    const devices = parseDeviceList(DEVICE_LIST);
    expect(pickDefaultDevice(devices)?.udid).toBe("AAAA-2");
    const shutdown = devices.map((device) => ({ ...device, state: "Shutdown" }));
    expect(pickDefaultDevice(shutdown)?.udid).toBe("AAAA-2"); // newest runtime, then name
  });
});

function fakeExec(script: (file: string, args: string[]) => Partial<ExecResult> | undefined): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const result = script(file, args) ?? {};
    return { stdout: "", stderr: "", code: 0, ...result };
  };
  return { exec, calls };
}

describe("Simctl", () => {
  it("treats an already-booted device as success and waits for bootstatus", async () => {
    const { exec, calls } = fakeExec((_file, args) => {
      if (args[1] === "boot") {
        return { code: 149, stderr: "Unable to boot device in current state: Booted" };
      }
      return undefined;
    });
    await new Simctl(exec).boot("AAAA-2");
    expect(calls).toEqual([
      ["xcrun", "simctl", "boot", "AAAA-2"],
      ["xcrun", "simctl", "bootstatus", "AAAA-2"],
    ]);
  });

  it("surfaces real boot failures with the simctl message", async () => {
    const { exec } = fakeExec((_file, args) =>
      args[1] === "boot" ? { code: 1, stderr: "Invalid device: nope" } : undefined,
    );
    await expect(new Simctl(exec).boot("nope")).rejects.toThrow(/Invalid device: nope/);
  });

  it("reads the bundle identifier with plutil and relaunches on launch", async () => {
    const { exec, calls } = fakeExec((file, args) => {
      if (file === "plutil") return { stdout: "com.acme.App\n" };
      if (args[1] === "launch") return { stdout: "com.acme.App: 4242" };
      return undefined;
    });
    const simctl = new Simctl(exec);
    expect(await simctl.bundleIdentifier("/tmp/Acme.app/")).toBe("com.acme.App");
    expect(calls[0]).toEqual([
      "plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", "/tmp/Acme.app/Info.plist",
    ]);
    expect(await simctl.launch("AAAA-2", "com.acme.App", { args: ["-ui-testing"] })).toBe(
      "com.acme.App: 4242",
    );
    expect(calls.at(-1)).toEqual(["xcrun", "simctl", "launch", "AAAA-2", "com.acme.App", "-ui-testing"]);
  });
});
