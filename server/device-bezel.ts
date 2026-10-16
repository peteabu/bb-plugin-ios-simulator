import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  files: Partial<Record<BezelPart | "mask", { path: string; scale: number }>>;
}

interface ChromeImages {
  sizing?: { leftWidth?: number; rightWidth?: number; topHeight?: number; bottomHeight?: number };
  [key: string]: unknown;
}

interface DeviceProfile {
  chromeIdentifier?: string;
  framebufferMask?: string;
  resourceDirectory: string;
  capabilities?: {
    displays?: Array<{ deviceName?: string; chromeIdentifier?: string; framebufferMaskIdentifier?: string; width?: number; height?: number; scale?: number; cornerRadiusUL?: number }>;
  };
}

// Quartz renders the vectors at the requested backing scale. sips ignores DPI
// when rasterizing these PDFs, leaving a 110-point corner only 110 pixels wide.
// The tiny renderer is compiled once into this instance's disposable directory;
// neither Apple artwork nor generated binaries enter the plugin package.
const PDF_RENDERER = String.raw`
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 5,
      let scale = Double(CommandLine.arguments[2]), scale > 0, scale <= 4,
      let rotation = Int(CommandLine.arguments[3]), [0, 90, 180, 270].contains(rotation),
      let pdf = CGPDFDocument(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL),
      let page = pdf.page(at: 1) else { exit(1) }
let box = page.getBoxRect(.mediaBox)
let sideways = rotation == 90 || rotation == 270
let width = Int(ceil((sideways ? box.height : box.width) * scale))
let height = Int(ceil((sideways ? box.width : box.height) * scale))
guard width > 0, height > 0, width <= 12000, height <= 12000,
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: width, height: height,
          bitsPerComponent: 8, bytesPerRow: width * 4, space: colorSpace,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
context.clear(CGRect(x: 0, y: 0, width: width, height: height))
context.setShouldAntialias(true)
context.interpolationQuality = .high
context.scaleBy(x: scale, y: scale)
// CSS rotates clockwise in its top-left coordinate system; Quartz uses y-up.
switch rotation {
case 90: context.translateBy(x: 0, y: box.width); context.rotate(by: -.pi / 2)
case 180: context.translateBy(x: box.width, y: box.height); context.rotate(by: .pi)
case 270: context.translateBy(x: box.height, y: 0); context.rotate(by: .pi / 2)
default: break
}
context.translateBy(x: -box.minX, y: -box.minY)
context.drawPDFPage(page)
guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(
          URL(fileURLWithPath: CommandLine.arguments[4]) as CFURL,
          UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { exit(1) }
`;

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
  private renderer: Promise<string | null> | null = null;
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
        return { ...JSON.parse(profile.stdout), capabilities: JSON.parse(capabilities.stdout).capabilities, resourceDirectory: dirname(path) };
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
    let left = sizing.leftWidth!, top = sizing.topHeight!;
    const screenWidth = display.width / display.scale, screenHeight = display.height / display.scale;
    let width = screenWidth + left + sizing.rightWidth!;
    let height = screenHeight + top + sizing.bottomHeight!;
    const files: ResolvedBezel["files"] = {};
    const sizes = {} as Record<BezelPart, { width: number; height: number }>;
    const parts: BezelPart[] = typeof images?.composite === "string" ? ["composite"] : [...BEZEL_PARTS];
    for (const part of parts) {
      const asset = images?.[part];
      if (typeof asset !== "string" || basename(asset) !== asset || !/^[\w .-]+$/.test(asset)) return null;
      const path = join(directory, `${asset}.pdf`);
      files[part] = { path, scale: Math.max(2, display.scale) };
      const size = pdfSize(await readFile(path));
      if (!size) return null;
      sizes[part] = size;
    }
    // A composite is already Apple's complete body. Its own page dimensions
    // take precedence over nine-slice sizing: phone11 is 436×908 with a
    // 402×874 opening at (17,17), not a 438×910 body with 18-point insets.
    if (parts[0] === "composite") {
      width = sizes.composite.width;
      height = sizes.composite.height;
      left = (width - screenWidth) / 2;
      top = (height - screenHeight) / 2;
      if (left < 0 || top < 0) return null;
    }
    const layers = parts.map((id) => {
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
    const mask = display.framebufferMaskIdentifier ?? profile?.framebufferMask;
    if (typeof mask === "string" && /^[A-Fa-f0-9-]{36}$/.test(mask)) {
      const roots = [profile!.resourceDirectory, join(this.dependencies.deviceKitRoot ?? "/Library/Developer/DeviceKit", "FramebufferMasks")];
      for (const root of roots) {
        const path = join(root, `${mask}.pdf`);
        const size = await readFile(path).then(pdfSize).catch(() => null);
        if (size && Math.abs(size.width / size.height - screenWidth / screenHeight) < 0.001) {
          files.mask = { path, scale: display.width / size.width };
          break;
        }
      }
    }
    const radius = Math.max(0, Number(display.cornerRadiusUL) || 0);
    return { files, geometry: { source: "xcode", width, height, screen: { x: left, y: top, width: screenWidth, height: screenHeight, cornerRadius: radius, mask: !!files.mask }, layers } };
  }

  private temporaryDirectory(): Promise<string> {
    return this.directory ??= mkdtemp(join(tmpdir(), "bb-device-bezels-"));
  }

  private pdfRenderer(): Promise<string | null> {
    return this.renderer ??= (async () => {
      const directory = await this.temporaryDirectory();
      const source = join(directory, "render-pdf.swift"), binary = join(directory, "render-pdf");
      await writeFile(source, PDF_RENDERER);
      const result = await this.dependencies.exec("xcrun", ["swiftc", "-module-cache-path", join(directory, "module-cache"), "-O", source, "-o", binary], { timeoutMs: 60_000 });
      return result.code === 0 ? binary : null;
    })().catch(() => null);
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

  async image(udid: string, part: string, rotation = 0): Promise<Buffer | null> {
    if (![0, 90, 180, 270].includes(rotation)) return null;
    if (part !== "mask" && part !== "composite" && !BEZEL_PARTS.includes(part as (typeof BEZEL_PARTS)[number])) return null;
    const source = (await this.get(udid))?.files[part as BezelPart | "mask"];
    if (!source || this.disposed) return null;
    const key = `${source.path}:${source.scale}:${rotation}`;
    let image = this.images.get(key);
    if (!image) {
      image = (async () => {
        const renderer = await this.pdfRenderer();
        if (!renderer) return null;
        const path = join(await this.temporaryDirectory(), `${createHash("sha256").update(key).digest("hex")}.png`);
        const result = await this.dependencies.exec(renderer, [source.path, String(source.scale), String(rotation), path], { timeoutMs: 15_000 });
        return result.code === 0 ? readFile(path) : null;
      })().catch(() => null);
      this.images.set(key, image);
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
    const png = await bezels.image(c.req.query("udid") ?? "", c.req.query("part") ?? "", Number(c.req.query("rotation") ?? 0));
    return png ? new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } })
      : c.json({ error: "The local Xcode bezel is unavailable." }, 404);
  });
  bb.onDispose(() => bezels.dispose());
}
