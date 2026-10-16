// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { deviceKindFor, fitDevice, shortcutFor } from "./components/simulator-panel";
import { BEZEL_PARTS, fitBezel, type DeviceBezel } from "./lib/device-bezel";
import { decodeHid, encodeHid, HID } from "./lib/sim-protocol";
import * as videoStream from "./components/video-stream";
import * as replayPlayer from "./components/replay-player";

const REPLAY_STATUS = { recording: false, bufferedMs: 0, bytes: 0, error: null, app: null, diagnostics: null, clips: [] };
const STATE = {
  ready: { ok: false, problems: ["Node.js 20 or newer was not found on PATH."], xcode: "/x", node: null, serveSim: "/s" },
  devices: [
    { udid: "AAAA-2", name: "iPhone 17", state: "Booted", runtime: "iOS 26.0", runtimeId: "r", deviceType: null, isAvailable: true },
    { udid: "AAAA-1", name: "iPhone 17 Pro", state: "Shutdown", runtime: "iOS 26.0", runtimeId: "r", deviceType: null, isAvailable: true },
  ],
  sessions: [],
  attached: [],
  bootedByPlugin: [],
  consent: {},
  controls: {
    "AAAA-2": { threadId: "thr_1", mode: "human", changedAt: 1 },
    "AAAA-1": { threadId: "thr_1", mode: "human", changedAt: 1 },
  },
  replay: {},
  inputShadowed: [],
  agentControl: "ask",
  error: null,
};

describe("iOS Simulator app", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("registers the panel action, overlay, and consent form", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["simulator"]);
    expect(app.pendingInteractions.map((slot) => slot.id)).toEqual(["device-consent"]);
    expect(app.threadHeaderActions.map((slot) => slot.id)).toEqual(["open-simulator"]);
  });

  it("opens the simulator directly from the thread header", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, {
      threadId: "thr_1", projectId: "p", isCompactViewport: false,
    }, { context: { projectId: "p", threadId: "thr_1" } });
    fireEvent.click(slot.getByRole("button", { name: "Open Simulator" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "simulator" } },
    ]);
    slot.lifecycle.unmount();
  });

  it("renders devices and setup problems from the state rpc", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      { rpc: { timeline: () => [], replayState: () => REPLAY_STATUS, state: () => STATE }, context: { projectId: "p", threadId: "thr_1" } },
    );
    await slot.findByText(/Node\.js 20 or newer/);
    fireEvent.click(slot.getByRole("combobox", { name: "Simulator device" }));
    expect(slot.getByRole("option", { name: /iPhone 17 Pro/ })).toBeTruthy();
    expect(slot.getByRole("button", { name: /Attach/ })).toBeTruthy();
    expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "state" });
    slot.lifecycle.unmount();
  });

  it("selects the newly attached device and reselects it on explicit reattach", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let attached = ["AAAA-2"];
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => REPLAY_STATUS, state: () => ({ ...STATE, attached }) },
      context: { projectId: "p", threadId: "thr_1" },
    });
    const select = await slot.findByRole("combobox", { name: "Simulator device" });
    await slot.findByText("iPhone 17", { exact: true });
    attached = ["AAAA-1", "AAAA-2"];
    await slot.behavior.emitRealtime("attached", { threadId: "thr_1", udid: "AAAA-1" });
    await slot.findByText("iPhone 17 Pro", { exact: true });
    fireEvent.click(select);
    fireEvent.click(slot.getByRole("option", { name: /^iPhone 17(?! Pro)/ }));
    await slot.behavior.emitRealtime("attached", { threadId: "thr_1", udid: "AAAA-1" });
    await slot.findByText("iPhone 17 Pro", { exact: true });
    await slot.behavior.emitRealtime("attached", { threadId: "thr_other", udid: "AAAA-2" });
    expect(slot.getByText("iPhone 17 Pro", { exact: true })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("uses the promoted default on mount and preserves manual choice during refresh", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const state = vi.fn(() => ({ ...STATE, attached: ["AAAA-1", "AAAA-2"] }));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => REPLAY_STATUS, state }, context: { projectId: "p", threadId: "thr_1" },
    });
    const select = await slot.findByRole("combobox", { name: "Simulator device" });
    await slot.findByText("iPhone 17 Pro", { exact: true });
    fireEvent.click(select);
    fireEvent.click(slot.getByRole("option", { name: /^iPhone 17(?! Pro)/ }));
    const before = state.mock.calls.length;
    await slot.behavior.emitRealtime("sessions-changed", {});
    await waitFor(() => expect(state.mock.calls.length).toBeGreaterThan(before));
    expect(slot.getByText("iPhone 17", { exact: true })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("opens the same panel action on attach without creating a device-specific tab", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.appOverlays[0]!, {}, { context: { projectId: "p", threadId: "thr_1" } });
    await slot.behavior.emitRealtime("attached", { threadId: "thr_1", udid: "AAAA-1" });
    await slot.behavior.emitRealtime("attached", { threadId: "thr_1", udid: "AAAA-2" });
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "simulator" } },
      { method: "openThreadPanel", options: { actionId: "simulator" } },
    ]);
    slot.lifecycle.unmount();
  });

  it("fits a bezelled device inside the available box", () => {
    const tall = fitDevice({ width: 400, height: 900 }, 9 / 19.5, "phone");
    expect(tall.frameHeight).toBeLessThanOrEqual(900 - 32 + 0.01);
    expect(tall.frameWidth).toBeLessThanOrEqual(400 - 32 + 0.01);
    expect(tall.screenWidth / tall.screenHeight).toBeCloseTo(9 / 19.5, 5);
    const wide = fitDevice({ width: 300, height: 900 }, 9 / 19.5, "phone");
    expect(wide.frameWidth).toBeCloseTo(300 - 32, 3);
    const landscape = fitDevice({ width: 900, height: 400 }, 19.5 / 9, "phone");
    expect(landscape.frameWidth).toBeLessThanOrEqual(868);
    expect(landscape.frameHeight).toBeLessThanOrEqual(368);
    expect(landscape.screenRadius).toBeCloseTo(tall.screenRadius);
    expect(deviceKindFor("iPad Pro 13-inch (M5)")).toBe("tablet");
    expect(deviceKindFor("iPhone 17 Pro")).toBe("phone");
  });

  it("keeps the screen aligned with local Xcode artwork through rotation", () => {
    const frame: DeviceBezel = {
      source: "xcode", width: 438, height: 910,
      screen: { x: 18, y: 18, width: 402, height: 874, cornerRadius: 62 },
      layers: BEZEL_PARTS.map((id) => ({ id, x: 0, y: 0, width: 1, height: 1 })),
    };
    const upright = fitBezel({ width: 500, height: 1000 }, frame, 0);
    expect(upright.screenWidth / upright.screenHeight).toBeCloseTo(402 / 874);
    expect(upright.frameHeight).toBeLessThanOrEqual(968);
    const landscape = fitBezel({ width: 800, height: 500 }, frame, 90);
    expect(landscape.angle).toBe(90);
    expect(landscape.screenWidth / landscape.screenHeight).toBeCloseTo(874 / 402);
    expect(landscape.screenX + landscape.screenWidth).toBeLessThan(landscape.frameWidth);
    expect(landscape.screenY + landscape.screenHeight).toBeLessThan(landscape.frameHeight);
  });

  it.each([
    { mode: "mjpeg", frame: "xcode", rawLandscape: false },
    { mode: "video", frame: "xcode", rawLandscape: false },
    { mode: "mjpeg", frame: "fallback", rawLandscape: false },
    { mode: "video", frame: "xcode", rawLandscape: true },
  ])("aligns landscape $mode/$frame and swipe coordinates (raw landscape: $rawLandscape)", async ({ mode, frame, rawLandscape }) => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let socket!: Socket;
    class Socket {
      static OPEN = 1;
      readyState = 1;
      onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
      send = vi.fn();
      constructor() { socket = this; }
      close() {}
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    const bezel: DeviceBezel = {
      source: "xcode", width: 436, height: 908,
      screen: { x: 17, y: 17, width: 402, height: 874, cornerRadius: 62, mask: true },
      layers: [{ id: "composite", x: 0, y: 0, width: 436, height: 908 }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => frame === "xcode" ? bezel : null })));
    vi.spyOn(videoStream, "webCodecsAvailable").mockReturnValue(mode === "video");
    vi.spyOn(videoStream, "startVideoStream").mockImplementation((_url, _canvas, callbacks) => {
      callbacks.onSize?.(rawLandscape ? 2622 : 1206, rawLandscape ? 1206 : 2622);
      return { stop() {} };
    });
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => REPLAY_STATUS, state: () => ({ ...STATE, ready: { ...STATE.ready, ok: true, problems: [] },
        attached: ["AAAA-2"], sessions: [{ udid: "AAAA-2", port: 1234, startedAt: 1 }] }) },
      context: { projectId: "p", threadId: "thr_1" },
    });
    const surface = await slot.findByRole("application");
    await waitFor(() => expect(socket).toBeDefined());
    await act(async () => socket.onmessage?.({ data: encodeHid(0, { width: 1206, height: 2622, orientation: "landscape_right" }).buffer as ArrayBuffer }));
    const content = surface.querySelector<HTMLCanvasElement | HTMLImageElement>(mode === "video" ? "canvas" : "img")!;
    await waitFor(() => expect(surface.parentElement?.getAttribute("data-bezel")).toBe(frame));
    expect(Number.parseFloat(surface.style.width)).toBeGreaterThan(Number.parseFloat(surface.style.height));
    expect(content.style.transform).toBe(rawLandscape ? "rotate(0deg)" : "rotate(270deg)");
    expect(content.style.width).toBe(rawLandscape ? surface.style.width : surface.style.height);
    expect(content.style.height).toBe(rawLandscape ? surface.style.height : surface.style.width);
    if (frame === "xcode") expect(surface.style.maskImage).toContain("rotation=270");
    expect((surface.parentElement?.firstElementChild as HTMLElement).style.transform).toBe("rotate(270deg)");
    surface.setPointerCapture = vi.fn();
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 874, height: 402 } as DOMRect);
    fireEvent.pointerDown(surface, { button: 0, clientX: 10 + 874 * 0.03, clientY: 20 + 402 * 0.35 });
    fireEvent.pointerMove(surface, { clientX: 10 + 874 * 0.18, clientY: 20 + 402 * 0.6 });
    fireEvent.pointerUp(surface, { clientX: 10 + 874 * 0.22, clientY: 20 + 402 * 0.7 });
    expect(socket.send.mock.calls.map(([data]) => decodeHid(data))).toEqual([
      { opcode: HID.TOUCH, payload: { type: "begin", x: expect.closeTo(rawLandscape ? 0.03 : 0.65), y: expect.closeTo(rawLandscape ? 0.35 : 0.03) } },
      { opcode: HID.TOUCH, payload: { type: "move", x: expect.closeTo(rawLandscape ? 0.18 : 0.4), y: expect.closeTo(rawLandscape ? 0.6 : 0.18) } },
      { opcode: HID.TOUCH, payload: { type: "end", x: expect.closeTo(rawLandscape ? 0.22 : 0.3), y: expect.closeTo(rawLandscape ? 0.7 : 0.22) } },
    ]);
    slot.lifecycle.unmount();
  });

  it("pastes clipboard text into the attached simulator while retaining the fallback frame", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("WebSocket", class { close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => null })));
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => REPLAY_STATUS,
        state: () => ({ ...STATE, ready: { ...STATE.ready, ok: true, problems: [] },
          attached: ["AAAA-2"], sessions: [{ udid: "AAAA-2", port: 1234, startedAt: 1 }] }),
        pasteText: () => ({ ok: true }),
      },
      context: { projectId: "p", threadId: "thr_1" },
    });
    const surface = await slot.findByRole("application");
    const text = "Hello, 世界 👋";
    fireEvent.paste(surface, { clipboardData: { getData: () => text } });
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({
      method: "pasteText", input: { threadId: "thr_1", udid: "AAAA-2", text },
    }));
    expect(surface.parentElement?.getAttribute("data-bezel")).toBe("fallback");
    slot.lifecycle.unmount();
  });

  it("requires explicit human control for panel input and sends scoped handoffs", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const sockets: string[] = [];
    const send = vi.fn();
    vi.stubGlobal("WebSocket", class {
      static OPEN = 1; readyState = 1; send = send;
      constructor(url: string) { sockets.push(url); }
      close() {}
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => null })));
    let controller = { threadId: "thr_other", mode: "agent", changedAt: 1 };
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => REPLAY_STATUS,
        state: () => ({ ...STATE, ready: { ...STATE.ready, ok: true, problems: [] },
          controls: { "AAAA-2": controller }, attached: ["AAAA-2"], sessions: [{ udid: "AAAA-2", port: 1, startedAt: 1 }] }),
        control: (input: { mode: string }) => { controller = { threadId: "thr_1", mode: input.mode, changedAt: 2 }; return controller; },
        pasteText: () => ({ ok: true }),
      }, context: { projectId: "p", threadId: "thr_1" },
    });
    const surface = await slot.findByRole("application");
    await slot.findByText("Viewing another thread");
    expect(surface.getAttribute("aria-disabled")).toBe("true");
    expect((slot.getByRole("button", { name: "Home (⌘⇧H)" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(surface, { key: "a" });
    fireEvent.paste(surface, { clipboardData: { getData: () => "blocked" } });
    expect(send).not.toHaveBeenCalled();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "pasteText")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText("You’re driving");
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "control", input: { threadId: "thr_1", udid: "AAAA-2", mode: "human" } });
    expect(surface.getAttribute("aria-disabled")).toBe("false");
    fireEvent.paste(surface, { clipboardData: { getData: () => "allowed" } });
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "pasteText", input: { threadId: "thr_1", udid: "AAAA-2", text: "allowed" } }));
    fireEvent.click(slot.getByRole("button", { name: "Let agent drive" }));
    await slot.findByText("Agent driving");
    fireEvent.keyDown(surface, { key: "b" });
    fireEvent.paste(surface, { clipboardData: { getData: () => "blocked again" } });
    expect(send).not.toHaveBeenCalled();
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "pasteText")).toHaveLength(1);
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "control", input: { threadId: "thr_1", udid: "AAAA-2", mode: "agent" } });
    expect(sockets[0]).toContain("threadId=thr_1");
    slot.lifecycle.unmount();
  });

  it("isolates replay from live input even while this human owns the device", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const send = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; send = send; close = close; });
    vi.spyOn(videoStream, "webCodecsAvailable").mockReturnValue(false);
    const player = { seek: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), dispose: vi.fn() };
    vi.spyOn(replayPlayer, "createReplayPlayer").mockReturnValue(player);
    const clip = { id: "clip_1", udid: "AAAA-2", threadId: "thr_1", startAt: 1000, endAt: 1600, createdAt: 2000,
      frameCount: 1, description: "AWQAHg==", frames: [], events: [] };
    const replay = { ...REPLAY_STATUS, recording: true, bufferedMs: 600, clips: [clip] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("/replay?") ? clip : null })));
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => replay,
        state: () => ({ ...STATE, ready: { ...STATE.ready, ok: true, problems: [] }, replay: { "AAAA-2": replay },
          attached: ["AAAA-2"], sessions: [{ udid: "AAAA-2", port: 1, startedAt: 1 }] }),
      }, context: { projectId: "p", threadId: "thr_1" },
    });
    await slot.findByRole("application");
    fireEvent.click(slot.getByRole("button", { name: "Replay", exact: true }));
    const canvas = await slot.findByLabelText("Saved simulator replay");
    await waitFor(() => expect(slot.queryByRole("application")).toBeNull());
    expect(slot.queryByRole("group", { name: "Simulator controls" })).toBeNull();
    fireEvent.keyDown(canvas, { key: "a" });
    fireEvent.paste(canvas, { clipboardData: { getData: () => "do not type into live device" } });
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Live", exact: true }));
    const live = await slot.findByRole("application");
    expect(live.getAttribute("aria-disabled")).toBe("false");
    await waitFor(() => expect(player.dispose).toHaveBeenCalledTimes(1));
    slot.lifecycle.unmount();
  });

  it("does not offer handoff or poll replay for a device this thread has not attached", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("WebSocket", class { close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => null })));
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => REPLAY_STATUS,
        state: () => ({ ...STATE, ready: { ...STATE.ready, ok: true, problems: [] }, attached: ["AAAA-2"],
          sessions: [{ udid: "AAAA-2", port: 1, startedAt: 1 }, { udid: "AAAA-1", port: 2, startedAt: 1 }] }),
      }, context: { projectId: "p", threadId: "thr_1" },
    });
    await slot.findByRole("application");
    const select = slot.getByRole("combobox", { name: "Simulator device" });
    fireEvent.click(select);
    fireEvent.click(slot.getByRole("option", { name: /iPhone 17 Pro/ }));
    await slot.findByRole("button", { name: "Attach", exact: true });
    expect(slot.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Let agent drive" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Capture 30s" })).toBeNull();
    expect((slot.getByRole("button", { name: "Home (⌘⇧H)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.inspection.rpcCalls.filter((call) => ["timeline", "replayState", "control"].includes(call.method))
      .some((call) => (call.input as { udid?: string }).udid === "AAAA-1")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("maps Apple Simulator shortcuts", () => {
    expect(shortcutFor({ key: "H", metaKey: true, ctrlKey: false, shiftKey: true })).toEqual({ button: "home" });
    expect(shortcutFor({ key: "l", metaKey: true, ctrlKey: false, shiftKey: false })).toEqual({ button: "lock" });
    expect(shortcutFor({ key: "ArrowRight", metaKey: true, ctrlKey: false, shiftKey: false })).toEqual({ rotate: true });
    expect(shortcutFor({ key: "a", metaKey: false, ctrlKey: false, shiftKey: false })).toBeNull();
  });

  it("dispatches toolbar actions and keeps only the pending control disabled", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("WebSocket", class { close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => null })));
    let finish!: (result: { ok: true }) => void;
    const pending = new Promise<{ ok: true }>((resolve) => { finish = resolve; });
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => REPLAY_STATUS,
        state: () => ({ ...STATE, ready: { ...STATE.ready, ok: true, problems: [] },
          attached: ["AAAA-2"], sessions: [{ udid: "AAAA-2", port: 1234, startedAt: 1 }] }),
        button: () => pending,
      },
      context: { projectId: "p", threadId: "thr_1" },
    });
    const home = await slot.findByRole("button", { name: "Home (⌘⇧H)" });
    fireEvent.click(home);
    fireEvent.click(home);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "button")).toHaveLength(1));
    expect(home.getAttribute("aria-busy")).toBe("true");
    expect((home as HTMLButtonElement).disabled).toBe(true);
    expect(slot.queryByRole("button", { name: "Volume up (⌘↑)" })).toBeNull();
    const options = slot.getByRole("button", { name: "Device options" });
    fireEvent.click(options);
    expect(options.getAttribute("aria-expanded")).toBe("true");
    expect((slot.getByRole("button", { name: "Volume up (⌘↑)" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(slot.queryByRole("button", { name: "Volume up (⌘↑)" })).toBeNull();
    expect(document.activeElement).toBe(options);
    finish({ ok: true });
    await waitFor(() => expect((home as HTMLButtonElement).disabled).toBe(false));
    slot.lifecycle.unmount();
  });

  it("advances repeated rotations while the simulator config is still catching up", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("WebSocket", class { close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => null })));
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: { timeline: () => [], replayState: () => REPLAY_STATUS,
        state: () => ({ ...STATE, ready: { ...STATE.ready, ok: true, problems: [] },
          attached: ["AAAA-2"], sessions: [{ udid: "AAAA-2", port: 1234, startedAt: 1 }] }),
        rotate: () => ({ ok: true }),
      },
      context: { projectId: "p", threadId: "thr_1" },
    });
    const rotate = await slot.findByRole("button", { name: "Rotate (⌘→)" });
    fireEvent.click(rotate);
    await waitFor(() => expect((rotate as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(rotate);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "rotate")).toEqual([
      { method: "rotate", input: { threadId: "thr_1", udid: "AAAA-2", orientation: "landscape_right" } },
      { method: "rotate", input: { threadId: "thr_1", udid: "AAAA-2", orientation: "portrait_upside_down" } },
    ]));
    slot.lifecycle.unmount();
  });
});
