import { describe, expect, it } from "vitest";
import {
  HID,
  SHIFT_USAGE,
  decodeHid,
  encodeHid,
  keyEventsForText,
  keyUsageForChar,
  nextOrientation,
  screenConfigFrom,
} from "./sim-protocol";

describe("sim-protocol", () => {
  it("round-trips a HID frame", () => {
    const frame = encodeHid(HID.TOUCH, { type: "begin", x: 0.25, y: 0.5 });
    expect(frame[0]).toBe(3);
    expect(decodeHid(frame)).toEqual({ opcode: 3, payload: { type: "begin", x: 0.25, y: 0.5 } });
  });

  it("maps characters to US keyboard usages", () => {
    expect(keyUsageForChar("a")).toEqual({ usage: 4, shift: false });
    expect(keyUsageForChar("Z")).toEqual({ usage: 29, shift: true });
    expect(keyUsageForChar("1")).toEqual({ usage: 30, shift: false });
    expect(keyUsageForChar("0")).toEqual({ usage: 39, shift: false });
    expect(keyUsageForChar("!")).toEqual({ usage: 30, shift: true });
    expect(keyUsageForChar("?")).toEqual({ usage: 56, shift: true });
    expect(keyUsageForChar("é")).toBeNull();
  });

  it("expands text into shifted down/up sequences and reports unsupported characters", () => {
    const { events, unsupported } = keyEventsForText("Hi\r\né");
    expect(events).toEqual([
      { type: "down", usage: SHIFT_USAGE },
      { type: "down", usage: 11 },
      { type: "up", usage: 11 },
      { type: "up", usage: SHIFT_USAGE },
      { type: "down", usage: 12 },
      { type: "up", usage: 12 },
      { type: "down", usage: 40 },
      { type: "up", usage: 40 },
    ]);
    expect(unsupported).toEqual(["é"]);
  });

  it("cycles orientations clockwise", () => {
    expect(nextOrientation(undefined)).toBe("landscape_right");
    expect(nextOrientation("landscape_right")).toBe("portrait_upside_down");
    expect(nextOrientation("landscape_left")).toBe("portrait");
  });

  it("recognizes screen config frames", () => {
    expect(screenConfigFrom({ width: 393, height: 852, orientation: "portrait" })).toEqual({
      width: 393,
      height: 852,
      orientation: "portrait",
    });
    expect(screenConfigFrom({ width: 0, height: 0 })).toBeNull();
    expect(screenConfigFrom("nope")).toBeNull();
  });
});
