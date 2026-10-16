// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AndroidScreen } from "./android-panel";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Android screenshot preview", () => {
  it("does not overlap captures and aborts the request when the panel closes", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>((finish) => { resolve = finish; }));
    vi.stubGlobal("fetch", fetch);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:android-frame") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const view = render(<AndroidScreen url="/capture" agentActive={false} onTap={async () => {}} onSwipe={async () => {}} onButton={() => {}} />);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) } as Response); });
    expect(view.getByAltText("Android emulator screen").getAttribute("src")).toBe("blob:android-frame");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    const signal = fetch.mock.calls[1]?.[1].signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:android-frame");
  });

  it("keeps a clear capture error on screen and retries after a delay", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Emulator is offline" }) });
    vi.stubGlobal("fetch", fetch);
    const view = render(<AndroidScreen url="/capture" agentActive={false} onTap={async () => {}} onSwipe={async () => {}} onButton={() => {}} />);
    await act(async () => {});
    expect(view.getByRole("alert").textContent).toBe("Emulator is offline");
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
