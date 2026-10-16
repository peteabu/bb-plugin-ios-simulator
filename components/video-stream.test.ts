// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVideoStream } from "./video-stream";

function record(tag: number, payload: number[]) {
  const bytes = new Uint8Array(payload.length + 5);
  new DataView(bytes.buffer).setUint32(0, payload.length + 1);
  bytes[4] = tag;
  bytes.set(payload, 5);
  return bytes;
}

function viewer() {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
  const drawImage = vi.fn();
  const context = { drawImage, imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
  const canvas = { width: 300, height: 150, clientWidth: 300, getContext: vi.fn(() => context) };
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationFrames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => animationFrames.delete(id));
  const frames: Array<{ displayWidth: number; displayHeight: number; close: ReturnType<typeof vi.fn> }> = [];
  const decoders: Decoder[] = [];
  class Decoder {
    static isConfigSupported = vi.fn(async () => ({ supported: true }));
    state = "unconfigured";
    decodeQueueSize = 0;
    close = vi.fn(() => { this.state = "closed"; });
    configure = vi.fn(() => { this.state = "configured"; });
    constructor(readonly callbacks: VideoDecoderInit) { decoders.push(this); }
    decode() { this.output(); }
    output() {
      const frame = { displayWidth: 1206, displayHeight: 2622, close: vi.fn() };
      frames.push(frame);
      this.callbacks.output(frame as unknown as VideoFrame);
    }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", class { constructor(_init: EncodedVideoChunkInit) {} });
  const fetch = vi.fn(async () => ({ ok: true, body }));
  vi.stubGlobal("fetch", fetch);
  const callbacks = { onFallback: vi.fn(), onDisconnect: vi.fn() };
  const handle = startVideoStream("/test-video", canvas as unknown as HTMLCanvasElement, callbacks);
  const sendFrame = async () => {
    upstream.enqueue(record(1, [1, 100, 0, 30]));
    upstream.enqueue(record(2, [5]));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { handle, upstream, canvas, context, drawImage, animationFrames, frames, decoders, callbacks, fetch, sendFrame };
}

describe("video viewer presentation and cleanup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("paints complete synchronized frames with smoothing at display resolution", async () => {
    const view = viewer();
    await view.sendFrame();
    expect(view.canvas.getContext).toHaveBeenCalledWith("2d", { alpha: false });
    for (const paint of view.animationFrames.values()) paint(0);
    expect(view.drawImage).toHaveBeenCalledTimes(1);
    expect(view.context.imageSmoothingEnabled).toBe(true);
    expect(view.context.imageSmoothingQuality).toBe("high");
    expect(view.frames[0]!.close).toHaveBeenCalledTimes(1);
    view.handle.stop();
  });

  it("closes the decoder, pending frame, timer and transport before reconnecting", async () => {
    const view = viewer();
    await view.sendFrame();
    view.upstream.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(view.callbacks.onDisconnect).toHaveBeenCalledExactlyOnceWith("stream ended");
    expect(view.decoders[0]!.close).toHaveBeenCalledTimes(1);
    expect(view.frames[0]!.close).toHaveBeenCalledTimes(1);
    expect(view.animationFrames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(view.fetch.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("discards decoder output arriving after stop without scheduling another paint", async () => {
    const view = viewer();
    await view.sendFrame();
    view.handle.stop();
    view.decoders[0]!.output();
    expect(view.frames[1]!.close).toHaveBeenCalledTimes(1);
    expect(view.animationFrames.size).toBe(0);
    expect(view.callbacks.onDisconnect).not.toHaveBeenCalled();
  });
});
