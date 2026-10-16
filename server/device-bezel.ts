import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BEZEL_PARTS, type BezelPart, type DeviceBezel } from "../lib/device-bezel";
import type { Exec, Simctl } from "./simctl";

interface BezelDependencies {
  exec: Exec;
  simctl: Pick<Simctl, "get" | "xcodePath">;
  /** Tests use synthetic profiles/artwork; production reads the installed Apple assets. */
  deviceTypeRoots?: string[];
  deviceKitRoot?: string;
}

interface ResolvedBezel {
  geometry: DeviceBezel;
  files: Record<BezelPart, string>;
}

interface ChromeImages {
  sizing?: { leftWidth?: number; rightWidth?: number; topHeight?: number; bottomHeight?: number };
  [key: string]: unknown;
}

interface DeviceProfile {
  chromeIdentifier?: string;
  capabilities?: {
    displays?: Array<{ deviceName?: string; chromeIdentifier?: string; width?: number; height?: number; scale?: number; cornerRadiusUL?: number }>;
  };
}

function finite(value: unknown, max = 20_000): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}

/** MediaBox is present in DeviceKit's small, single-page PDF resources. */
export function pdfSize(pdf: Buffer): { width: number; height: number } | null {
  const match = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(pdf.toString("latin1"));
  if (!match) return null;
  const width = Number(match[3]) - Number(match[1]);
  const height = Number(match[4]) - Number(match[2]);
  return finite(width, 4096) && finite(height, 4096) ? { width, height } : null;
}

/** Reads Apple resources in place. Only disposable rasterizations are written. */
export class DeviceBezels {
  private readonly devices = new Map<string, Promise<ResolvedBezel | null>>();
  private readonly images = new Map<string, Promise<Buffer | null>>();
  private directory: Promise<string> | null = null;
  private disposed = false;

  constructor(private readonly dependencies: BezelDependencies) {}

  private async profile(deviceType: string): Promise<DeviceProfile | null> {
    const { exec, simctl } = this.dependencies;
    const developer = await simctl.xcodePath();
    const roots = this.dependencies.deviceTypeRoots ?? [
      "/Library/Developer/CoreSimulator/Profiles/DeviceTypes",
      ...(developer ? [join(developer, "Library/CoreSimulator/Profiles/DeviceTypes")] : []),
    ];
    // simctl supplies the bundle path, including devices outside the standard roots.
    const listing = await exec("xcrun", ["simctl", "list", "devicetypes", "-j"], { timeoutMs: 10_000 });
    let bundle: string | undefined;
    if (listing.code === 0) {
      const rows = JSON.parse(listing.stdout).devicetypes as Array<{ identifier?: string; bundlePath?: string }>;
      bundle = rows?.find((row) => row.identifier === deviceType)?.bundlePath;
    }
    const paths = bundle ? [join(bundle, "Contents/Resources/profile.plist")] : [];
    // Device type identifiers use hyphenated display names. Checking the Info.plist
    // keeps renamed simulator devices and identifiers with punctuation unambiguous.
    for (const root of paths.length ? [] : roots) {
      for (const name of await readdir(root).catch(() => [])) {
        if (!name.endsWith(".simdevicetype")) continue;
        const directory = join(root, name, "Contents");
        const info = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(directory, "Info.plist")], { timeoutMs: 5_000 });
        if (info.code === 0 && JSON.parse(info.stdout).CFBundleIdentifier === deviceType) {
          paths.push(join(directory, "Resources/profile.plist"));
          break;
        }
      }
      if (paths.length) break;
    }
    for (const path of paths) {
      const [profile, capabilities] = await Promise.all([
        exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { timeoutMs: 5_000 }),
        exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(dirname(path), "capabilities.plist")], { timeoutMs: 5_000 }),
      ]);
      if (profile.code === 0 && capabilities.code === 0) {
        return { ...JSON.parse(profile.stdout), capabilities: JSON.parse(capabilities.stdout).capabilities };
      }
    }
    return null;
  }

  private async resolve(udid: string): Promise<ResolvedBezel | null> {
    const device = await this.dependencies.simctl.get(udid);
    if (!device?.deviceType) return null;
    const profile = await this.profile(device.deviceType);
    const display = profile?.capabilities?.displays?.find((value) => value.deviceName === "primary");
    const identifier = display?.chromeIdentifier ?? profile?.chromeIdentifier;
    const name = typeof identifier === "string" ? /^com\.apple\.dt\.devicekit\.chrome\.([a-z0-9]+)$/.exec(identifier)?.[1] : null;
    if (!name || !finite(display?.width) || !finite(display?.height) || !finite(display?.scale, 4)) return null;
    const directory = join(this.dependencies.deviceKitRoot ?? "/Library/Developer/DeviceKit", "Chrome", `${name}.devicechrome`, "Contents/Resources");
    const chrome = JSON.parse(await readFile(join(directory, "chrome.json"), "utf8")) as { identifier?: string; images?: ChromeImages };
    if (chrome.identifier !== identifier) return null;
    const images = chrome.images;
    const sizing = images?.sizing;
    if (!sizing || ![sizing.leftWidth, sizing.rightWidth, sizing.topHeight, sizing.bottomHeight].every((n) => finite(n, 256))) return null;
    const left = sizing.leftWidth!, top = sizing.topHeight!;
    const screenWidth = display.width / display.scale, screenHeight = display.height / display.scale;
    const width = screenWidth + left + sizing.rightWidth!;
    const height = screenHeight + top + sizing.bottomHeight!;
    const files = {} as Record<BezelPart, string>;
    const sizes = {} as Record<BezelPart, { width: number; height: number }>;
    for (const part of BEZEL_PARTS) {
      const asset = images?.[part];
      if (typeof asset !== "string" || basename(asset) !== asset || !/^[\w .-]+$/.test(asset)) return null;
      files[part] = join(directory, `${asset}.pdf`);
      const size = pdfSize(await readFile(files[part]));
      if (!size) return null;
      sizes[part] = size;
    }
    const layers = BEZEL_PARTS.map((id) => {
      let { width: w, height: h } = sizes[id];
      let x = 0, y = 0;
      if (id === "top" || id === "bottom") {
        x = sizes[id === "top" ? "topLeft" : "bottomLeft"].width;
        w = width - x - sizes[id === "top" ? "topRight" : "bottomRight"].width;
      } else if (id === "left" || id === "right") {
        y = sizes[id === "left" ? "topLeft" : "topRight"].height;
        h = height - y - sizes[id === "left" ? "bottomLeft" : "bottomRight"].height;
      }
      if (id === "right" || id === "topRight" || id === "bottomRight") x = width - w;
      if (id === "bottom" || id === "bottomLeft" || id === "bottomRight") y = height - h;
      return { id, x, y, width: w, height: h };
    });
    if (layers.some((layer) => !finite(layer.width) || !finite(layer.height))) return null;
    const radius = Math.max(0, Number(display.cornerRadiusUL) || 0);
    return { files, geometry: { source: "xcode", width, height, screen: { x: left, y: top, width: screenWidth, height: screenHeight, cornerRadius: radius }, layers } };
  }

  private get(udid: string): Promise<ResolvedBezel | null> {
    if (this.disposed || !udid) return Promise.resolve(null);
    let result = this.devices.get(udid);
    if (!result) {
      result = this.resolve(udid).catch(() => null);
      this.devices.set(udid, result);
    }
    return result;
  }

  async geometry(udid: string): Promise<DeviceBezel | null> {
    return (await this.get(udid))?.geometry ?? null;
  }

  async image(udid: string, part: string): Promise<Buffer | null> {
    if (!BEZEL_PARTS.includes(part as BezelPart)) return null;
    const source = (await this.get(udid))?.files[part as BezelPart];
    if (!source || this.disposed) return null;
    let image = this.images.get(source);
    if (!image) {
      image = (async () => {
        this.directory ??= mkdtemp(join(tmpdir(), "bb-device-bezels-"));
        const path = join(await this.directory, `${createHash("sha256").update(source).digest("hex")}.png`);
        const result = await this.dependencies.exec("/usr/bin/sips", ["-s", "format", "png", source, "--out", path], { timeoutMs: 15_000 });
        return result.code === 0 ? readFile(path) : null;
      })().catch(() => null);
      this.images.set(source, image);
    }
    return image;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.images.values());
    if (this.directory) await rm(await this.directory, { recursive: true, force: true });
    this.devices.clear();
    this.images.clear();
  }
}

export function registerDeviceBezels(bb: BbPluginApi, dependencies: BezelDependencies): void {
  const bezels = new DeviceBezels(dependencies);
  bb.http.route("GET", "/bezel", async (c) => c.json(await bezels.geometry(c.req.query("udid") ?? "")));
  bb.http.route("GET", "/bezel/image", async (c) => {
    const png = await bezels.image(c.req.query("udid") ?? "", c.req.query("part") ?? "");
    return png ? new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } })
      : c.json({ error: "The local Xcode bezel is unavailable." }, 404);
  });
  bb.onDispose(() => bezels.dispose());
}
