// Parser for serve-sim's `/stream.avcc` wire format (documented in its
// Sources/SimNative/StreamFormat.swift): every record is a 4-byte big-endian
// length covering a 1-byte tag plus payload. Tags: 1 = avcC decoder
// description, 2 = H.264 keyframe, 3 = delta frame, 4 = seed JPEG painted
// before the first keyframe. Pure module shared by tests and the panel.

export const AVCC_TAG = {
  DESCRIPTION: 1,
  KEYFRAME: 2,
  DELTA: 3,
  SEED_JPEG: 4,
} as const;

export interface AvccRecord {
  tag: number;
  payload: Uint8Array;
}

/** Split complete records off the front of `buffer`; `rest` holds the partial tail. */
export function parseAvccRecords(buffer: Uint8Array): { records: AvccRecord[]; rest: Uint8Array } {
  const records: AvccRecord[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 4);
    const length = view.getUint32(0, false);
    if (length < 1 || length > 64 * 1024 * 1024) {
      throw new Error(`Corrupt AVCC record length ${length}`);
    }
    if (buffer.length - offset < 4 + length) break;
    records.push({
      tag: buffer[offset + 4]!,
      payload: buffer.slice(offset + 5, offset + 4 + length),
    });
    offset += 4 + length;
  }
  return { records, rest: buffer.slice(offset) };
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** WebCodecs codec string from an avcC blob: profile, constraints, level bytes. */
export function codecStringFromAvcc(avcc: Uint8Array): string {
  if (avcc.length < 4) throw new Error("avcC description too short");
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return `avc1.${hex(avcc[1]!)}${hex(avcc[2]!)}${hex(avcc[3]!)}`;
}
