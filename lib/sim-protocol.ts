// Wire protocol shared by the backend relay and the panel: the binary HID
// frames serve-sim's helper accepts on `/helper/<udid>/ws`. Each frame is one
// opcode byte followed by UTF-8 JSON. Pure module: no Node or DOM imports.

export const HID = {
  TOUCH: 3,
  BUTTON: 4,
  MULTI_TOUCH: 5,
  KEY: 6,
  ORIENTATION: 7,
  CA_DEBUG: 8,
  MEMORY_WARNING: 9,
  /** {width,height}: re-selects the framebuffer and forces an immediate capture. */
  PREFERRED_SIZE: 13,
} as const;

export type TouchPhase = "begin" | "move" | "end";

export interface TouchMessage {
  type: TouchPhase;
  /** Normalized 0..1 across the streamed screen. */
  x: number;
  y: number;
  edge?: number;
}

export interface ScreenConfig {
  width: number;
  height: number;
  orientation?: string;
}

export function encodeHid(opcode: number, payload: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = opcode;
  out.set(json, 1);
  return out;
}

export function decodeHid(
  data: Uint8Array,
): { opcode: number; payload: unknown } | null {
  if (data.length < 1) return null;
  const opcode = data[0]!;
  if (data.length === 1) return { opcode, payload: null };
  try {
    return {
      opcode,
      payload: JSON.parse(new TextDecoder().decode(data.subarray(1))),
    };
  } catch {
    return { opcode, payload: null };
  }
}

/** A frame from the helper that carries the current screen size. */
export function screenConfigFrom(payload: unknown): ScreenConfig | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.width !== "number" ||
    typeof candidate.height !== "number" ||
    candidate.width <= 0 ||
    candidate.height <= 0
  ) {
    return null;
  }
  return {
    width: candidate.width,
    height: candidate.height,
    ...(typeof candidate.orientation === "string"
      ? { orientation: candidate.orientation }
      : {}),
  };
}

export const HARDWARE_BUTTONS = {
  home: { button: "home" },
  lock: { button: "power", page: 12, usage: 48 },
  power: { button: "power", page: 12, usage: 48 },
  "volume-up": { button: "volume-up", page: 12, usage: 233 },
  "volume-down": { button: "volume-down", page: 12, usage: 234 },
  action: { button: "action", page: 11, usage: 45 },
  "side-button": { button: "side-button", page: 12, usage: 149 },
} as const;
export type HardwareButton = keyof typeof HARDWARE_BUTTONS;
export const HARDWARE_BUTTON_NAMES = Object.keys(
  HARDWARE_BUTTONS,
) as HardwareButton[];

export const ORIENTATIONS = [
  "portrait",
  "portrait_upside_down",
  "landscape_left",
  "landscape_right",
] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export function nextOrientation(current: string | undefined): Orientation {
  const order: Orientation[] = [
    "portrait",
    "landscape_right",
    "portrait_upside_down",
    "landscape_left",
  ];
  const index = order.indexOf((current ?? "portrait") as Orientation);
  return order[(index + 1) % order.length]!;
}

// USB HID keyboard usage ids (usage page 7) for a US layout.
export const SHIFT_USAGE = 225;
const SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
  "*": "8", "(": "9", ")": "0", _: "-", "+": "=", "{": "[", "}": "]",
  "|": "\\", ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
};
const PUNCTUATION: Record<string, number> = {
  "-": 45, "=": 46, "[": 47, "]": 48, "\\": 49, ";": 51, "'": 52, "`": 53,
  ",": 54, ".": 55, "/": 56, " ": 44, "\n": 40, "\t": 43,
};
export const KEY_USAGE_BY_NAME: Record<string, number> = {
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Delete: 76,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
};

export function keyUsageForChar(
  char: string,
): { usage: number; shift: boolean } | null {
  if (char.length !== 1) return null;
  if (char >= "a" && char <= "z") {
    return { usage: 4 + char.charCodeAt(0) - 97, shift: false };
  }
  if (char >= "A" && char <= "Z") {
    return { usage: 4 + char.charCodeAt(0) - 65, shift: true };
  }
  if (char >= "1" && char <= "9") {
    return { usage: 30 + char.charCodeAt(0) - 49, shift: false };
  }
  if (char === "0") return { usage: 39, shift: false };
  if (char in PUNCTUATION) return { usage: PUNCTUATION[char]!, shift: false };
  if (char in SHIFTED) {
    const base = keyUsageForChar(SHIFTED[char]!);
    return base ? { usage: base.usage, shift: true } : null;
  }
  return null;
}

export interface KeyEvent {
  type: "down" | "up";
  usage: number;
}

/** Expand text into the key down/up sequence serve-sim types with. */
export function keyEventsForText(text: string): {
  events: KeyEvent[];
  unsupported: string[];
} {
  const events: KeyEvent[] = [];
  const unsupported: string[] = [];
  for (const char of text) {
    if (char === "\r") continue;
    const key = keyUsageForChar(char);
    if (!key) {
      if (!unsupported.includes(char)) unsupported.push(char);
      continue;
    }
    if (key.shift) events.push({ type: "down", usage: SHIFT_USAGE });
    events.push({ type: "down", usage: key.usage });
    events.push({ type: "up", usage: key.usage });
    if (key.shift) events.push({ type: "up", usage: SHIFT_USAGE });
  }
  return { events, unsupported };
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
