// Geometry only. Apple artwork stays in the host's DeviceKit installation.
import type { Rotation } from "./screen-geometry";

export const BEZEL_PARTS = [
  "topLeft", "top", "topRight", "right", "bottomRight", "bottom", "bottomLeft", "left",
] as const;
export type BezelPart = (typeof BEZEL_PARTS)[number] | "composite";
/** Bumps image URLs so previously cached 72dpi artwork is not reused. */
export const BEZEL_ASSET_VERSION = 3;

export interface DeviceBezel {
  source: "xcode";
  width: number;
  height: number;
  screen: { x: number; y: number; width: number; height: number; cornerRadius: number; mask?: boolean };
  layers: Array<{ id: BezelPart; x: number; y: number; width: number; height: number }>;
}

export function isDeviceBezel(value: unknown): value is DeviceBezel {
  if (!value || typeof value !== "object") return false;
  const frame = value as DeviceBezel;
  const positive = (number: unknown) => typeof number === "number" && Number.isFinite(number) && number > 0;
  return frame.source === "xcode" && positive(frame.width) && positive(frame.height)
    && !!frame.screen && [frame.screen.x, frame.screen.y, frame.screen.cornerRadius].every((number) =>
      typeof number === "number" && Number.isFinite(number) && number >= 0)
    && positive(frame.screen.width) && positive(frame.screen.height)
    && frame.screen.x + frame.screen.width <= frame.width
    && frame.screen.y + frame.screen.height <= frame.height
    && (frame.screen.mask === undefined || typeof frame.screen.mask === "boolean")
    && Array.isArray(frame.layers)
    && (frame.layers.length === BEZEL_PARTS.length || (frame.layers.length === 1 && frame.layers[0]?.id === "composite"))
    && frame.layers.every((layer) => (layer.id === "composite" || BEZEL_PARTS.includes(layer.id))
      && [layer.x, layer.y].every((number) => typeof number === "number" && Number.isFinite(number))
      && positive(layer.width) && positive(layer.height));
}

/** Rotate the native artwork and its screen opening together. */
export function fitBezel(
  box: { width: number; height: number },
  bezel: DeviceBezel,
  angle: Rotation,
  padding = 16,
) {
  const landscape = angle === 90 || angle === 270;
  const width = landscape ? bezel.height : bezel.width;
  const height = landscape ? bezel.width : bezel.height;
  const scale = Math.max(0, Math.min((box.width - padding * 2) / width, (box.height - padding * 2) / height));
  const screen = bezel.screen;
  const x = angle === 90 ? bezel.height - screen.y - screen.height
    : angle === 180 ? bezel.width - screen.x - screen.width : angle === 270 ? screen.y : screen.x;
  const y = angle === 90 ? screen.x : angle === 180 ? bezel.height - screen.y - screen.height
    : angle === 270 ? bezel.width - screen.x - screen.width : screen.y;
  return {
    angle, scale,
    frameWidth: width * scale, frameHeight: height * scale,
    bodyWidth: bezel.width * scale, bodyHeight: bezel.height * scale,
    screenX: x * scale, screenY: y * scale,
    screenWidth: (landscape ? screen.height : screen.width) * scale,
    screenHeight: (landscape ? screen.width : screen.height) * scale,
    screenRadius: screen.cornerRadius * scale,
  };
}
