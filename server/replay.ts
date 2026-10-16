import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, watch } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AVCC_TAG, concatBytes, parseAvccRecords } from "../lib/avcc";
import type { ScreenConfig } from "../lib/sim-protocol";
import type { ReplayClip, ReplayClipInfo, ReplayStatus, TimelineEvent } from "../lib/session-types";

export const REPLAY_LIMITS = { windowMs: 30_000, bytes: 32 * 1024 * 1024, clips: 3, clipBytes: 64 * 1024 * 1024, events: 500 } as const;
const EVENT_BYTES = 256 * 1024;
const MAX_LINE = 2048;
const REPORT_BYTES = 64 * 1024;
const REPORT_QUEUE = 16;
const REPORT_ATTEMPTS = 3;
const REPORT_DELAY_MS = 250;
type Timer = ReturnType<typeof setTimeout>;
type Spawn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
type NewEvent = Omit<TimelineEvent, "id" | "at"> & { at?: number };
interface ReportsWatcher { close(): void }
export interface ReplayOptions {
  now?: () => number;
  fetch?: typeof fetch;
  spawn?: Spawn;
  /** Lower limits make retention tests small; hard production ceilings remain. */
  maxBytes?: number;
  maxClipBytes?: number;
  maxClips?: number;
  maxEvents?: number;
  reconnectMs?: number;
  configPollMs?: number;
  streamTimeoutMs?: number;
  watchReports?: (onFile: (filename: string) => void, onError: (error: Error) => void) => ReportsWatcher;
  readReport?: (filename: string) => Promise<string>;
}
interface Frame { at: number; key: boolean; data: Buffer; config: ScreenConfig | null }
interface StoredEvent { event: TimelineEvent; bytes: number }
interface Diagnostics {
  bundleId: string; pid: number | null; child: ChildProcess | null; watcher: ReportsWatcher | null;
  logs: string; crashes: string; seen: Set<string>; reading: boolean;
  reports: Map<string, number>; reportTimer: Timer | null; cleanup?: () => void;
}
interface Session {
  udid: string; url: string; configUrl: string; controller: AbortController | null;
  retry: Timer | null; configTimer: Timer | null; reader: ReadableStreamDefaultReader<Uint8Array> | null;
  recording: boolean; error: string | null; description: Buffer | null; pending: Uint8Array;
  frames: Frame[]; awaitingKeyframe: boolean; config: ScreenConfig | null;
  timeline: StoredEvent[]; eventBytes: number; diagnostics: Diagnostics | null;
}
const bounded = (text: string, length = MAX_LINE) => text.replace(/\0/g, "").slice(0, length);
const capped = (value: number | undefined, maximum: number, minimum = 1) => Math.max(minimum, Math.min(maximum, Math.floor(value ?? maximum)));
const unref = (timer: Timer) => { timer.unref?.(); return timer; };
const info = (clip: ReplayClip): ReplayClipInfo => ({ id: clip.id, udid: clip.udid, threadId: clip.threadId, createdAt: clip.createdAt, startAt: clip.startAt, endAt: clip.endAt, frameCount: clip.frameCount });

/** Only reports proving all three identities may become timeline crash events. */
export function matchingCrashSummary(text: string, bundleId: string, udid: string, pid: number): string | null {
  try {
    const header = JSON.parse(text.split(/\r?\n/, 1)[0]!);
    if (header.bundleID !== bundleId || String(header.bug_type) !== "309") return null;
    const pathMatch = /"procPath"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    const reportPid = /"pid"\s*:\s*(\d+)/.exec(text);
    if (!pathMatch || Number(reportPid?.[1]) !== pid) return null;
    const path = String(JSON.parse(pathMatch[1]!)).replace(/\\/g, "/");
    if (!path.toLowerCase().includes(`/coresimulator/devices/${udid.toLowerCase()}/`)) return null;
    const type = /"exception"\s*:\s*\{[^}]*"type"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    return bounded(`${header.app_name ?? bundleId}: ${type ? JSON.parse(type[1]!) : "matching crash report"}`);
  } catch { return null; }
}

/** Bounded AVCC and event metadata. No native copies or host-wide log stream. */
export class ReplayRecorder {
  private sessions = new Map<string, Session>();
  private clips = new Map<string, { clip: ReplayClip; bytes: number }>();
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly spawn: Spawn;
  private readonly maxBytes: number;
  private readonly maxClipBytes: number;
  private readonly maxClips: number;
  private readonly maxEvents: number;
  private disposed = false;
  constructor(private options: ReplayOptions = {}) {
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.spawn = options.spawn ?? nodeSpawn;
    this.maxBytes = capped(options.maxBytes, REPLAY_LIMITS.bytes, 8);
    this.maxClipBytes = capped(options.maxClipBytes, REPLAY_LIMITS.clipBytes);
    this.maxClips = capped(options.maxClips, REPLAY_LIMITS.clips);
    this.maxEvents = capped(options.maxEvents, REPLAY_LIMITS.events);
  }
  private session(udid: string): Session {
    let s = this.sessions.get(udid);
    if (!s) {
      s = { udid, url: "", configUrl: "", controller: null, retry: null, configTimer: null, reader: null, recording: false,
        error: "Waiting for a replay keyframe.", description: null, pending: new Uint8Array(), frames: [], awaitingKeyframe: true,
        config: null, timeline: [], eventBytes: 0, diagnostics: null };
      if (!this.disposed) this.sessions.set(udid, s);
    }
    return s;
  }
  ensure(udid: string, streamUrl: string, configUrl: string): void {
    if (this.disposed) return;
    const s = this.session(udid);
    if (s.controller && s.url === streamUrl && s.configUrl === configUrl) return;
    this.stopStream(s);
    s.url = streamUrl; s.configUrl = configUrl; s.controller = new AbortController();
    const controller = s.controller;
    void this.connect(s, controller);
    void this.pollConfig(s, controller);
  }
  private active(s: Session, controller?: AbortController): boolean {
    return !this.disposed && this.sessions.get(s.udid) === s && (!controller || (s.controller === controller && !controller.signal.aborted));
  }
  private stopStream(s: Session): void {
    s.controller?.abort(); s.controller = null;
    if (s.retry) clearTimeout(s.retry);
    if (s.configTimer) clearTimeout(s.configTimer);
    s.retry = s.configTimer = null;
    void s.reader?.cancel().catch(() => {}); s.reader = null; s.recording = false; s.pending = new Uint8Array();
  }
  private async connect(s: Session, controller: AbortController): Promise<void> {
    // A reconnected encoder may use a new prediction chain with identical avcC.
    s.awaitingKeyframe = true;
    const attempt = new AbortController();
    let timeout = unref(setTimeout(() => attempt.abort(new Error("Replay stream timed out.")), this.options.streamTimeoutMs ?? 15_000));
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    const signal = AbortSignal.any([controller.signal, attempt.signal]);
    signal.addEventListener("abort", cancelReader, { once: true });
    try {
      const response = await this.fetch(s.url, { signal, cache: "no-store" });
      if (!this.active(s, controller)) return;
      if (!response.ok || !response.body) throw new Error(`Replay stream HTTP ${response.status}.`);
      reader = response.body.getReader(); s.reader = reader; s.recording = true;
      for (;;) {
        clearTimeout(timeout);
        timeout = unref(setTimeout(() => attempt.abort(new Error("Replay stream stopped producing data.")), this.options.streamTimeoutMs ?? 15_000));
        const { value, done } = await reader.read();
        if (!this.active(s, controller)) return;
        if (signal.aborted) throw signal.reason ?? new Error("Replay stream aborted.");
        if (done) throw new Error("Replay stream ended; reconnecting.");
        this.feed(s.udid, value);
      }
    } catch (error) {
      if (this.active(s, controller)) {
        const message = bounded(error instanceof Error ? error.message : String(error));
        if (s.error !== message) this.record(s.udid, { kind: "error", actor: "system", label: "Replay stream interrupted", detail: message });
        s.error = message;
      }
    } finally {
      clearTimeout(timeout); signal.removeEventListener("abort", cancelReader);
      if (this.active(s, controller)) {
        s.reader = null; s.recording = false; s.pending = new Uint8Array();
        s.retry = unref(setTimeout(() => { s.retry = null; void this.connect(s, controller); }, this.options.reconnectMs ?? 1000));
      }
      // Cancellation can itself stall on a broken source; it must not hold the
      // recorder in a recording state or prevent scheduling the next attempt.
      if (reader) {
        const finishedReader = reader;
        void finishedReader.cancel().catch(() => {}).finally(() => { try { finishedReader.releaseLock(); } catch { /* pending read */ } });
      }
    }
  }
  private async pollConfig(s: Session, controller: AbortController): Promise<void> {
    try {
      const response = await this.fetch(s.configUrl, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), cache: "no-store" });
      if (response.ok) {
        const config = await response.json() as ScreenConfig;
        if (this.active(s, controller)) this.setConfig(s.udid, config);
      }
    } catch { /* replay stays usable with per-frame null/last-known config */ }
    if (this.active(s, controller)) s.configTimer = unref(setTimeout(() => { s.configTimer = null; void this.pollConfig(s, controller); }, this.options.configPollMs ?? 1000));
  }
  setConfig(udid: string, config: ScreenConfig): void {
    if (this.disposed || !Number.isFinite(config.width) || !Number.isFinite(config.height) || config.width <= 0 || config.height <= 0 || config.width > 32768 || config.height > 32768) return;
    this.session(udid).config = { width: config.width, height: config.height, ...(config.orientation ? { orientation: bounded(config.orientation, 40) } : {}) };
  }
  /** Incremental wire ingestion also lets tests exercise real packet boundaries. */
  feed(udid: string, chunk: Uint8Array, at = this.now()): void {
    if (this.disposed) return;
    const s = this.session(udid);
    if (s.pending.byteLength + chunk.byteLength > this.maxBytes + 4) { s.pending = new Uint8Array(); throw new Error("Replay packet exceeds the byte limit."); }
    const joined = concatBytes(s.pending, chunk);
    if (joined.byteLength >= 4 && new DataView(joined.buffer, joined.byteOffset, 4).getUint32(0) > this.maxBytes) throw new Error("Replay record exceeds the byte limit.");
    const { records, rest } = parseAvccRecords(joined);
    s.pending = new Uint8Array();
    for (const { tag, payload } of records) {
      if (payload.byteLength > this.maxBytes) throw new Error("Replay record exceeds the byte limit.");
      if (tag === AVCC_TAG.DESCRIPTION) {
        const next = Buffer.from(payload);
        if (!s.description?.equals(next)) { s.frames = []; s.awaitingKeyframe = true; s.description = next; s.error = "Waiting for a replay keyframe."; }
      } else if ((tag === AVCC_TAG.KEYFRAME || tag === AVCC_TAG.DELTA) && s.description) {
        const key = tag === AVCC_TAG.KEYFRAME;
        if (!key && s.awaitingKeyframe) continue;
        if (key) s.awaitingKeyframe = false;
        s.frames.push({ at, key, data: Buffer.from(payload), config: s.config ? { ...s.config } : null });
        s.error = null;
      }
      this.trimFrames(s, 0);
    }
    s.pending = rest;
    this.trimFrames(s, rest.byteLength);
  }
  private bytes(s: Session): number { return s.eventBytes + (s.description?.byteLength ?? 0) + s.pending.byteLength + s.frames.reduce((n, f) => n + f.data.byteLength, 0); }
  private trimFrames(s: Session, reserved: number): void {
    const cutoff = this.now() - REPLAY_LIMITS.windowMs;
    let keep = 0;
    for (let i = 1; i < s.frames.length; i++) if (s.frames[i]!.key && s.frames[i]!.at <= cutoff) keep = i;
    if (keep) s.frames.splice(0, keep);
    const videoBytes = () => s.eventBytes + (s.description?.byteLength ?? 0) + reserved + s.frames.reduce((n, f) => n + f.data.byteLength, 0);
    while (videoBytes() > this.maxBytes && s.frames.length) {
      const nextKey = s.frames.findIndex((f, i) => i > 0 && f.key);
      if (nextKey < 0) { s.frames = []; s.awaitingKeyframe = true; s.error = "Replay byte limit reached; waiting for a keyframe."; }
      else s.frames.splice(0, nextKey);
    }
    if (videoBytes() > this.maxBytes) { s.description = null; s.frames = []; s.awaitingKeyframe = true; s.pending = new Uint8Array(); s.error = "Replay record exceeds the byte limit."; }
  }
  record(udid: string, event: NewEvent): void {
    if (this.disposed) return;
    const s = this.session(udid);
    const stored: TimelineEvent = { id: randomUUID(), at: event.at ?? this.now(), kind: event.kind, actor: event.actor,
      label: bounded(event.label, 240), ...(event.detail ? { detail: bounded(event.detail) } : {}), ...(event.threadId ? { threadId: event.threadId } : {}) };
    // Events are immutable internally. Serialize once, rather than serializing
    // every retained line again for each incoming app log or status request.
    s.timeline.push({ event: stored, bytes: Buffer.byteLength(JSON.stringify(stored)) });
    this.trimEvents(s);
    this.trimFrames(s, s.pending.byteLength);
  }
  private trimEvents(s: Session): void {
    const cutoff = this.now() - REPLAY_LIMITS.windowMs;
    s.timeline = s.timeline.filter(({ event }) => event.at >= cutoff);
    let bytes = s.timeline.reduce((n, item) => n + item.bytes, 0);
    while ((s.timeline.length > this.maxEvents || bytes > Math.min(EVENT_BYTES, this.maxBytes)) && s.timeline.length) {
      // Framework log bursts must not displace the actions and failures that
      // explain the replay. Once only those remain, evict the oldest normally.
      const logIndex = s.timeline.findIndex(({ event }) => event.kind === "log");
      const [removed] = s.timeline.splice(logIndex < 0 ? 0 : logIndex, 1);
      bytes -= removed!.bytes;
    }
    s.eventBytes = bytes;
  }
  events(udid: string): TimelineEvent[] {
    const s = this.sessions.get(udid); if (!s) return [];
    this.trimEvents(s); return s.timeline.map(({ event }) => ({ ...event }));
  }
  status(udid: string, threadId: string): ReplayStatus {
    const s = this.sessions.get(udid);
    if (s) { this.trimEvents(s); this.trimFrames(s, s.pending.byteLength); }
    const first = s?.frames[0], last = s?.frames.at(-1);
    return { recording: s?.recording ?? false, bytes: s ? this.bytes(s) : 0,
      bufferedMs: first && last ? Math.max(0, last.at - Math.max(this.now() - REPLAY_LIMITS.windowMs, first.at)) : 0,
      error: s?.error ?? (s ? null : "Attach the simulator to start replay."), app: s?.diagnostics?.bundleId ?? null,
      diagnostics: s?.diagnostics ? `${s.diagnostics.logs} ${s.diagnostics.crashes}` : "App diagnostics unavailable: launch an app through the plugin.",
      clips: [...this.clips.values()].map(x => x.clip).filter(c => c.udid === udid && c.threadId === threadId).map(info) };
  }
  save(udid: string, threadId: string): ReplayClipInfo {
    const s = this.sessions.get(udid); if (!s) throw new Error("Attach the simulator to start replay.");
    this.trimFrames(s, s.pending.byteLength); this.trimEvents(s);
    if (!s.description || !s.frames[0]?.key) throw new Error("Replay is not ready: waiting for a decodable keyframe.");
    const endAt = s.frames.at(-1)!.at, startAt = Math.max(this.now() - REPLAY_LIMITS.windowMs, s.frames[0].at);
    if (endAt < startAt) throw new Error("No replay frames are available from the last 30 seconds.");
    const clip: ReplayClip = { id: randomUUID(), udid, threadId, createdAt: this.now(), startAt, endAt, frameCount: s.frames.length,
      description: s.description.toString("base64"), frames: s.frames.map(f => ({ at: f.at, key: f.key, data: f.data.toString("base64"), config: f.config ? { ...f.config } : null })),
      events: s.timeline.filter(({ event: e }) => e.at >= startAt && e.at <= endAt && (!e.threadId || e.threadId === threadId)).map(({ event }) => ({ ...event })) };
    const bytes = Buffer.byteLength(JSON.stringify(clip));
    if (bytes > this.maxClipBytes) throw new Error("Replay snapshot exceeds the saved-clip byte limit.");
    this.clips.set(clip.id, { clip, bytes });
    while (this.clips.size > this.maxClips || [...this.clips.values()].reduce((n, c) => n + c.bytes, 0) > this.maxClipBytes) this.clips.delete(this.clips.keys().next().value!);
    return info(clip);
  }
  clip(udid: string, id: string, threadId: string): ReplayClip | null {
    const clip = this.clips.get(id)?.clip;
    return clip && clip.udid === udid && clip.threadId === threadId ? structuredClone(clip) : null;
  }
  watchApp(udid: string, bundleId: string, launchOutput: string): void {
    if (this.disposed) return;
    const s = this.session(udid); this.stopDiagnostics(s);
    const escaped = bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = new RegExp(`(?:^|\\n)${escaped}:\\s*(\\d+)\\s*(?:$|\\n)`).exec(launchOutput)?.[1];
    const pid = value ? Number(value) : null;
    const d: Diagnostics = { bundleId: bounded(bundleId, 255), pid, child: null, watcher: null, logs: "App logs unavailable. Relaunch the app through the plugin.",
      crashes: "Crash monitoring unavailable. Relaunch the app through the plugin.", seen: new Set(), reading: false,
      reports: new Map(), reportTimer: null };
    s.diagnostics = d;
    if (!pid || !Number.isSafeInteger(pid) || pid > 2147483647) return;
    try {
      const child = this.spawn("xcrun", ["simctl", "spawn", udid, "log", "stream", "--process", String(pid), "--style", "ndjson", "--level", "debug"], { stdio: ["ignore", "pipe", "pipe"] });
      d.child = child; d.logs = "App logs connecting.";
      let partial = "";
      const current = () => this.active(s) && s.diagnostics === d;
      const data = (chunk: Buffer | string) => {
        if (!current()) return;
        // Bound temporary parsing work as well as retained metadata. Oversized
        // records cannot be useful timeline lines and are discarded.
        const text = String(chunk);
        if (text.length > 256 * 1024) { partial = ""; return; }
        partial += text;
        const lines = partial.split(/\r?\n/); partial = lines.pop()!.slice(-MAX_LINE * 2);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.processID !== undefined && Number(event.processID) !== pid) continue;
            if (typeof event.eventMessage === "string") {
              d.logs = "App logs connected.";
              this.record(udid, { kind: "log", actor: "system", label: bounded(String(event.messageType ?? "App log"), 80), detail: event.eventMessage });
            }
          } catch { /* log banners and malformed lines are not app diagnostics */ }
        }
      };
      const stderr = (chunk: Buffer | string) => {
        if (!current()) return;
        const warning = bounded(String(chunk)).split(/\r?\n/).filter(line => line.trim() && !line.includes("getpwuid_r")).join("\n");
        if (!warning) return;
        d.logs = "App log stream reported a warning.";
        this.record(udid, { kind: "error", actor: "system", label: "App log stream warning", detail: warning });
      };
      const error = (error: Error) => {
        if (!current()) return;
        d.logs = "App logs unavailable. Relaunch the app to retry.";
        this.record(udid, { kind: "error", actor: "system", label: "App log stream unavailable", detail: error.message });
      };
      child.stdout?.on("data", data); child.stderr?.on("data", stderr); child.once("error", error);
      child.once("exit", () => { if (current()) d.logs = "App logs ended. Relaunch the app to reconnect."; d.cleanup?.(); });
      d.cleanup = () => { child.stdout?.removeListener("data", data); child.stderr?.removeListener("data", stderr); };
    } catch (error) {
      d.logs = "App logs unavailable. Relaunch the app to retry.";
      this.record(udid, { kind: "error", actor: "system", label: "App log stream unavailable", detail: String(error) });
    }
    try {
      const current = () => this.active(s) && s.diagnostics === d;
      const schedule = () => {
        if (!current() || !d.reports.size || d.reading || d.reportTimer) return;
        d.reportTimer = unref(setTimeout(readNext, REPORT_DELAY_MS));
      };
      const readNext = () => {
        d.reportTimer = null;
        if (!current()) return;
        const next = d.reports.entries().next().value;
        if (!next) return;
        const [filename, attempts] = next;
        d.reports.set(filename, attempts + 1);
        d.reading = true;
        void this.readReport(filename).then(text => {
          if (!current()) return;
          const summary = matchingCrashSummary(text, bundleId, udid, pid);
          if (!summary) return;
          d.seen.add(filename); if (d.seen.size > 128) d.seen.delete(d.seen.values().next().value!);
          this.record(udid, { kind: "crash", actor: "system", label: "Matching simulator app crash", detail: summary });
        }).catch(() => { /* A creation event can precede the file or its metadata. */ }).finally(() => {
          d.reading = false;
          if (d.seen.has(filename) || attempts + 1 >= REPORT_ATTEMPTS) d.reports.delete(filename);
          schedule();
        });
      };
      const onFile = (filename: string) => {
        if (!current() || filename.length > 255 || basename(filename) !== filename || !filename.endsWith(".ips") || d.seen.has(filename)) return;
        // Notifications while a read is pending retain the queued retry. Bound
        // watcher bursts without scanning historical or unrelated directories.
        if (!d.reports.has(filename) && d.reports.size < REPORT_QUEUE) d.reports.set(filename, 0);
        schedule();
      };
      const onError = (error: Error) => {
        if (!this.active(s) || s.diagnostics !== d) return;
        d.crashes = "Crash monitoring unavailable. Check DiagnosticReports access.";
        this.record(udid, { kind: "error", actor: "system", label: "Crash monitoring unavailable", detail: error.message });
      };
      d.watcher = this.options.watchReports ? this.options.watchReports(onFile, onError) : watch(join(homedir(), "Library", "Logs", "DiagnosticReports"), { persistent: false }, (_event, filename) => { if (filename) onFile(String(filename)); }).on("error", onError);
      d.crashes = "Crash monitoring active.";
    } catch (error) {
      d.crashes = "Crash monitoring unavailable. Check DiagnosticReports access.";
      this.record(udid, { kind: "error", actor: "system", label: "Crash monitoring unavailable", detail: String(error) });
    }
  }
  private async readReport(filename: string): Promise<string> {
    if (this.options.readReport) return (await this.options.readReport(filename)).slice(0, REPORT_BYTES);
    const file = await open(join(homedir(), "Library", "Logs", "DiagnosticReports", filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const buffer = Buffer.alloc(REPORT_BYTES); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); return buffer.toString("utf8", 0, bytesRead); }
    finally { await file.close(); }
  }
  private stopDiagnostics(s: Session): void {
    const d = s.diagnostics; s.diagnostics = null;
    d?.cleanup?.();
    if (d?.reportTimer) clearTimeout(d.reportTimer);
    d?.reports.clear();
    try { d?.watcher?.close(); } catch { /* watcher already closed */ }
    try { d?.child?.kill("SIGTERM"); } catch { /* process already exited */ }
  }
  stop(udid: string): void {
    const s = this.sessions.get(udid); if (!s) return;
    this.sessions.delete(udid); this.stopStream(s); this.stopDiagnostics(s);
    for (const [id, saved] of this.clips) if (saved.clip.udid === udid) this.clips.delete(id);
  }
  dispose(): void { this.disposed = true; for (const udid of this.sessions.keys()) this.stop(udid); this.clips.clear(); }
}
