import { describe, expect, it } from "vitest";
import { fitBezel, type DeviceBezel } from "./device-bezel";
import { displayPointToRaw, screenGeometry } from "./screen-geometry";

const RAW = { width: 1206, height: 2622 };
// Deliberately unequal margins expose a reversed rotation or mirrored opening.
const BEZEL: DeviceBezel = {
  source: "xcode", width: 442, height: 930,
  screen: { x: 17, y: 23, width: 402, height: 874, cornerRadius: 62, mask: true },
  layers: [{ id: "composite", x: 0, y: 0, width: 442, height: 930 }],
};

describe("screen orientation geometry", () => {
  it.each([
    { orientation: "portrait", width: 1206, height: 2622, rotation: 0, opening: [17, 23, 402, 874], landmark: { x: 0.25, y: 0.02 } },
    // A native top-edge landmark moves to the LEFT edge when turned right.
    { orientation: "landscape_right", width: 2622, height: 1206, rotation: 270, opening: [23, 23, 874, 402], landmark: { x: 0.02, y: 0.75 } },
    { orientation: "portrait_upside_down", width: 1206, height: 2622, rotation: 180, opening: [23, 33, 402, 874], landmark: { x: 0.75, y: 0.98 } },
    // The same top-edge landmark moves to the RIGHT edge when turned left.
    { orientation: "landscape_left", width: 2622, height: 1206, rotation: 90, opening: [33, 17, 874, 402], landmark: { x: 0.98, y: 0.25 } },
  ])("aligns framebuffer, native opening and a top-edge landmark in $orientation", ({ orientation, width, height, rotation, opening, landmark }) => {
    const geometry = screenGeometry(RAW, orientation);
    expect(geometry).toMatchObject({ width, height, contentRotation: rotation, bodyRotation: rotation });
    const fit = fitBezel({ width: 2000, height: 2000 }, BEZEL, geometry.bodyRotation, 0);
    expect([fit.screenX, fit.screenY, fit.screenWidth, fit.screenHeight].map((value) => value / fit.scale))
      .toEqual(opening);
    const rawPoint = displayPointToRaw(landmark, geometry.contentRotation);
    expect(rawPoint.x).toBeCloseTo(0.25);
    expect(rawPoint.y).toBeCloseTo(0.02);
  });

  it.each(["landscape_left", "landscape_right"])("does not rotate an already-landscape buffer or its input again in %s", (orientation) => {
    const geometry = screenGeometry({ width: 2622, height: 1206 }, orientation);
    expect(geometry).toMatchObject({ width: 2622, height: 1206, contentRotation: 0 });
    expect(geometry.bodyRotation).toBe(orientation === "landscape_left" ? 90 : 270);
    expect(displayPointToRaw({ x: 0.18, y: 0.73 }, geometry.contentRotation)).toEqual({ x: 0.18, y: 0.73 });
  });

  it("retains a half turn for upside-down content and infers landscape without orientation metadata", () => {
    expect(screenGeometry({ width: 2622, height: 1206 }, "portrait_upside_down").contentRotation).toBe(180);
    expect(screenGeometry({ width: 2622, height: 1206 }, undefined))
      .toMatchObject({ width: 2622, height: 1206, landscape: true, contentRotation: 0, bodyRotation: 270 });
  });
});
