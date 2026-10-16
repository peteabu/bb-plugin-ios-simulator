import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Same location from server/*.ts and the built dist/server.js. */
export function guestPasteboardHelperPath(importMetaUrl = import.meta.url): string | null {
  const helper = join(dirname(fileURLToPath(importMetaUrl)), "..", "native", "simulator-pasteboard");
  return existsSync(helper) ? helper : null;
}
