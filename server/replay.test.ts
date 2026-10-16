import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AVCC_TAG } from "../lib/avcc";
import { ReplayRecorder, matchingCrashSummary, type ReplayOptions } from "./replay";

const udid = "12345678-1234-1234-1234-123456789ABC";
const bundle = "dev.example.MyApp";
const description = Uint8Array.of(1, 100, 0, 40);
function packet(tag: number, payload: Uint8Array = Uint8Array.of(9)): Uint8Array {
  const bytes = new Uint8Array(payload.length + 5);
  new DataView(bytes.buffer).setUint32(0, payload.length + 1);
  bytes[4] = tag; bytes.set(payload, 5); return bytes;
}
function joined(...chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
const recorders: ReplayRecorder[] = [];
function recorder(options: ReplayOptions = {}) {
  const replay = new ReplayRecorder(options); recorders.push(replay); return replay;
}
function seed(replay: ReplayRecorder, id = udid, at = 0, size = 1) {
  replay.feed(id, packet(AVCC_TAG.DESCRIPTION, description), at);
  replay.feed(id, packet(AVCC_TAG.KEYFRAME, new Uint8Array(size).fill(8)), at);
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(() => { for (const replay of recorders.splice(0)) replay.dispose(); vi.useRealTimers(); });

describe("replay retention", () => {
  it("parses fragmented wire records and waits for the first keyframe", () => {
    const replay = recorder({ now: () => 100 });
    const wire = joined(packet(AVCC_TAG.DESCRIPTION, description), packet(AVCC_TAG.DELTA), packet(AVCC_TAG.KEYFRAME));
    replay.feed(udid, wire.slice(0, 7));
    expect(() => replay.save(udid, "a")).toThrow(/keyframe/);
    replay.feed(udid, wire.slice(7));
    const saved = replay.save(udid, "a");
    expect(replay.clip(udid, saved.id, "a")?.frames).toEqual([{ at: 100, key: true, data: "CQ==", config: null }]);
    expect(replay.status(udid, "a").bytes).toBe(5);
  });

  it("keeps the preceding keyframe even when idle encoding makes it older than 30 seconds", () => {
    let now = 0;
    const replay = recorder({ now: () => now });
    seed(replay);
    now = 15_000; replay.feed(udid, packet(AVCC_TAG.DELTA));
    now = 45_000; replay.feed(udid, packet(AVCC_TAG.DELTA));
    const saved = replay.save(udid, "a"), clip = replay.clip(udid, saved.id, "a")!;
    expect(saved.startAt).toBe(15_000);
    expect(saved.endAt).toBe(45_000);
    expect(clip.frames.map(f => f.at)).toEqual([0, 15_000, 45_000]);
    expect(replay.status(udid, "a").bufferedMs).toBe(30_000);
    now = 90_000;
    expect(() => replay.save(udid, "a")).toThrow(/last 30 seconds/);
  });

  it("drops older groups only when a newer preceding keyframe can decode the visible window", () => {
    let now = 0;
    const replay = recorder({ now: () => now });
    seed(replay);
    now = 20_000; replay.feed(udid, packet(AVCC_TAG.KEYFRAME));
    now = 40_000; replay.feed(udid, packet(AVCC_TAG.DELTA));
    expect(replay.save(udid, "a").frameCount).toBe(3);
    now = 55_000; replay.feed(udid, packet(AVCC_TAG.DELTA));
    const saved = replay.save(udid, "a");
    expect(replay.clip(udid, saved.id, "a")!.frames.map(f => f.at)).toEqual([20_000, 40_000, 55_000]);
    expect(saved.startAt).toBe(25_000);
  });

  it("enforces the byte cap by dropping whole groups and rejects an oversized undecodable group", () => {
    const replay = recorder({ now: () => 0, maxBytes: 16 });
    seed(replay, udid, 0, 4);
    replay.feed(udid, packet(AVCC_TAG.DELTA, new Uint8Array(4)));
    replay.feed(udid, packet(AVCC_TAG.KEYFRAME, new Uint8Array(4)));
    replay.feed(udid, packet(AVCC_TAG.DELTA, new Uint8Array(4)));
    expect(replay.status(udid, "a").bytes).toBe(12);
    expect(replay.save(udid, "a").frameCount).toBe(2);
    replay.feed(udid, packet(AVCC_TAG.DELTA, new Uint8Array(8)));
    expect(replay.status(udid, "a").bytes).toBe(4);
    expect(() => replay.save(udid, "a")).toThrow(/keyframe/);
    replay.feed(udid, packet(AVCC_TAG.DELTA));
    expect(() => replay.save(udid, "a")).toThrow(/keyframe/);
    replay.feed(udid, packet(AVCC_TAG.KEYFRAME));
    expect(replay.save(udid, "a").frameCount).toBe(1);
  });

  it("bounds partial records and event metadata within the per-device budget", () => {
    const replay = recorder({ now: () => 0, maxBytes: 512 });
    seed(replay, udid, 0, 100);
    replay.record(udid, { kind: "log", actor: "system", label: "log", detail: "x".repeat(400) });
    expect(replay.status(udid, "a").bytes).toBeLessThanOrEqual(512);
    const partial = packet(AVCC_TAG.DELTA, new Uint8Array(500)).slice(0, 400);
    replay.feed(udid, partial);
    expect(replay.status(udid, "a").bytes).toBeLessThanOrEqual(512);
    expect(() => replay.feed(udid, new Uint8Array(520))).toThrow(/byte limit/);
    expect(replay.status(udid, "a").bytes).toBeLessThanOrEqual(512);
  });

  it("resets only the live ring when codec description changes and saves immutable configs and data", () => {
    const replay = recorder({ now: () => 10 });
    const config = { width: 393, height: 852, orientation: "portrait" };
    replay.setConfig(udid, config); seed(replay, udid, 10);
    replay.record(udid, { kind: "input", actor: "human", label: "Tap", threadId: "a" });
    const saved = replay.save(udid, "a");
    const copy = replay.clip(udid, saved.id, "a")!;
    config.width = 1; copy.frames[0]!.data = "changed"; copy.frames[0]!.config!.width = 1; copy.events[0]!.label = "changed";
    replay.feed(udid, packet(AVCC_TAG.DESCRIPTION, description));
    expect(replay.save(udid, "a").frameCount).toBe(1);
    replay.feed(udid, packet(AVCC_TAG.DESCRIPTION, Uint8Array.of(1, 77, 0, 30)));
    replay.feed(udid, packet(AVCC_TAG.DELTA));
    expect(() => replay.save(udid, "a")).toThrow(/keyframe/);
    const original = replay.clip(udid, saved.id, "a")!;
    expect(original.description).toBe(Buffer.from(description).toString("base64"));
    expect(original.frames[0]).toMatchObject({ data: "CA==", config: { width: 393 } });
    expect(original.events[0]!.label).toBe("Tap");
  });

  it("isolates saved clips by device and thread and omits another thread's input events", () => {
    const replay = recorder({ now: () => 0 }); seed(replay);
    replay.record(udid, { kind: "input", actor: "agent", label: "a input", threadId: "a" });
    replay.record(udid, { kind: "input", actor: "agent", label: "b input", threadId: "b" });
    replay.record(udid, { kind: "log", actor: "system", label: "shared app log" });
    const saved = replay.save(udid, "a");
    expect(replay.clip(udid, saved.id, "b")).toBeNull();
    expect(replay.clip("different-device", saved.id, "a")).toBeNull();
    expect(replay.status(udid, "b").clips).toEqual([]);
    expect(replay.clip(udid, saved.id, "a")!.events.map(e => e.label)).toEqual(["a input", "shared app log"]);
    replay.stop(udid);
    expect(replay.clip(udid, saved.id, "a")).toBeNull();
  });

  it("evicts oldest snapshots for both the count and encoded byte budgets", () => {
    const replay = recorder({ now: () => 0 }); seed(replay);
    const ids = Array.from({ length: 4 }, () => replay.save(udid, "a").id);
    expect(replay.clip(udid, ids[0]!, "a")).toBeNull();
    expect(replay.status(udid, "a").clips.map(c => c.id)).toEqual(ids.slice(1));
    const small = recorder({ now: () => 0, maxClipBytes: 600 }); seed(small, udid, 0, 100);
    const first = small.save(udid, "a"), second = small.save(udid, "a");
    expect(small.clip(udid, first.id, "a")).toBeNull();
    expect(small.clip(udid, second.id, "a")).not.toBeNull();
    const tooSmall = recorder({ now: () => 0, maxClipBytes: 50 }); seed(tooSmall);
    expect(() => tooSmall.save(udid, "a")).toThrow(/saved-clip byte limit/);
  });

  it("bounds event text/count/age and does not expose mutable event references", () => {
    let now = 0;
    const replay = recorder({ now: () => now, maxEvents: 2 });
    for (let i = 0; i < 3; i++) replay.record(udid, { kind: "input", actor: "human", label: String(i), detail: "x".repeat(5000) });
    const events = replay.events(udid);
    expect(events.map(e => e.label)).toEqual(["1", "2"]);
    expect(events[0]!.detail!.length).toBe(2048);
    events[0]!.label = "mutated";
    expect(replay.events(udid)[0]!.label).toBe("1");
    now = 30_001;
    expect(replay.events(udid)).toEqual([]);
  });

  it("evicts old logs first so log bursts retain recent input, control and crash events within count and byte caps", () => {
    const replay = recorder({ now: () => 0, maxEvents: 4 });
    for (const kind of ["input", "control", "crash"] as const) replay.record(udid, { kind, actor: "system", label: kind });
    for (let index = 0; index < 10; index++) replay.record(udid, { kind: "log", actor: "system", label: `log ${index}` });
    expect(replay.events(udid).map(event => event.label)).toEqual(["input", "control", "crash", "log 9"]);

    const byBytes = recorder({ now: () => 0 });
    for (const kind of ["input", "control", "crash"] as const) byBytes.record(udid, { kind, actor: "system", label: kind });
    for (let index = 0; index < 200; index++) byBytes.record(udid, { kind: "log", actor: "system", label: String(index), detail: "x".repeat(2048) });
    expect(byBytes.events(udid).slice(0, 3).map(event => event.kind)).toEqual(["input", "control", "crash"]);
    expect(byBytes.events(udid).length).toBeLessThan(203);
    expect(byBytes.status(udid, "a").bytes).toBeLessThanOrEqual(256 * 1024);
  });
});

function transport() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const cancelled = vi.fn();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("config")) return new Response(JSON.stringify({ width: 100, height: 200, orientation: "portrait" }));
    signals.push(init!.signal!);
    return new Response(new ReadableStream<Uint8Array>({ start(c) { streams.push(c); }, cancel() { cancelled(); } }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, streams, signals, cancelled };
}

describe("replay transport lifecycle", () => {
  it("ensures one subscription, polls config, and aborts readers/timers on stop", async () => {
    vi.useFakeTimers();
    const t = transport(), replay = recorder({ fetch: t.fetch, now: () => 0 });
    replay.ensure(udid, "http://test/stream", "http://test/config");
    replay.ensure(udid, "http://test/stream", "http://test/config");
    await flush();
    expect(t.streams).toHaveLength(1);
    t.streams[0]!.enqueue(joined(packet(AVCC_TAG.DESCRIPTION, description), packet(AVCC_TAG.KEYFRAME)));
    await flush();
    const saved = replay.save(udid, "a");
    expect(replay.clip(udid, saved.id, "a")!.frames[0]!.config).toEqual({ width: 100, height: 200, orientation: "portrait" });
    expect(replay.status(udid, "a").recording).toBe(true);
    replay.stop(udid); await flush();
    expect(t.signals[0]!.aborted).toBe(true);
    expect(t.cancelled).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.streams).toHaveLength(1);
    expect(replay.status(udid, "a").bytes).toBe(0);
  });

  it("reconnects after EOF and ignores prediction frames until the new connection's keyframe", async () => {
    vi.useFakeTimers();
    const t = transport(), replay = recorder({ fetch: t.fetch, now: () => 0, reconnectMs: 10 });
    replay.ensure(udid, "http://test/stream", "http://test/config"); await flush();
    t.streams[0]!.enqueue(joined(packet(AVCC_TAG.DESCRIPTION, description), packet(AVCC_TAG.KEYFRAME)));
    await flush(); t.streams[0]!.close(); await flush();
    expect(replay.status(udid, "a").recording).toBe(false);
    expect(replay.status(udid, "a").error).toMatch(/ended/);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.streams).toHaveLength(2);
    t.streams[1]!.enqueue(joined(packet(AVCC_TAG.DESCRIPTION, description), packet(AVCC_TAG.DELTA)));
    await flush();
    expect(replay.save(udid, "a").frameCount).toBe(1);
    t.streams[1]!.enqueue(packet(AVCC_TAG.KEYFRAME)); await flush();
    expect(replay.save(udid, "a").frameCount).toBe(2);
  });

  it("leaves recording state and retries even if an underlying stream cancellation hangs", async () => {
    vi.useFakeTimers();
    let count = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("config")) return new Response("{}");
      count++;
      return new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }));
    }) as unknown as typeof globalThis.fetch;
    const replay = recorder({ fetch, reconnectMs: 10, streamTimeoutMs: 100 });
    replay.ensure(udid, "http://test/stream", "http://test/config"); await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(replay.status(udid, "a").recording).toBe(false);
    expect(replay.status(udid, "a").error).toMatch(/stopped producing/);
    await vi.advanceTimersByTimeAsync(10);
    expect(count).toBe(2);
  });

  it("recovers failed fetches without a recording flag and disposal prevents new work", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof globalThis.fetch;
    const replay = recorder({ fetch, reconnectMs: 10 });
    replay.ensure(udid, "stream", "config"); await flush();
    expect(replay.status(udid, "a")).toMatchObject({ recording: false, error: "connection refused" });
    replay.dispose(); const calls = vi.mocked(fetch).mock.calls.length;
    replay.ensure(udid, "stream", "config"); replay.record(udid, { kind: "log", actor: "system", label: "late" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
    expect(replay.events(udid)).toEqual([]);
  });
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); kill = vi.fn(() => true);
}
function diagnostics(options: ReplayOptions = {}) {
  const children: FakeChild[] = [], watchers: { file: (name: string) => void; error: (e: Error) => void; close: ReturnType<typeof vi.fn> }[] = [];
  const spawn = vi.fn(() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; });
  const replay = recorder({ now: () => 0, spawn, watchReports(file, error) { const watcher = { file, error, close: vi.fn() }; watchers.push(watcher); return watcher; }, ...options });
  return { replay, children, watchers, spawn };
}
function report(id = bundle, device = udid, pid = 42) {
  return JSON.stringify({ app_name: "MyApp", bundleID: id, bug_type: "309" }) + "\n" + JSON.stringify({ pid, procPath: `/Users/test/Library/Developer/CoreSimulator/Devices/${device}/data/Containers/Bundle/Application/UUID/MyApp.app/MyApp`, exception: { type: "EXC_BAD_ACCESS" } });
}

describe("app-scoped diagnostics", () => {
  it("starts only the launched PID's log stream, bounds lines, and ignores unrelated messages", () => {
    const d = diagnostics({ maxEvents: 2 });
    d.replay.watchApp(udid, bundle, `${bundle}: 42\n`);
    expect(d.spawn).toHaveBeenCalledWith("xcrun", ["simctl", "spawn", udid, "log", "stream", "--process", "42", "--style", "ndjson", "--level", "debug"], { stdio: ["ignore", "pipe", "pipe"] });
    const out = d.children[0]!.stdout;
    out.emit("data", '{"processID":42,"eventMessage":"first');
    out.emit("data", ' log"}\n{"processID":43,"eventMessage":"other app"}\nnot json\n');
    out.emit("data", JSON.stringify({ processID: 42, eventMessage: "x".repeat(5000) }) + "\n");
    out.emit("data", JSON.stringify({ processID: 42, eventMessage: "last" }) + "\n");
    expect(d.replay.events(udid).map(e => e.detail)).toEqual(["x".repeat(2048), "last"]);
  });

  it("reports unavailable diagnostics without a verified launch PID or when OS tools fail", () => {
    const d = diagnostics();
    d.replay.watchApp(udid, bundle, "something else: 42");
    expect(d.spawn).not.toHaveBeenCalled();
    expect(d.replay.status(udid, "a").diagnostics).toMatch(/unavailable\. Relaunch/);
    d.replay.watchApp(udid, bundle, `${bundle}: 42`);
    d.children[0]!.emit("error", new Error("permission denied"));
    d.watchers[0]!.error(new Error("directory missing"));
    expect(d.replay.status(udid, "a").diagnostics).toBe("App logs unavailable. Relaunch the app to retry. Crash monitoring unavailable. Check DiagnosticReports access.");
    expect(d.replay.events(udid).map(event => event.detail)).toEqual(["permission denied", "directory missing"]);
  });

  it("ignores benign username lookup stderr and restores connected health after real warnings", () => {
    const d = diagnostics(); d.replay.watchApp(udid, bundle, `${bundle}: 42`);
    const child = d.children[0]!;
    expect(d.replay.status(udid, "a").diagnostics).toBe("App logs connecting. Crash monitoring active.");
    child.stderr.emit("data", "getpwuid_r failed to retrieve a username for uid 501\n");
    expect(d.replay.events(udid)).toEqual([]);
    child.stdout.emit("data", '{"processID":42,"eventMessage":"marker"}\n');
    expect(d.replay.status(udid, "a").diagnostics).toBe("App logs connected. Crash monitoring active.");
    child.stderr.emit("data", "getpwuid_r failed for uid 501\nA real log warning\n");
    expect(d.replay.status(udid, "a").diagnostics).toBe("App log stream reported a warning. Crash monitoring active.");
    expect(d.replay.events(udid).at(-1)).toMatchObject({ kind: "error", detail: "A real log warning" });
    child.stdout.emit("data", '{"processID":43,"eventMessage":"unrelated"}\n');
    expect(d.replay.status(udid, "a").diagnostics).toMatch(/reported a warning/);
    child.stdout.emit("data", '{"processID":42,"eventMessage":"next marker"}\n');
    expect(d.replay.status(udid, "a").diagnostics).toBe("App logs connected. Crash monitoring active.");
  });

  it("accepts crash metadata only when bundle, process and simulator identities all match", () => {
    expect(matchingCrashSummary(report(), bundle, udid, 42)).toBe("MyApp: EXC_BAD_ACCESS");
    expect(matchingCrashSummary(report("other.app"), bundle, udid, 42)).toBeNull();
    expect(matchingCrashSummary(report(bundle, "other-device"), bundle, udid, 42)).toBeNull();
    expect(matchingCrashSummary(report(bundle, udid, 43), bundle, udid, 42)).toBeNull();
    expect(matchingCrashSummary('{"bundleID":"dev.example.MyApp"}\n{"pid":42}', bundle, udid, 42)).toBeNull();
    expect(matchingCrashSummary("invalid JSON", bundle, udid, 42)).toBeNull();
    expect(matchingCrashSummary(report().replace('"bug_type":"309"', '"bug_type":"288"'), bundle, udid, 42)).toBeNull();
  });

  it("matches the anonymized structure of the runtime fixture's real fatalError report", () => {
    const text = '{"app_name":"ReplayFixture","timestamp":"2026-01-01 12:00:00.00 +0000","bundleID":"com.bb.simulator.replayfixture","bug_type":"309"}\n' +
      JSON.stringify({ procName: "ReplayFixture", pid: 1234,
        procPath: `/Users/test/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/EXAMPLE/ReplayFixture.app/ReplayFixture`,
        bundleInfo: { CFBundleIdentifier: "com.bb.simulator.replayfixture" },
        exception: { codes: "0x0000000000000001, 0x0000000000000000", rawCodes: [1, 0], type: "EXC_BREAKPOINT", signal: "SIGTRAP" } });
    expect(matchingCrashSummary(text, "com.bb.simulator.replayfixture", udid, 1234)).toBe("ReplayFixture: EXC_BREAKPOINT");
  });

  it("reads only new .ips filenames, stores matching summaries once, and ignores late reports after cleanup", async () => {
    vi.useFakeTimers();
    let finish: ((text: string) => void) | undefined;
    const readReport = vi.fn(async (name: string) => name === "late.ips" ? new Promise<string>(resolve => { finish = resolve; }) : report());
    const d = diagnostics({ readReport }); d.replay.watchApp(udid, bundle, `${bundle}: 42`);
    const watcher = d.watchers[0]!;
    watcher.file("../private.ips"); watcher.file("not-a-report.txt");
    expect(readReport).not.toHaveBeenCalled();
    watcher.file("MyApp.ips"); await vi.advanceTimersByTimeAsync(250); watcher.file("MyApp.ips"); await flush();
    expect(readReport).toHaveBeenCalledTimes(1);
    expect(d.replay.events(udid)).toMatchObject([{ kind: "crash", detail: "MyApp: EXC_BAD_ACCESS" }]);
    watcher.file("late.ips"); await vi.advanceTimersByTimeAsync(250); d.replay.stop(udid); finish!(report()); await flush();
    expect(d.replay.events(udid)).toEqual([]);
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(d.children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries partial metadata while follow-up notifications and another report arrive during a read", async () => {
    vi.useFakeTimers();
    let finish: ((text: string) => void) | undefined;
    let ownReads = 0;
    const readReport = vi.fn(async (name: string) => {
      if (name === "foreign.ips") return report("other.app");
      ownReads++;
      return ownReads === 1 ? new Promise<string>(resolve => { finish = resolve; }) : report();
    });
    const d = diagnostics({ readReport }); d.replay.watchApp(udid, bundle, `${bundle}: 42`);
    const watcher = d.watchers[0]!;
    watcher.file("MyApp.ips"); await vi.advanceTimersByTimeAsync(250);
    watcher.file("MyApp.ips"); watcher.file("foreign.ips");
    finish!('{"bundleID":'); await flush();
    await vi.advanceTimersByTimeAsync(1500);
    watcher.file("MyApp.ips"); await vi.advanceTimersByTimeAsync(1000);
    expect(ownReads).toBe(2);
    expect(readReport.mock.calls.filter(([name]) => name === "foreign.ips")).toHaveLength(3);
    expect(d.replay.events(udid).filter(event => event.kind === "crash")).toMatchObject([{ detail: "MyApp: EXC_BAD_ACCESS" }]);
  });

  it("retries files not yet present, caps the new-report queue, and cancels pending retries on relaunch/disposal", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const readReport = vi.fn(async () => { if (++reads === 1) throw Object.assign(new Error("not present"), { code: "ENOENT" }); return report(); });
    const d = diagnostics({ readReport }); d.replay.watchApp(udid, bundle, `${bundle}: 42`);
    d.watchers[0]!.file("created.ips"); await vi.advanceTimersByTimeAsync(500);
    expect(d.replay.events(udid).filter(event => event.kind === "crash")).toHaveLength(1);
    d.watchers[0]!.file("pending.ips");
    d.replay.watchApp(udid, bundle, `${bundle}: 43`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readReport).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 100; index++) d.watchers[1]!.file(`queued-${index}.ips`);
    // There are at most 16 queued files, each with at most three attempts.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readReport).toHaveBeenCalledTimes(2 + 16 * 3);
    d.watchers[1]!.file("dispose.ips"); d.replay.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(readReport).toHaveBeenCalledTimes(2 + 16 * 3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces scoped watchers/processes on app relaunch and removes stream listeners on disposal", () => {
    const d = diagnostics(); d.replay.watchApp(udid, bundle, `${bundle}: 42`);
    d.replay.watchApp(udid, bundle, `${bundle}: 43`);
    expect(d.watchers[0]!.close).toHaveBeenCalledOnce();
    expect(d.children[0]!.kill).toHaveBeenCalledOnce();
    expect(d.children[0]!.stdout.listenerCount("data")).toBe(0);
    d.children[0]!.stdout.emit("data", '{"eventMessage":"late"}\n');
    expect(d.replay.events(udid)).toEqual([]);
    d.replay.dispose();
    expect(d.children[1]!.stdout.listenerCount("data")).toBe(0);
    expect(d.watchers[1]!.close).toHaveBeenCalledOnce();
    expect(d.children[1]!.kill).toHaveBeenCalledOnce();
  });
});
