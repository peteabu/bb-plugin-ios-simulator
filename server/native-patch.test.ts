import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { installNativePatch, nativePatchStatus, restoreOriginalNative } from "./native-patch";

function fixture(version = "0.1.48") {
  const root = mkdtempSync(join(tmpdir(), "native-patch-"));
  mkdirSync(join(root, "plugin", "server"), { recursive: true });
  mkdirSync(join(root, "plugin", "native"), { recursive: true });
  mkdirSync(join(root, "plugin", "node_modules", "serve-sim", "dist", "native"), { recursive: true });
  const entry = join(root, "plugin", "node_modules", "serve-sim", "dist", "serve-sim.js");
  const target = join(root, "plugin", "node_modules", "serve-sim", "dist", "native", "serve-sim-native.node");
  const manifest = join(root, "plugin", "node_modules", "serve-sim", "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "serve-sim", version }));
  writeFileSync(entry, "// cli");
  writeFileSync(target, "ORIGINAL");
  const importMetaUrl = pathToFileURL(join(root, "plugin", "server", "native-patch.ts")).href;
  return { root, entry, target, manifest, importMetaUrl, patched: join(root, "plugin", "native", "serve-sim-native.node") };
}

describe("native capture patch installer", () => {
  it("does nothing without a rebuilt module", () => {
    const f = fixture();
    expect(installNativePatch(f.entry, { importMetaUrl: f.importMetaUrl })).toBe(false);
    expect(nativePatchStatus(f.entry, { importMetaUrl: f.importMetaUrl })).toMatchObject({ available: false, installed: false });
    expect(readFileSync(f.target, "utf8")).toBe("ORIGINAL");
  });

  it("installs once, keeps the original, and restores it", () => {
    const f = fixture();
    writeFileSync(f.patched, "PATCHED");
    const logs: string[] = [];
    expect(installNativePatch(f.entry, { importMetaUrl: f.importMetaUrl, log: (m) => logs.push(m) })).toBe(true);
    expect(readFileSync(f.target, "utf8")).toBe("PATCHED");
    expect(readFileSync(`${f.target}.orig`, "utf8")).toBe("ORIGINAL");
    expect(logs[0]).toMatch(/installed patched/);
    expect(installNativePatch(f.entry, { importMetaUrl: f.importMetaUrl })).toBe(false); // idempotent
    expect(nativePatchStatus(f.entry, { importMetaUrl: f.importMetaUrl })).toMatchObject({ available: true, installed: true });
    expect(restoreOriginalNative(f.entry)).toBe(true);
    expect(readFileSync(f.target, "utf8")).toBe("ORIGINAL");
  });

  it.each(["0.1.47", "0.1.49", "1.0.0"])("never overwrites serve-sim %s", (version) => {
    const f = fixture(version);
    writeFileSync(f.patched, "PATCHED");
    writeFileSync(`${f.target}.orig`, "OLDER ORIGINAL");
    expect(installNativePatch(f.entry, { importMetaUrl: f.importMetaUrl })).toBe(false);
    expect(restoreOriginalNative(f.entry)).toBe(false);
    expect(nativePatchStatus(f.entry, { importMetaUrl: f.importMetaUrl })).toMatchObject({
      installed: false, targetPath: null, detail: expect.stringContaining("0.1.48"),
    });
    expect(readFileSync(f.target, "utf8")).toBe("ORIGINAL");
  });

  it.each(["missing", "invalid", "different-package"])("requires a verified manifest: %s", (kind) => {
    const f = fixture();
    writeFileSync(f.patched, "PATCHED");
    if (kind === "missing") rmSync(f.manifest);
    else writeFileSync(f.manifest, kind === "invalid" ? "{" : JSON.stringify({ name: "another-package", version: "0.1.48" }));
    expect(installNativePatch(f.entry, { importMetaUrl: f.importMetaUrl })).toBe(false);
    expect(readFileSync(f.target, "utf8")).toBe("ORIGINAL");
    expect(existsSync(`${f.target}.orig`)).toBe(false);
  });

  it("does nothing when the dependency has no native target", () => {
    const f = fixture();
    writeFileSync(f.patched, "PATCHED");
    rmSync(f.target);
    expect(installNativePatch(f.entry, { importMetaUrl: f.importMetaUrl })).toBe(false);
    expect(existsSync(`${f.target}.orig`)).toBe(false);
  });
});
