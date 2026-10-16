// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { deviceKindFor, fitDevice, shortcutFor } from "./components/simulator-panel";
import { BEZEL_PARTS, fitBezel, type DeviceBezel } from "./lib/device-bezel";

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
  inputShadowed: [],
  agentControl: "ask",
  error: null,
};

describe("iOS Simulator app", () => {
  afterEach(() => vi.unstubAllGlobals());

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
      { rpc: { state: () => STATE }, context: { projectId: "p", threadId: "thr_1" } },
    );
    await slot.findByText(/Node\.js 20 or newer/);
    expect(slot.getByRole("option", { name: /iPhone 17 Pro/ })).toBeTruthy();
    expect(slot.getByRole("button", { name: /Attach/ })).toBeTruthy();
    expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "state" });
    slot.lifecycle.unmount();
  });

  it("fits a bezelled device inside the available box", () => {
    const tall = fitDevice({ width: 400, height: 900 }, 9 / 19.5, "phone");
    expect(tall.frameHeight).toBeLessThanOrEqual(900 - 32 + 0.01);
    expect(tall.frameWidth).toBeLessThanOrEqual(400 - 32 + 0.01);
    expect(tall.screenWidth / tall.screenHeight).toBeCloseTo(9 / 19.5, 5);
    const wide = fitDevice({ width: 300, height: 900 }, 9 / 19.5, "phone");
    expect(wide.frameWidth).toBeCloseTo(300 - 32, 3);
    expect(deviceKindFor("iPad Pro 13-inch (M5)")).toBe("tablet");
    expect(deviceKindFor("iPhone 17 Pro")).toBe("phone");
  });

  it("keeps the screen aligned with local Xcode artwork through rotation", () => {
    const frame: DeviceBezel = {
      source: "xcode", width: 438, height: 910,
      screen: { x: 18, y: 18, width: 402, height: 874, cornerRadius: 62 },
      layers: BEZEL_PARTS.map((id) => ({ id, x: 0, y: 0, width: 1, height: 1 })),
    };
    const upright = fitBezel({ width: 500, height: 1000 }, frame, "portrait", false);
    expect(upright.screenWidth / upright.screenHeight).toBeCloseTo(402 / 874);
    expect(upright.frameHeight).toBeLessThanOrEqual(968);
    const landscape = fitBezel({ width: 800, height: 500 }, frame, "landscape_left", true);
    expect(landscape.angle).toBe(270);
    expect(landscape.screenWidth / landscape.screenHeight).toBeCloseTo(874 / 402);
    expect(landscape.screenX + landscape.screenWidth).toBeLessThan(landscape.frameWidth);
    expect(landscape.screenY + landscape.screenHeight).toBeLessThan(landscape.frameHeight);
  });

  it("pastes clipboard text into the attached simulator while retaining the fallback frame", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("WebSocket", class { close() {} });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => null })));
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
      rpc: {
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
      method: "pasteText", input: { udid: "AAAA-2", text },
    }));
    expect(surface.parentElement?.getAttribute("data-bezel")).toBe("fallback");
    slot.lifecycle.unmount();
  });

  it("maps Apple Simulator shortcuts", () => {
    expect(shortcutFor({ key: "H", metaKey: true, ctrlKey: false, shiftKey: true })).toEqual({ button: "home" });
    expect(shortcutFor({ key: "l", metaKey: true, ctrlKey: false, shiftKey: false })).toEqual({ button: "lock" });
    expect(shortcutFor({ key: "ArrowRight", metaKey: true, ctrlKey: false, shiftKey: false })).toEqual({ rotate: true });
    expect(shortcutFor({ key: "a", metaKey: false, ctrlKey: false, shiftKey: false })).toBeNull();
  });
});
