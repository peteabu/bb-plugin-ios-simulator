// Installs the plugin's rebuilt serve-sim capture module (native/
// serve-sim-native.node, built from native/serve-sim with the framebuffer
// polling and shared AVCC encoder patches) over the copy that ships inside
// the serve-sim dependency.
// The original is kept beside it as `.orig` and restored on request.
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PATCHED_SERVE_SIM_VERSION = "0.1.48";

export interface NativePatchStatus {
  /** Our built module exists in the plugin directory. */
  available: boolean;
  /** serve-sim's dist/native currently holds our module. */
  installed: boolean;
  patchedPath: string | null;
  targetPath: string | null;
  detail: string;
}

function sha1(path: string): string {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

/** Where the plugin keeps its rebuilt module, relative to this source file or the dist bundle. */
export function patchedModulePath(importMetaUrl = import.meta.url): string {
  const here = dirname(fileURLToPath(importMetaUrl));
  // server/native-patch.ts → <plugin>/native ; dist/server.js → <plugin>/native
  return join(here, "..", "native", "serve-sim-native.node");
}

export function nativeTargetPath(serveSimEntry: string | null): string | null {
  if (!serveSimEntry) return null;
  return join(dirname(serveSimEntry), "native", "serve-sim-native.node");
}

function compatibleServeSim(serveSimEntry: string | null): boolean {
  if (!serveSimEntry) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(serveSimEntry), "..", "package.json"), "utf8"));
    return manifest.name === "serve-sim" && manifest.version === PATCHED_SERVE_SIM_VERSION;
  } catch {
    return false;
  }
}

export function nativePatchStatus(
  serveSimEntry: string | null,
  options: { importMetaUrl?: string } = {},
): NativePatchStatus {
  const patchedPath = patchedModulePath(options.importMetaUrl);
  const targetPath = nativeTargetPath(serveSimEntry);
  const available = existsSync(patchedPath);
  if (!available) {
    return { available, installed: false, patchedPath, targetPath, detail: "no rebuilt capture module in native/" };
  }
  if (!compatibleServeSim(serveSimEntry)) {
    return {
      available, installed: false, patchedPath, targetPath: null,
      detail: `capture patch requires a verified serve-sim ${PATCHED_SERVE_SIM_VERSION} package`,
    };
  }
  if (!targetPath || !existsSync(targetPath)) {
    return { available, installed: false, patchedPath, targetPath: null, detail: "serve-sim native module not found" };
  }
  const installed = sha1(patchedPath) === sha1(targetPath);
  return {
    available,
    installed,
    patchedPath,
    targetPath,
    detail: installed ? "patched capture installed" : "original serve-sim capture in place",
  };
}

/** Copy our module over serve-sim's, keeping the first original as `.orig`. Returns true when a copy happened. */
export function installNativePatch(
  serveSimEntry: string | null,
  options: { importMetaUrl?: string; log?: (message: string) => void } = {},
): boolean {
  const status = nativePatchStatus(serveSimEntry, options);
  if (!status.available || !status.targetPath || status.installed) return false;
  const backup = `${status.targetPath}.orig`;
  if (!existsSync(backup)) copyFileSync(status.targetPath, backup);
  copyFileSync(status.patchedPath!, status.targetPath);
  const size = statSync(status.targetPath).size;
  options.log?.(`installed patched serve-sim capture module (${size} bytes) over ${status.targetPath}`);
  return true;
}

export function restoreOriginalNative(serveSimEntry: string | null): boolean {
  if (!compatibleServeSim(serveSimEntry)) return false;
  const target = nativeTargetPath(serveSimEntry);
  if (!target) return false;
  const backup = `${target}.orig`;
  if (!existsSync(backup)) return false;
  copyFileSync(backup, target);
  return true;
}
