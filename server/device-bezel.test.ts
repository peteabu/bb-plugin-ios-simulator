import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BEZEL_PARTS } from "../lib/device-bezel";
import { DeviceBezels, pdfSize } from "./device-bezel";
import type { Exec, SimDevice } from "./simctl";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

async function fixture(options: { brokenImage?: boolean; badIdentifier?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bb-bezel-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "Test.simdevicetype");
  const chrome = join(root, "Chrome/test.devicechrome/Contents/Resources");
  await mkdir(chrome, { recursive: true });
  const images = Object.fromEntries(BEZEL_PARTS.map((part) => [part, `test-${part}`]));
  await writeFile(join(chrome, "chrome.json"), JSON.stringify({
    identifier: "com.apple.dt.devicekit.chrome.test", images: { ...images,
      sizing: { leftWidth: 18, rightWidth: 18, topHeight: 18, bottomHeight: 18 } },
  }));
  for (const part of BEZEL_PARTS) {
    const width = part === "top" || part === "bottom" ? 1 : 110;
    const height = part === "left" || part === "right" ? 1 : 110;
    // Synthetic PDF metadata only: no Apple artwork is included in fixtures.
    await writeFile(join(chrome, `test-${part}.pdf`), `%PDF-1.3\n/MediaBox [0 0 ${width} ${height}]`);
  }
  let conversions = 0;
  let pngPath: string | null = null;
  const exec: Exec = async (file, args) => {
    if (file === "xcrun") return { code: 0, stderr: "", stdout: JSON.stringify({ devicetypes: [{ identifier: "test-device", bundlePath: bundle }] }) };
    if (file === "/usr/bin/plutil") return { code: 0, stderr: "", stdout: JSON.stringify(
      args.at(-1)?.endsWith("capabilities.plist")
        ? { capabilities: { displays: [{ deviceName: "primary", width: 1206, height: 2622, scale: 3, cornerRadiusUL: 62 }] } }
        : { chromeIdentifier: options.badIdentifier ? "../../other" : "com.apple.dt.devicekit.chrome.test" },
    ) };
    conversions += 1;
    pngPath = args.at(-1)!;
    if (!options.brokenImage) await writeFile(pngPath, "synthetic png");
    return { code: options.brokenImage ? 1 : 0, stdout: "", stderr: "" };
  };
  const bezels = new DeviceBezels({ exec, deviceTypeRoots: [], deviceKitRoot: root, simctl: {
    xcodePath: async () => null,
    get: async (udid) => udid === "valid" ? ({ deviceType: "test-device" } as SimDevice) : null,
  } });
  cleanup.push(() => bezels.dispose());
  return { bezels, conversions: () => conversions, pngPath: () => pngPath };
}

describe("local Xcode device artwork", () => {
  it("combines native screen geometry and DeviceKit edge sizes", async () => {
    const { bezels } = await fixture();
    const frame = await bezels.geometry("valid");
    expect(frame).toMatchObject({ source: "xcode", width: 438, height: 910,
      screen: { x: 18, y: 18, width: 402, height: 874, cornerRadius: 62 } });
    expect(frame?.layers.find((layer) => layer.id === "top")).toEqual({ id: "top", x: 110, y: 0, width: 218, height: 110 });
    expect(frame?.layers.find((layer) => layer.id === "bottomRight")).toEqual({ id: "bottomRight", x: 328, y: 800, width: 110, height: 110 });
  });

  it("caches rasterizations in a temporary directory and removes them on dispose", async () => {
    const f = await fixture();
    expect((await f.bezels.image("valid", "topLeft"))?.toString()).toBe("synthetic png");
    await f.bezels.image("valid", "topLeft");
    expect(f.conversions()).toBe(1);
    await f.bezels.dispose();
    await expect(readFile(f.pngPath()!)).rejects.toThrow();
    expect(await f.bezels.image("valid", "topLeft")).toBeNull();
  });

  it("returns no artwork for missing devices, unsafe identifiers, unknown parts, or failed conversion", async () => {
    const bad = await fixture({ badIdentifier: true });
    expect(await bad.bezels.geometry("valid")).toBeNull();
    const f = await fixture({ brokenImage: true });
    expect(await f.bezels.geometry("missing")).toBeNull();
    expect(await f.bezels.image("valid", "../../Info.plist")).toBeNull();
    expect(await f.bezels.image("valid", "topLeft")).toBeNull();
    expect(pdfSize(Buffer.from("/MediaBox [0 0 -12 20]"))).toBeNull();
  });
});
