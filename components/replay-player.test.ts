// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplayPlayer, replaySeekIndex } from "./replay-player";
import type { ReplayClip } from "../lib/session-types";

const CLIP: ReplayClip = {
  id: "clip_1", udid: "device", threadId: "thr_1", createdAt: 1700, startAt: 1000, endAt: 1600, frameCount: 6,
  description: "AWQAHg==", events: [],
  frames: [800, 900, 1000, 1200, 1400, 1600].map((at) => ({
    at, key: at === 800 || at === 1400, data: "BQ==",
    config: { width: 1206, height: 2622, orientation: at === 1200 ? "landscape_right" : "portrait" },
  })),
};

function viewer(clip = CLIP, options: { asyncDecode?: boolean; stuck?: boolean; stuckFlush?: boolean } = {}) {
  const frames: Array<{ timestamp: number; displayWidth: number; displayHeight: number; close: ReturnType<typeof vi.fn> }> = [];
  const chunks: EncodedVideoChunkInit[] = [];
  const decoders: Decoder[] = [];
  let maxQueue = 0;
  let openFrames = 0;
  let maxOpenFrames = 0;
  class Decoder extends EventTarget {
    static isConfigSupported = vi.fn(async () => ({ supported: true }));
    state = "unconfigured";
    decodeQueueSize = 0;
    keyRequired = true;
    stuck = options.stuck ?? false;
    queue: EncodedVideoChunkInit[] = [];
    timer: ReturnType<typeof setTimeout> | null = null;
    pendingFlush: Array<{ resolve(): void; reject(error: Error): void }> = [];
    close = vi.fn(() => {
      this.state = "closed";
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      for (const pending of this.pendingFlush.splice(0)) pending.reject(new DOMException("Closed", "AbortError"));
    });
    configure = vi.fn(() => { this.state = "configured"; this.keyRequired = true; });
    flushWork = vi.fn(() => options.stuckFlush || this.decodeQueueSize
      ? new Promise<void>((resolve, reject) => this.pendingFlush.push({ resolve, reject })) : Promise.resolve());
    flush() { this.keyRequired = true; return this.flushWork(); }
    constructor(readonly callbacks: VideoDecoderInit) { super(); decoders.push(this); }
    decode(chunk: EncodedVideoChunkInit) {
      if (this.state !== "configured") throw new DOMException("Not configured", "InvalidStateError");
      if (this.keyRequired && chunk.type !== "key") throw new DOMException("A key chunk is required after configure or flush", "DataError");
      this.keyRequired = false;
      chunks.push(chunk);
      if (!options.asyncDecode) { this.output(chunk.timestamp); return; }
      this.queue.push(chunk); this.decodeQueueSize++;
      maxQueue = Math.max(maxQueue, this.decodeQueueSize);
      if (this.timer === null && !this.stuck) this.timer = setTimeout(() => {
        this.timer = null;
        if (this.state === "closed" || this.stuck) return;
        for (const pending of this.queue.splice(0)) {
          this.decodeQueueSize--; this.dispatchEvent(new Event("dequeue")); this.output(pending.timestamp);
        }
        if (!options.stuckFlush) for (const pending of this.pendingFlush.splice(0)) pending.resolve();
      }, 0);
    }
    output(timestamp: number) {
      openFrames++; maxOpenFrames = Math.max(maxOpenFrames, openFrames);
      const frame = { timestamp, displayWidth: 1206, displayHeight: 2622, close: vi.fn(() => { openFrames--; }) };
      frames.push(frame); this.callbacks.output(frame as unknown as VideoFrame);
    }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", class { constructor(init: EncodedVideoChunkInit) { Object.assign(this, init); } });
  const drawImage = vi.fn();
  const rotate = vi.fn();
  const canvas = { width: 300, height: 150, clientWidth: 300,
    getContext: () => ({ save() {}, restore() {}, translate() {}, clearRect() {}, rotate, drawImage }) };
  const callbacks = { onTime: vi.fn(), onError: vi.fn(), onEnded: vi.fn() };
  const animationFrames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let clock = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { animationFrames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => animationFrames.delete(key));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const player = createReplayPlayer(canvas as unknown as HTMLCanvasElement, clip, callbacks);
  const tick = (now: number) => {
    clock = now;
    const pending = [...animationFrames.values()]; animationFrames.clear();
    for (const callback of pending) callback(now);
  };
  return { player, frames, chunks, decoders, callbacks, drawImage, rotate, canvas, animationFrames, tick,
    get maxQueue() { return maxQueue; }, get maxOpenFrames() { return maxOpenFrames; }, get openFrames() { return openFrames; } };
}

describe("saved replay playback", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("seeks from the nearest preceding keyframe and skips preroll output", async () => {
    const view = viewer();
    expect(replaySeekIndex(CLIP, 1500)).toBe(4);
    await view.player.seek(1000);
    expect(view.chunks.map((chunk) => chunk.timestamp)).toEqual([0, 100_000, 200_000]);
    expect(view.drawImage).toHaveBeenCalledTimes(1);
    expect(view.drawImage.mock.calls[0]![0]).toBe(view.frames[2]);
    expect(view.frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
    await view.player.seek(1500);
    expect(view.chunks.at(-1)?.type).toBe("key");
    expect(view.chunks.at(-1)?.timestamp).toBe(600_000);
    expect(view.decoders[0]!.close).toHaveBeenCalledTimes(1);
    view.player.dispose();
  });

  it("uses recorded time gaps rather than a fixed frame rate, including recorded orientation", async () => {
    const view = viewer();
    await view.player.seek(1000);
    await view.player.play();
    const primed = view.chunks.length;
    view.tick(199);
    expect(view.chunks).toHaveLength(primed);
    view.tick(200);
    expect(view.chunks.at(-1)?.timestamp).toBe(400_000);
    expect(view.callbacks.onTime).toHaveBeenLastCalledWith(1200);
    expect(view.rotate).toHaveBeenLastCalledWith(3 * Math.PI / 2);
    expect(view.canvas.width).toBeGreaterThan(view.canvas.height);
    view.player.dispose();
  });

  it("starts on the first visible sample when the window begins between frames", async () => {
    const view = viewer({ ...CLIP, startAt: 1010 });
    await view.player.seek(1010);
    expect(view.callbacks.onTime).toHaveBeenLastCalledWith(1200);
    expect(view.drawImage).toHaveBeenCalledTimes(1);
    expect(view.drawImage.mock.calls[0]![0].timestamp).toBe(400_000);
    expect(view.frames.slice(0, 3).every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
    view.player.dispose();
  });

  it("closes decoder/frames and cancels scheduling, rejecting late output after disposal", async () => {
    const view = viewer();
    await view.player.seek(1000);
    await view.player.play();
    view.player.dispose();
    expect(view.animationFrames.size).toBe(0);
    expect(view.decoders.every((decoder) => decoder.close.mock.calls.length === 1)).toBe(true);
    const paints = view.drawImage.mock.calls.length;
    view.decoders.at(-1)!.output(200_000);
    expect(view.frames.at(-1)!.close).toHaveBeenCalledTimes(1);
    expect(view.drawImage).toHaveBeenCalledTimes(paints);
    view.tick(600);
    expect(view.callbacks.onEnded).not.toHaveBeenCalled();
  });

  it("ignores an old end-of-play flush rejection after seeking to another position", async () => {
    const view = viewer();
    await view.player.seek(1000);
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    await view.player.play();
    view.decoders.at(-1)!.flushWork.mockImplementationOnce(() => pending);
    view.tick(600);
    await view.player.seek(1400);
    reject(new Error("old decoder was closed"));
    await Promise.resolve(); await Promise.resolve();
    expect(view.callbacks.onError).not.toHaveBeenCalled();
    expect(view.decoders.at(-1)!.close).not.toHaveBeenCalled();
    view.player.dispose();
  });

  it("seeks through a long GOP with bounded dequeue backpressure, then restarts from key before Play", async () => {
    const clip = { ...CLIP, endAt: 2200, frameCount: 80, frames: Array.from({ length: 80 }, (_, index) => ({
      at: 800 + index * 16, key: index === 0, data: "BQ==", config: CLIP.frames[0]!.config,
    })) };
    const view = viewer(clip, { asyncDecode: true });
    await view.player.seek(1700);
    expect(view.maxQueue).toBe(24);
    expect(view.maxOpenFrames).toBeLessThanOrEqual(2);
    expect(view.decoders[0]!.flushWork).toHaveBeenCalledTimes(1);
    expect(() => view.decoders[0]!.decode({ type: "delta", timestamp: 999, data: new Uint8Array([1]) })).toThrow(/key chunk is required/);
    const beforePlay = view.chunks.length;
    await view.player.play();
    expect(view.chunks[beforePlay]?.type).toBe("key");
    expect(view.decoders).toHaveLength(2);
    expect(view.decoders[1]!.flushWork).not.toHaveBeenCalled();
    view.tick(16);
    expect(view.chunks.at(-1)?.type).toBe("delta");
    expect(view.callbacks.onError).not.toHaveBeenCalled();
    view.player.dispose();
    expect(view.openFrames).toBe(0);
  });

  it("continues the same unflushed decoder across pause/resume and drains only at the end", async () => {
    const view = viewer();
    await view.player.seek(1000);
    await view.player.play();
    const active = view.decoders.at(-1)!;
    view.tick(200);
    view.player.pause();
    await view.player.play();
    expect(view.decoders.at(-1)).toBe(active);
    view.tick(400);
    view.tick(600);
    await Promise.resolve(); await Promise.resolve();
    expect(active.flushWork).toHaveBeenCalledTimes(1);
    expect(view.callbacks.onEnded).toHaveBeenCalledTimes(1);
    expect(view.callbacks.onError).not.toHaveBeenCalled();
    expect(view.animationFrames.size).toBe(0);
    view.player.dispose();
  });

  it("keeps the seek still while asynchronous resume preroll catches up to its anchor", async () => {
    const clip = { ...CLIP, endAt: 2200, frameCount: 80, frames: Array.from({ length: 80 }, (_, index) => ({
      at: 800 + index * 16, key: index === 0, data: "BQ==", config: CLIP.frames[0]!.config,
    })) };
    const view = viewer(clip, { asyncDecode: true });
    const anchor = clip.frames[56]!.at;
    await view.player.seek(anchor);
    const beforePlay = view.drawImage.mock.calls.length;
    await view.player.play();
    // Earlier batches have produced output while the tail of the GOP is
    // still queued. They must not repaint the canvas behind the seek still.
    const timestamps = () => view.drawImage.mock.calls.slice(beforePlay).map(([frame]) => frame.timestamp);
    expect(timestamps().every((timestamp) => timestamp >= 896_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.tick(16);
    expect(timestamps().length).toBeGreaterThan(0);
    expect(timestamps().every((timestamp) => timestamp >= 896_000)).toBe(true);
    expect(view.callbacks.onError).not.toHaveBeenCalled();
    view.player.dispose();
  });

  it.each(["capacity", "output fence"])("times out a stalled %s instead of hanging a seek", async (phase) => {
    vi.useFakeTimers();
    const clip = { ...CLIP, endAt: 2000, frameCount: 40, frames: Array.from({ length: 40 }, (_, index) => ({
      at: 800 + index * 16, key: index === 0, data: "BQ==", config: CLIP.frames[0]!.config,
    })) };
    const view = viewer(clip, phase === "capacity" ? { asyncDecode: true, stuck: true } : { stuckFlush: true });
    const seeking = view.player.seek(1400);
    await vi.advanceTimersByTimeAsync(5001);
    await seeking;
    expect(view.callbacks.onError).toHaveBeenCalledExactlyOnceWith("Replay decoder stopped making progress.");
    expect(view.decoders[0]!.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    view.player.dispose();
  });

  it("cancels a capacity wait immediately when the player is disposed", async () => {
    vi.useFakeTimers();
    const clip = { ...CLIP, endAt: 2000, frameCount: 40, frames: Array.from({ length: 40 }, (_, index) => ({
      at: 800 + index * 16, key: index === 0, data: "BQ==", config: CLIP.frames[0]!.config,
    })) };
    const view = viewer(clip, { asyncDecode: true, stuck: true });
    const seeking = view.player.seek(1400);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.maxQueue).toBe(24);
    view.player.dispose();
    await seeking;
    expect(view.callbacks.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops playback if its full decode queue stalls instead of scheduling forever", async () => {
    const clip = { ...CLIP, endAt: 2200, frameCount: 80, frames: Array.from({ length: 80 }, (_, index) => ({
      at: 800 + index * 16, key: index === 0, data: "BQ==", config: CLIP.frames[0]!.config,
    })) };
    const view = viewer(clip, { asyncDecode: true });
    await view.player.seek(1000);
    await view.player.play();
    view.decoders.at(-1)!.stuck = true;
    view.tick(16);
    view.tick(5017);
    expect(view.callbacks.onError).toHaveBeenCalledExactlyOnceWith("Replay decoder stopped making progress.");
    expect(view.animationFrames.size).toBe(0);
    view.player.dispose();
  });
});
