export type Rotation = 0 | 90 | 180 | 270;
interface Size { width: number; height: number }
interface Point { x: number; y: number }

/** The helper can keep a portrait framebuffer after the device rotates. */
export function screenGeometry(raw: Size, orientation: string | undefined) {
  const rawLandscape = raw.width > raw.height;
  const landscape = rawLandscape || orientation === "landscape_left" || orientation === "landscape_right";
  const short = Math.min(raw.width, raw.height);
  const long = Math.max(raw.width, raw.height);
  const bodyRotation: Rotation = landscape ? (orientation === "landscape_left" ? 90 : 270)
    : orientation === "portrait_upside_down" ? 180 : 0;
  // Already-landscape buffers are oriented by the helper. Do not rotate them
  // or their input coordinates again; upside-down still needs a half turn.
  const contentRotation: Rotation = orientation === "portrait_upside_down" ? 180
    : !rawLandscape && orientation === "landscape_right" ? 270
    : !rawLandscape && orientation === "landscape_left" ? 90 : 0;
  return {
    width: landscape ? long : short,
    height: landscape ? short : long,
    landscape,
    bodyRotation,
    contentRotation,
  };
}

/** Inverse of the CSS framebuffer rotation, for taps and every swipe point. */
export function displayPointToRaw(point: Point, contentRotation: Rotation): Point {
  switch (contentRotation) {
    case 270: return { x: 1 - point.y, y: point.x };
    case 90: return { x: point.y, y: 1 - point.x };
    case 180: return { x: 1 - point.x, y: 1 - point.y };
    default: return point;
  }
}
