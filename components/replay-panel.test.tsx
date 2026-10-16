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
    const slot = renderSlot({ component: ReplayPanel }, { base: "/plugin", threadId: "thr_1", udid: "device", status: STATUS, onModeChange, onSaved() {}, children: <div>Live device</div> }, {
      rpc: { timeline: () => [], replayState: () => STATUS, saveReplay: () => CLIP },
    });
    expect(slot.getByText("Live device")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Activity" }).getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByText("App logs available")).toBeNull();
    expect(slot.queryByRole("link", { name: "Download replay JSON" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Capture 30s" }));
    await slot.findByRole("slider", { name: "Replay position" });
    await waitFor(() => expect(instance.seek).toHaveBeenCalledWith(1000));
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "saveReplay", input: { threadId: "thr_1", udid: "device" } });
    expect(fetch.mock.calls[0]![0]).toContain("threadId=thr_1&id=clip_1");
    expect(slot.queryByText("Live device")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Activity" }));
    expect(slot.getByRole("region", { name: "Replay activity" })).toBeTruthy();
    const download = slot.getByRole("link", { name: "Download replay JSON" });
    expect(download.getAttribute("download")).toBe("simulator-replay-clip_1.json");
    expect(download.getAttribute("href")).toContain("download=1");
    fireEvent.click(slot.getByRole("button", { name: /Tapped Search/ }));
    expect(instance.seek).toHaveBeenLastCalledWith(1300);
    expect(slot.queryByRole("application")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Live", exact: true }));
    await waitFor(() => expect(instance.dispose).toHaveBeenCalledTimes(1));
    expect(slot.getByText("Live device")).toBeTruthy();
    expect(onModeChange).toHaveBeenLastCalledWith(false);
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    slot.lifecycle.unmount();
  });

  it("polls lightweight readiness, fetches live activity only while open, and stops on unmount", async () => {
    vi.useFakeTimers();
    let ready = false;
    const state = vi.fn(() => ({ ...STATUS, recording: ready, bufferedMs: ready ? 600 : 0 }));
    const events = Array.from({ length: 150 }, (_, index) => ({ id: String(index), at: index, kind: "log", actor: "system", label: `Log ${index}` }));
    const timeline = vi.fn(() => events);
    const slot = renderSlot({ component: ReplayPanel }, { base: "/plugin", threadId: "thr_1", udid: "device", status: undefined, onModeChange() {}, onSaved() {} }, {
      rpc: { timeline, replayState: state },
    });
    await act(async () => { await Promise.resolve(); });
    expect((slot.getByRole("button", { name: "Capture 30s" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.queryByText("Log 0")).toBeNull();
    expect(slot.queryByText("Log 149")).toBeNull();
    expect(timeline).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(state).toHaveBeenCalledTimes(2);
    expect(timeline).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Activity" })); });
    expect(slot.getByText("Log 149")).toBeTruthy();
    expect(slot.queryByText("Log 49")).toBeNull();
    expect(timeline).toHaveBeenCalledTimes(1);
    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect((slot.getByRole("button", { name: "Capture 30s" }) as HTMLButtonElement).disabled).toBe(false);
    expect(state).toHaveBeenCalledTimes(4);
    expect(timeline).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Activity" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(timeline).toHaveBeenCalledTimes(2);
    const callsBeforeUnmount = state.mock.calls.length;
    slot.lifecycle.unmount();
    await vi.advanceTimersByTimeAsync(4000);
    expect(state).toHaveBeenCalledTimes(callsBeforeUnmount);
    expect(slot.inspection.rpcCalls.every((call) => call.method === "replayState" || call.method === "timeline")).toBe(true);
  });

  it("keeps replay transport and event highlighting synchronized without polling live data", async () => {
    vi.useFakeTimers();
    let callbacks: Parameters<typeof playback.createReplayPlayer>[2] | undefined;
    const instance = { seek: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), dispose: vi.fn() };
    vi.spyOn(playback, "createReplayPlayer").mockImplementation((_canvas, _clip, next) => { callbacks = next; return instance; });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => CLIP })));
    const state = vi.fn(() => STATUS);
    const timeline = vi.fn(() => []);
    const slot = renderSlot({ component: ReplayPanel }, { base: "/plugin", threadId: "thr_1", udid: "device", status: STATUS, onModeChange() {}, onSaved() {} }, {
      rpc: { timeline, replayState: state },
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Replay", exact: true })); });
    expect(callbacks).toBeDefined();
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Activity" })); });
    const stateCalls = state.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(state).toHaveBeenCalledTimes(stateCalls);
    expect(timeline).not.toHaveBeenCalled();
    const slider = slot.getByRole("slider", { name: "Replay position" }) as HTMLInputElement;
    const event = slot.getByRole("button", { name: /Tapped Search/ });
    act(() => callbacks!.onTime(1200));
    expect(slider.value).toBe("1200");
    expect(event.getAttribute("aria-current")).toBeNull();
    act(() => callbacks!.onTime(1300));
    expect(event.getAttribute("aria-current")).toBe("true");
    act(() => callbacks!.onTime(1400));
    expect(slider.value).toBe("1400");
    expect(event.getAttribute("aria-current")).toBe("true");
    await act(async () => { fireEvent.click(slot.getByRole("button", { name: "Live", exact: true })); });
    expect(state).toHaveBeenCalledTimes(stateCalls + 1);
    expect(timeline).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  });

  it("does not switch another device into replay when a save finishes after unmount", async () => {
    let finish!: (clip: ReplayClip) => void;
    const pending = new Promise<ReplayClip>((resolve) => { finish = resolve; });
    const onModeChange = vi.fn();
    const slot = renderSlot({ component: ReplayPanel }, { base: "/plugin", threadId: "thr_1", udid: "device", status: STATUS, onModeChange, onSaved() {} }, {
      rpc: { timeline: () => [], replayState: () => STATUS, saveReplay: () => pending },
    });
    fireEvent.click(slot.getByRole("button", { name: "Capture 30s" }));
    slot.lifecycle.unmount();
    await act(async () => { finish(CLIP); await pending; });
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("reveals an empty activity drawer without replacing the live device", async () => {
    const slot = renderSlot({ component: ReplayPanel }, { base: "/plugin", threadId: "thr_1", udid: "device", status: STATUS, onModeChange() {}, onSaved() {}, children: <div>Live device</div> }, {
      rpc: { timeline: () => [], replayState: () => STATUS },
    });
    expect(slot.queryByRole("region", { name: "Recent activity" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Activity" }));
    expect(slot.getByText("No activity yet")).toBeTruthy();
    expect(slot.getByText("Live device")).toBeTruthy();
    expect(slot.getByText("App logs available")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Activity" }));
    expect(slot.queryByRole("region", { name: "Recent activity" })).toBeNull();
    expect(slot.queryByText("App logs available")).toBeNull();
    slot.lifecycle.unmount();
  });
});
