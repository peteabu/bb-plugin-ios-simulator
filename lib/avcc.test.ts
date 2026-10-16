import { describe, expect, it } from "vitest";
import { AVCC_TAG, codecStringFromAvcc, concatBytes, parseAvccRecords } from "./avcc";

function record(tag: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

describe("avcc records", () => {
  it("parses complete records and keeps a partial tail", () => {
    const stream = concatBytes(
      concatBytes(record(AVCC_TAG.DESCRIPTION, [1, 0x64, 0, 0x1f]), record(AVCC_TAG.KEYFRAME, [9, 9])),
      new Uint8Array([0, 0, 0, 5, AVCC_TAG.DELTA]), // length says 4 payload bytes, only tag arrived
    );
    const { records, rest } = parseAvccRecords(stream);
    expect(records.map((entry) => entry.tag)).toEqual([AVCC_TAG.DESCRIPTION, AVCC_TAG.KEYFRAME]);
    expect([...records[1]!.payload]).toEqual([9, 9]);
    expect(rest.length).toBe(5);
    const { records: more, rest: tail } = parseAvccRecords(concatBytes(rest, new Uint8Array([1, 2, 3, 4])));
    expect(more).toHaveLength(1);
    expect([...more[0]!.payload]).toEqual([1, 2, 3, 4]);
    expect(tail.length).toBe(0);
  });

  it("derives the WebCodecs codec string from the avcC header", () => {
    expect(codecStringFromAvcc(new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff]))).toBe("avc1.64001f");
    expect(codecStringFromAvcc(new Uint8Array([1, 0x42, 0xe0, 0x1e]))).toBe("avc1.42e01e");
  });

  it("rejects corrupt lengths", () => {
    expect(() => parseAvccRecords(new Uint8Array([0, 0, 0, 0, 1]))).toThrow(/Corrupt/);
  });
});
