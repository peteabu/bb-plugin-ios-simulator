import { describe, expect, it, vi } from "vitest";
import { SimulatorService, type KvLike } from "./simulator-service";
import type { Simctl, SimDevice } from "./simctl";
import type { StreamManager, StreamSession } from "./stream-manager";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const device = (udid = "PHONE", state = "Booted"): SimDevice => ({ udid, state, name: udid, runtime: "iOS 27", isAvailable: true });
const session = (udid = "PHONE"): StreamSession => ({ udid, port: 12345, pid: 1, startedAt: 0 });
async function flush() { for (let index = 0; index < 10; index++) await Promise.resolve(); }

async function setup(saved: string[] = []) {
  const simctl = { list: vi.fn(async (_signal?: AbortSignal) => [device(), device("OTHER")]), boot: vi.fn(async (_udid: string, _signal?: AbortSignal) => {}) };
  const streams = { ensure: vi.fn(async (udid: string, _signal?: AbortSignal) => session(udid)), stopAll: vi.fn(async () => {}), list: () => [] };
  const kv: KvLike = { get: vi.fn(async (key: string) => key === "attachments" ? { thread: saved } : []) as KvLike["get"], set: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const publish = vi.fn();
  const service = new SimulatorService({ simctl: simctl as unknown as Simctl, streams: streams as unknown as StreamManager, kv, publish,
    exec: async () => ({ stdout: "", stderr: "", code: 0 }), log: { debug() {}, info() {}, warn() {}, error() {} },
    idleShutdownMs: async () => 0, screenshotMaxDimension: async () => 1000 });
  await service.ready();
  return { service, simctl, streams, kv, publish };
}

describe("simulator service lifetime", () => {
  it("rejects new attachment after disposal without resolving or creating a helper", async () => {
    const s = await setup(); await s.service.dispose();
    await expect(s.service.attach("thread", "PHONE")).rejects.toThrow(/service has stopped/);
    expect(s.simctl.list).not.toHaveBeenCalled(); expect(s.streams.ensure).not.toHaveBeenCalled(); expect(s.publish).not.toHaveBeenCalled();
  });

  it("aborts pending resolution on disposal and cannot create a helper or attachment afterward", async () => {
    const s = await setup(), listed = deferred<SimDevice[]>(); s.simctl.list.mockReturnValueOnce(listed.promise);
    const pending = s.service.attach("thread", "PHONE"); await flush();
    const signal = s.simctl.list.mock.calls[0]![0]!;
    await s.service.dispose(); expect(signal.aborted).toBe(true); listed.resolve([device()]);
    await expect(pending).rejects.toThrow(/service has stopped/);
    expect(s.streams.ensure).not.toHaveBeenCalled(); expect(s.service.attachedTo("thread")).toEqual([]); expect(s.publish).not.toHaveBeenCalled();
  });

  it("does not track or stream a boot that completes after disposal", async () => {
    const s = await setup(), booted = deferred<void>();
    s.simctl.list.mockResolvedValueOnce([device("PHONE", "Shutdown")]); s.simctl.boot.mockReturnValueOnce(booted.promise);
    const pending = s.service.attach("thread", "PHONE"); await flush();
    await s.service.dispose(); booted.resolve();
    await expect(pending).rejects.toThrow(/service has stopped/);
    expect(s.streams.ensure).not.toHaveBeenCalled(); expect(s.service.bootedDevices()).toEqual([]); expect(s.publish).not.toHaveBeenCalled();
  });

  it("does not attach or publish after pending stream startup outlives disposal", async () => {
    const s = await setup(), started = deferred<StreamSession>(); s.streams.ensure.mockReturnValueOnce(started.promise);
    const pending = s.service.attach("thread", "PHONE"); await flush();
    const signal = s.streams.ensure.mock.calls[0]![1]!;
    await s.service.dispose(); expect(signal.aborted).toBe(true); started.resolve(session());
    await expect(pending).rejects.toThrow(/service has stopped/);
    expect(s.service.attachedTo("thread")).toEqual([]); expect(s.kv.set).not.toHaveBeenCalled(); expect(s.publish).not.toHaveBeenCalled();
  });

  it("does not publish an attachment when persistence completes after disposal", async () => {
    const s = await setup(), saved = deferred<void>(); vi.mocked(s.kv.set).mockReturnValueOnce(saved.promise);
    const pending = s.service.attach("thread", "PHONE"); await flush();
    expect(s.kv.set).toHaveBeenCalledOnce(); await s.service.dispose(); saved.resolve();
    await expect(pending).rejects.toThrow(/service has stopped/);
    expect(s.publish).not.toHaveBeenCalled(); expect(s.streams.stopAll).toHaveBeenCalledOnce();
  });

  it("retains caller cancellation alongside lifetime cancellation", async () => {
    const s = await setup(), listed = deferred<SimDevice[]>(), caller = new AbortController();
    s.simctl.list.mockReturnValueOnce(listed.promise);
    const pending = s.service.attach("thread", "PHONE", { signal: caller.signal }); await flush();
    const signal = s.simctl.list.mock.calls[0]![0]!; caller.abort(new Error("caller stopped"));
    expect(signal.aborted).toBe(true); listed.resolve([device()]);
    await expect(pending).rejects.toThrow("caller stopped");
    expect(s.streams.ensure).not.toHaveBeenCalled(); await s.service.dispose();
  });

  it("does not restore sessions or publish if device resolution outlives disposal", async () => {
    const s = await setup(["PHONE"]), listed = deferred<SimDevice[]>(); s.simctl.list.mockReturnValueOnce(listed.promise);
    const pending = s.service.restoreSessions(); await flush();
    await s.service.dispose(); listed.resolve([device()]); await pending;
    expect(s.streams.ensure).not.toHaveBeenCalled(); expect(s.publish).not.toHaveBeenCalled();
    await s.service.restoreSessions(); expect(s.simctl.list).toHaveBeenCalledOnce();
  });

  it("aborts restoration during stream startup and never restarts remaining devices or publishes", async () => {
    const s = await setup(["PHONE", "OTHER"]), started = deferred<StreamSession>(); s.streams.ensure.mockReturnValueOnce(started.promise);
    const pending = s.service.restoreSessions(); await flush();
    const signal = s.streams.ensure.mock.calls[0]![1]!;
    await s.service.dispose(); expect(signal.aborted).toBe(true); started.resolve(session()); await pending;
    expect(s.streams.ensure).toHaveBeenCalledOnce(); expect(s.publish).not.toHaveBeenCalled();
  });
});
