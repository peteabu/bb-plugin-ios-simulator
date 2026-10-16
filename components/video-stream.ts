// Low-latency viewer for the plugin's `/video` route: parses serve-sim's
// AVCC records, decodes them with WebCodecs, and paints the newest frame once
// per display refresh. Reports failure so the panel can fall back to MJPEG.
import { AVCC_TAG, codecStringFromAvcc, concatBytes, parseAvccRecords } from "@/lib/avcc";

export interface VideoStreamHandle {
  stop(): void;
}

export interface VideoStats {
  codec: string | null;
  /** Frames the decoder produced in the last window, per second. */
  decodedFps: number;
  /** Frames actually painted in the last window, per second. */
  paintedFps: number;
  /** Encoded chunks waiting in the decoder. */
  queue: number;
  /** Milliseconds since the last painted frame. */
  frameAgeMs: number;
  width: number;
  height: number;
  bytesPerSecond: number;
}

export interface VideoStreamCallbacks {
  onFirstFrame?(): void;
  onSize?(width: number, height: number): void;
  onStats?(stats: VideoStats): void;
  /** Unrecoverable for this client; caller should fall back to MJPEG. */
  onFallback(reason: string): void;
  /** Stream ended or errored but WebCodecs works; caller may reconnect. */
  onDisconnect(reason: string): void;
}

export function webCodecsAvailable(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

export function startVideoStream(
  url: string,
  canvas: HTMLCanvasElement,
  callbacks: VideoStreamCallbacks,
): VideoStreamHandle {
  const controller = new AbortController();
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  let decoder: VideoDecoder | null = null;
  let configured = false;
  let sawKeyframe = false;
  let painted = false;
  let stopped = false;
  let timestamp = 0;
  let codec: string | null = null;
  let frameWidth = 0;
  let frameHeight = 0;

  // Newest decoded frame waiting for the next animation frame. Anything older
  // is closed unpainted: painting more than once per refresh is wasted work.
  let pending: VideoFrame | ImageBitmap | null = null;
  let pendingIsFrame = false;
  let rafId: number | null = null;

  // Stats window.
  let decodedCount = 0;
  let paintedCount = 0;
  let byteCount = 0;
  let lastPaintAt = 0;
  let windowStart = performance.now();
  const statsTimer = setInterval(() => {
    if (!callbacks.onStats || stopped) return;
    const now = performance.now();
    const seconds = Math.max(0.001, (now - windowStart) / 1000);
    callbacks.onStats({
      codec,
      decodedFps: Math.round(decodedCount / seconds),
      paintedFps: Math.round(paintedCount / seconds),
      queue: decoder?.decodeQueueSize ?? 0,
      frameAgeMs: lastPaintAt ? Math.round(now - lastPaintAt) : -1,
      width: frameWidth,
      height: frameHeight,
      bytesPerSecond: Math.round(byteCount / seconds),
    });
    decodedCount = 0;
    paintedCount = 0;
    byteCount = 0;
    windowStart = now;
  }, 1_000);

  const fitBacking = (width: number, height: number) => {
    // Back the canvas at the size it is displayed (in device pixels), never
    // larger than the source frame. Resizing clears the canvas, so only touch
    // it when the target changes.
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || width;
    const scale = Math.min(1, (cssWidth * dpr) / width);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    if (width !== frameWidth || height !== frameHeight) {
      frameWidth = width;
      frameHeight = height;
      callbacks.onSize?.(width, height);
    }
  };

  const paintPending = () => {
    rafId = null;
    const source = pending;
    const isFrame = pendingIsFrame;
    pending = null;
    if (!source || stopped || !context) {
      if (source) source.close();
      return;
    }
    const width = isFrame ? (source as VideoFrame).displayWidth : (source as ImageBitmap).width;
    const height = isFrame ? (source as VideoFrame).displayHeight : (source as ImageBitmap).height;
    try {
      fitBacking(width, height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      paintedCount += 1;
      lastPaintAt = performance.now();
      if (!painted) {
        painted = true;
        callbacks.onFirstFrame?.();
      }
    } finally {
      source.close();
    }
  };

  const queuePaint = (source: VideoFrame | ImageBitmap, isFrame: boolean) => {
    if (pending) pending.close();
    pending = source;
    pendingIsFrame = isFrame;
    if (rafId === null) rafId = requestAnimationFrame(paintPending);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(statsTimer);
    controller.abort();
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (pending) {
      pending.close();
      pending = null;
    }
    try {
      if (decoder && decoder.state !== "closed") decoder.close();
    } catch {
      // already closed
    }
    decoder = null;
  };

  const fail = (reason: string) => {
    if (stopped) return;
    stop();
    callbacks.onFallback(reason);
  };

  const ensureDecoder = () => {
    if (decoder && decoder.state !== "closed") return decoder;
    decoder = new VideoDecoder({
      output: (frame) => {
        decodedCount += 1;
        queuePaint(frame, true);
      },
      error: (error) => fail(`decoder error: ${error.message}`),
    });
    return decoder;
  };

  const handle = async (tag: number, payload: Uint8Array) => {
    if (tag === AVCC_TAG.SEED_JPEG) {
      if (painted) return;
      try {
        const bitmap = await createImageBitmap(new Blob([payload as BlobPart], { type: "image/jpeg" }));
        if (!painted && !stopped) queuePaint(bitmap, false);
        else bitmap.close();
      } catch {
        // cosmetic only
      }
      return;
    }
    if (tag === AVCC_TAG.DESCRIPTION) {
      codec = codecStringFromAvcc(payload);
      const config: VideoDecoderConfig = {
        codec,
        description: payload,
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware",
      };
      let support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (!support.supported) {
        delete config.hardwareAcceleration;
        support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      }
      if (!support.supported) {
        fail(`codec ${codec} unsupported`);
        return;
      }
      ensureDecoder().configure(config);
      configured = true;
      sawKeyframe = false;
      return;
    }
    if (tag === AVCC_TAG.KEYFRAME || tag === AVCC_TAG.DELTA) {
      if (!configured) return;
      if (tag === AVCC_TAG.KEYFRAME) sawKeyframe = true;
      if (!sawKeyframe) return;
      timestamp += 16_667;
      ensureDecoder().decode(
        new EncodedVideoChunk({
          type: tag === AVCC_TAG.KEYFRAME ? "key" : "delta",
          timestamp,
          data: payload,
        }),
      );
    }
  };

  (async () => {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    } catch (error) {
      if (!stopped) callbacks.onDisconnect(`connect failed: ${String(error)}`);
      return;
    }
    if (!response.ok || !response.body) {
      callbacks.onDisconnect(`HTTP ${response.status}`);
      return;
    }
    const reader = response.body.getReader();
    let buffer: Uint8Array = new Uint8Array(0);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        byteCount += value.byteLength;
        buffer = concatBytes(buffer, value);
        const { records, rest } = parseAvccRecords(buffer);
        buffer = rest;
        for (const record of records) await handle(record.tag, record.payload);
      }
      if (!stopped) callbacks.onDisconnect("stream ended");
    } catch (error) {
      if (!stopped) callbacks.onDisconnect(`stream error: ${String(error)}`);
    }
  })();

  return { stop };
}
