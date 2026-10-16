// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ReplayPanel } from "./replay-panel";
import * as playback from "./replay-player";
import type { ReplayClip, ReplayStatus } from "../lib/session-types";

const CLIP: ReplayClip = { id: "clip_1", udid: "device", threadId: "thr_1", createdAt: 2000, startAt: 1000, endAt: 1600,
  frameCount: 2, description: "AWQAHg==", frames: [], events: [{ id: "event", at: 1300, kind: "input", actor: "human", label: "Tapped Search" }] };
const STATUS: ReplayStatus = { recording: true, bufferedMs: 600, bytes: 100, app: "com.example.App", diagnostics: "App logs available", error: null, clips: [CLIP] };

describe("replay panel", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("saves a scoped replay, seeks from events, downloads JSON and disposes playback on Live", async () => {
    const instance = { seek: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), dispose: vi.fn() };
    vi.spyOn(playback, "createReplayPlayer").mockReturnValue(instance);
    const fetch = vi.fn(async () => ({ ok: true, json: async () => CLIP }));
    vi.stubGlobal("fetch", fetch);
    const onModeChange = vi.fn();
    const slot = renderSlot({ component: ReplayPanel }, { base: "/plugin", threadId: "thr_1", udid: "device", status: STATUS, onModeChange, onSaved() {} }, {
      rpc: { timeline: () => [], replayState: () => STATUS, saveReplay: () => CLIP },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save last 30s" }));
    await slot.findByRole("slider", { name: "Replay position" });
    await waitFor(() => expect(instance.seek).toHaveBeenCalledWith(1000));
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "saveReplay", input: { threadId: "thr_1", udid: "device" } });
    expect(fetch.mock.calls[0]![0]).toContain("threadId=thr_1&id=clip_1");
    const download = slot.getByRole("link", { name: "Download replay JSON" });
    expect(download.getAttribute("download")).toBe("simulator-replay-clip_1.json");
    expect(download.getAttribute("href")).toContain("download=1");
    fireEvent.click(slot.getByRole("button", { name: /Tapped Search/ }));
    expect(instance.seek).toHaveBeenLastCalledWith(1300);
    expect(slot.queryByRole("application")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Live", exact: true }));
    await waitFor(() => expect(instance.dispose).toHaveBeenCalledTimes(1));
    expect(onModeChange).toHaveBeenLastCalledWith(false);
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    slot.lifecycle.unmount();
  });

  it("polls lightweight status/activity, bounds live events and stops polling on unmount", async () => {
    vi.useFakeTimers();
    let ready = false;
    const state = vi.fn(() => ({ ...STATUS, recording: ready, bufferedMs: ready ? 600 : 0 }));
    const events = Array.from({ length: 150 }, (_, index) => ({ id: String(index), at: index, kind: "log", actor: "system", label: `Log ${index}` }));
    const slot = renderSlot({ component: ReplayPanel }, { base: "/plugin", threadId: "thr_1", udid: "device", status: undefined, onModeChange() {}, onSaved() {} }, {
      rpc: { timeline: () => events, replayState: state },
    });
    await act(async () => { await Promise.resolve(); });
    expect((slot.getByRole("button", { name: "Save last 30s" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.queryByText("Log 0")).toBeNull();
    expect(slot.getByText("Log 149")).toBeTruthy();
    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect((slot.getByRole("button", { name: "Save last 30s" }) as HTMLButtonElement).disabled).toBe(false);
    expect(state).toHaveBeenCalledTimes(2);
    slot.lifecycle.unmount();
    await vi.advanceTimersByTimeAsync(4000);
    expect(state).toHaveBeenCalledTimes(2);
    expect(slot.inspection.rpcCalls.every((call) => call.method === "replayState" || call.method === "timeline")).toBe(true);
  });

  it("does not switch another device into replay when a save finishes after unmount", async () => {
    let finish!: (clip: ReplayClip) => void;
    const pending = new Promise<ReplayClip>((resolve) => { finish = resolve; });
    const onModeChange = vi.fn();
    const slot = renderSlot({ component: ReplayPanel }, { base: "/plugin", threadId: "thr_1", udid: "device", status: STATUS, onModeChange, onSaved() {} }, {
      rpc: { timeline: () => [], replayState: () => STATUS, saveReplay: () => pending },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save last 30s" }));
    slot.lifecycle.unmount();
    await act(async () => { finish(CLIP); await pending; });
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
