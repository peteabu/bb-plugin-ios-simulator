import { codecStringFromAvcc } from "@/lib/avcc";
import { screenGeometry } from "@/lib/screen-geometry";
import type { ReplayClip, ReplayFrame } from "@/lib/session-types";

const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

export function replaySeekIndex(clip: ReplayClip, at: number): number {
  for (let index = clip.frames.length - 1; index >= 0; index--) {
    if (clip.frames[index]!.key && clip.frames[index]!.at <= at) return index;
  }
  throw new Error("This replay has no decoding keyframe before the selected time.");
}

/** Decode only up to the playhead; seeking includes the preceding GOP. */
export function createReplayPlayer(canvas: HTMLCanvasElement, clip: ReplayClip, callbacks: {
  onTime(at: number): void;
  onEnded(): void;
  onError(message: string): void;
}) {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
    throw new Error("Replay playback needs WebCodecs. You can still download the replay JSON.");
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Replay canvas is unavailable.");
  let decoder: VideoDecoder | null = null;
  let disposed = false;
  let generation = 0;
  let position = clip.startAt;
  let nextIndex = 0;
  let playing = false;
  let playRequest = 0;
  let failed = false;
  let animation: number | null = null;
  let seeking: Promise<void> = Promise.resolve();
  let seekingFrames = false;
  let needsKeyframe = true;
  const waits = new Set<() => void>();
  const ready: Array<{ frame: VideoFrame; source: ReplayFrame }> = [];
  const sources = new Map<number, ReplayFrame>();
  let lastTimestamp = -1;
  const timestamps = clip.frames.map((frame) => {
    lastTimestamp = Math.max(lastTimestamp + 1, Math.round((frame.at - clip.frames[0]!.at) * 1000));
    return lastTimestamp;
  });

  const cancelAnimation = () => {
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
  };
  const pause = () => { playRequest++; playing = false; cancelAnimation(); };
  const clearDecoder = () => {
    for (const cancel of [...waits]) cancel();
    try { if (decoder && decoder.state !== "closed") decoder.close(); } catch { /* already closed */ }
    decoder = null;
    for (const item of ready.splice(0)) item.frame.close();
    sources.clear();
  };
  // flush() is an output fence, not backpressure: the next decode after a
  // flush must be a key chunk. Capacity waits must preserve the current GOP.
  const waitForDecoder = (active: VideoDecoder, token: number, drain = false): Promise<boolean> => {
    if (disposed || token !== generation) return Promise.resolve(false);
    if (!drain && active.decodeQueueSize < 24) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (completed: boolean, error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        active.removeEventListener("dequeue", check);
        waits.delete(cancel);
        if (error) reject(error); else resolve(completed);
      };
      const cancel = () => finish(false);
      const check = () => {
        if (disposed || token !== generation || active.state === "closed") finish(false);
        else if (!drain && active.decodeQueueSize < 24) finish(true);
      };
      const timer = setTimeout(() => finish(false, new Error("Replay decoder stopped making progress.")), 5_000);
      waits.add(cancel);
      active.addEventListener("dequeue", check);
      if (drain) {
        needsKeyframe = true;
        try { void active.flush().then(() => finish(true), (error) => finish(false, error)); }
        catch (error) { finish(false, error); }
      } else check();
    });
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    failed = true;
    pause();
    clearDecoder();
    callbacks.onError(error instanceof Error ? error.message : String(error));
  };
  const paint = () => {
    let newest: (typeof ready)[number] | undefined;
    for (let index = ready.length - 1; index >= 0; index--) {
      const item = ready[index]!;
      if (item.source.at > position) continue;
      ready.splice(index, 1);
      if (!newest || item.source.at > newest.source.at) {
        newest?.frame.close(); newest = item;
      } else item.frame.close();
    }
    if (!newest) return;
    const { frame, source } = newest;
    try {
      const geometry = screenGeometry({ width: frame.displayWidth, height: frame.displayHeight }, source.config?.orientation);
      const scale = Math.min(1, ((canvas.clientWidth || 640) * (window.devicePixelRatio || 1)) / geometry.width);
      const width = Math.max(1, Math.round(geometry.width * scale));
      const height = Math.max(1, Math.round(geometry.height * scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.save();
      context.translate(width / 2, height / 2);
      context.rotate(geometry.contentRotation * Math.PI / 180);
      context.drawImage(frame, -frame.displayWidth * scale / 2, -frame.displayHeight * scale / 2,
        frame.displayWidth * scale, frame.displayHeight * scale);
      context.restore();
    } finally { frame.close(); }
  };
  const decode = (index: number) => {
    const frame = clip.frames[index]!;
    const timestamp = timestamps[index]!;
    sources.set(timestamp, frame);
    decoder!.decode(new EncodedVideoChunk({ type: frame.key ? "key" : "delta", timestamp, data: bytes(frame.data) }));
  };

  const prepareDecoder = (drain: boolean): Promise<void> => {
    const token = ++generation;
    // Resume re-primes the decoder while preserving the exact seek still.
    // Its older samples are decode dependencies, never presentation frames.
    const outputFloor = drain ? clip.startAt : position;
    clearDecoder();
    seekingFrames = true;
    return (async () => {
      if (!clip.frames.some((frame) => frame.at >= clip.startAt && frame.at <= clip.endAt))
        throw new Error("No recorded video frame falls inside this replay's window.");
      const description = bytes(clip.description);
      const config: VideoDecoderConfig = { codec: codecStringFromAvcc(description), description, optimizeForLatency: true };
      const support = await VideoDecoder.isConfigSupported(config);
      if (disposed || token !== generation) return;
      if (!support.supported) throw new Error("This browser cannot decode the saved replay. Download the replay JSON instead.");
      const active = new VideoDecoder({
        output: (frame) => {
          if (disposed || token !== generation) { frame.close(); return; }
          const source = sources.get(frame.timestamp);
          sources.delete(frame.timestamp);
          if (!source || source.at < outputFloor) { frame.close(); return; }
          // Scrubbing needs only the last visible result, never a GOP's worth
          // of decoded VideoFrames retained in GPU memory.
          if (ready[0] && ready[0].source.at > source.at) { frame.close(); return; }
          for (const item of ready.splice(0)) item.frame.close();
          ready.push({ frame, source });
          if (!playing && !seekingFrames) paint();
        },
        error: (error) => { if (token === generation) fail(error); },
      });
      decoder = active;
      active.configure(config);
      needsKeyframe = false;
      nextIndex = replaySeekIndex(clip, position);
      while (nextIndex < clip.frames.length && clip.frames[nextIndex]!.at <= position) {
        if (!await waitForDecoder(active, token) || disposed || token !== generation) return;
        decode(nextIndex++);
      }
      if (drain && !await waitForDecoder(active, token, true)) return;
      if (!disposed && token === generation) { seekingFrames = false; paint(); }
    })().catch((error) => { if (token === generation) fail(error); });
  };

  const seek = (at: number): Promise<void> => {
    pause();
    failed = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const firstVisible = clip.frames.find((frame) => frame.at >= clip.startAt && frame.at <= clip.endAt);
    position = Math.max(firstVisible?.at ?? clip.startAt, Math.max(clip.startAt, Math.min(clip.endAt, at)));
    callbacks.onTime(position);
    seeking = prepareDecoder(true);
    return seeking;
  };

  const play = async () => {
    const request = ++playRequest;
    await seeking;
    if (disposed || request !== playRequest || failed || playing || !decoder) return;
    if (position >= clip.endAt) { callbacks.onEnded(); return; }
    // A seek's terminal flush produces the exact still, then requires a new
    // key chunk. Rebuild through the same preparation path before continuing.
    if (needsKeyframe) { seeking = prepareDecoder(false); await seeking; }
    if (disposed || request !== playRequest || failed || !decoder) return;
    playing = true;
    const started = performance.now();
    const from = position;
    const token = generation;
    let blockedAt: number | null = null;
    const tick = (now: number) => {
      animation = null;
      if (disposed || !playing || token !== generation || !decoder) return;
      position = Math.min(clip.endAt, from + now - started);
      try {
        const before = nextIndex;
        while (nextIndex < clip.frames.length && clip.frames[nextIndex]!.at <= position && decoder.decodeQueueSize < 12) decode(nextIndex++);
        if (nextIndex > before || decoder.decodeQueueSize < 12) blockedAt = null;
        else {
          blockedAt ??= now;
          if (now - blockedAt >= 5_000) throw new Error("Replay decoder stopped making progress.");
        }
        paint();
        callbacks.onTime(position);
        if (position >= clip.endAt && nextIndex >= clip.frames.length) {
          const active = decoder;
          void waitForDecoder(active, token, true).then((completed) => {
            if (!completed || disposed || token !== generation || !playing) return;
            paint(); pause(); callbacks.onEnded();
          }).catch((error) => { if (token === generation) fail(error); });
        } else animation = requestAnimationFrame(tick);
      } catch (error) { fail(error); }
    };
    animation = requestAnimationFrame(tick);
  };

  return {
    seek, play, pause,
    dispose() { if (disposed) return; disposed = true; generation++; pause(); clearDecoder(); },
  };
}
