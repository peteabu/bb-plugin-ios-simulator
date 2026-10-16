import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import {
  experimental_usePluginId as usePluginId, useRealtime, useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { AndroidState, androidRpcContract } from "../server/android";
import type { AndroidButton } from "../server/android-adb";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Initial Android transport: one bounded PNG capture at a time, about 1 fps. */
export function AndroidPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof androidRpcContract>();
  const pluginId = usePluginId();
  const base = `/api/v1/plugins/${pluginId}/http/android/screenshot`;
  const [state, setState] = useState<AndroidState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [agentActive, setAgentActive] = useState(false);
  const devices = state?.devices ?? [];
  const selectedDevice = devices.find((device) => device.id === selected || device.serial === selected)
    ?? devices.find((device) => device.serial && state?.attached.includes(device.serial)) ?? devices[0];
  const serial = selectedDevice?.serial ?? null;
  const attached = serial !== null && (state?.attached.includes(serial) ?? false);

  const refetch = useCallback(() => {
    rpc.call("androidState", { threadId }).then((next) => {
      setState(next); setError(next.error);
    }, (cause) => setError(describe(cause)));
  }, [rpc, threadId]);
  useEffect(() => { refetch(); const timer = setInterval(refetch, 15_000); return () => clearInterval(timer); }, [refetch]);
  useRealtime("android-changed", refetch);
  useRealtime("android-attached", (payload) => {
    const value = payload as { threadId?: unknown; serial?: unknown } | null;
    if (value?.threadId === threadId && typeof value.serial === "string") { setSelected(value.serial); refetch(); }
  });
  useRealtime("android-agent-activity", (payload) => {
    const value = payload as { serial?: unknown; active?: unknown } | null;
    if (value?.serial === serial) setAgentActive(value.active === true);
  });
  useEffect(() => { setAgentActive(false); }, [serial]);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); } catch (cause) { toast.error(describe(cause)); }
    finally { setBusy(false); refetch(); }
  }, [refetch]);
  const button = (button: AndroidButton) => {
    if (serial && attached) void rpc.call("androidButton", { threadId, serial, button }).catch((cause) => toast.error(describe(cause)));
  };
  const screenshotUrl = serial ? `${base}?threadId=${encodeURIComponent(threadId)}&serial=${encodeURIComponent(serial)}` : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="Smartphone" className="size-4 shrink-0 text-muted-foreground" />
        <select aria-label="Android emulator" value={selectedDevice?.id ?? ""}
          className="h-8 min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2 text-sm"
          onChange={(event) => setSelected(event.target.value)} disabled={devices.length === 0}>
          {devices.length === 0 ? <option value="">No Android emulators found</option> : null}
          {devices.map((device) => <option key={device.id} value={device.id}>
            {device.name} · {device.state.toLowerCase()}
          </option>)}
        </select>
        {attached && serial ? <Button size="sm" variant="outline" disabled={busy}
          onClick={() => void run(() => rpc.call("androidDetach", { threadId, serial, shutdown: false }))}>Detach</Button>
          : <Button size="sm" disabled={busy || !selectedDevice || selectedDevice.state === "Offline"}
            onClick={() => void run(async () => {
              const result = await rpc.call("androidAttach", { threadId, device: selectedDevice?.id ?? null });
              setSelected(result.serial);
            })}>{busy ? "Starting…" : "Attach"}</Button>}
      </div>
      {error ? <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {state?.ready.problems.length ? <div className="space-y-1 border-b border-border px-3 py-2">
        {state.ready.problems.map((problem) => <p key={problem} className="text-xs text-muted-foreground">{problem}</p>)}
      </div> : null}
      {attached && serial && screenshotUrl ? <AndroidScreen key={serial} url={screenshotUrl} agentActive={agentActive}
        onTap={(x, y, holdMs) => rpc.call("androidTap", { threadId, serial, x, y, holdMs })}
        onSwipe={(fromX, fromY, toX, toY, durationMs) => rpc.call("androidSwipe", { threadId, serial, fromX, fromY, toX, toY, durationMs })}
        onButton={button} />
        : <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-xs">
            <Icon name="Smartphone" className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">{state === null ? "Loading…" : devices.length ? "No Android emulator attached" : "No Android virtual devices yet"}</p>
            <p className="mt-1 text-xs text-muted-foreground">{state === null ? "" : devices.length
              ? "Choose an emulator and press Attach. Tap or swipe its screen, or ask the agent to run your APK."
              : "Install the Android SDK and create a virtual device in Android Studio's Device Manager. Existing SDK tools are used; this plugin does not download them."}</p>
          </div>
        </div>}
      {attached && serial ? <>
        <form className="flex gap-2 border-t border-border px-3 py-2" onSubmit={(event) => {
          event.preventDefault();
          if (text) void run(async () => { await rpc.call("androidText", { threadId, serial, text }); setText(""); });
        }}>
          <input aria-label="Text to type in Android" placeholder="Type in the focused Android field…" maxLength={2000}
            value={text} onChange={(event) => setText(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs" />
          <Button size="sm" variant="outline" type="submit" disabled={busy || !text}>Send</Button>
        </form>
        <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
          <Button size="sm" variant="ghost" onClick={() => button("back")}>Back</Button>
          <Button size="sm" variant="ghost" onClick={() => button("home")}>Home</Button>
          <Button size="sm" variant="ghost" onClick={() => button("overview")}>Apps</Button>
          <Button size="icon" variant="ghost" aria-label="Android volume down" onClick={() => button("volume-down")}><Icon name={`${pluginId}/volume-down`} className="size-4" /></Button>
          <Button size="icon" variant="ghost" aria-label="Android volume up" onClick={() => button("volume-up")}><Icon name={`${pluginId}/volume-up`} className="size-4" /></Button>
          <a href={`${screenshotUrl}&download=1`} download className="inline-flex h-8 items-center rounded-md px-2 text-xs hover:bg-accent" aria-label="Save Android screenshot"><Icon name={`${pluginId}/camera`} className="size-4" /></a>
          <span className="min-w-0 flex-1 px-1 text-[11px] text-muted-foreground">PNG preview · ~1 fps</span>
          {state?.agentControl === "ask" ? <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={busy}
            onClick={() => void run(() => rpc.call("androidSetConsent", { threadId, serial, allow: state.consent[serial] !== true }))}>
            {state.consent[serial] === true ? "Agent allowed" : "Let agent use it"}</Button> : null}
          <Button size="icon" variant="ghost" aria-label="Power button" onClick={() => button("power")}><Icon name={`${pluginId}/lock`} className="size-4" /></Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => rpc.call("androidDetach", { threadId, serial, shutdown: true }))}>Shut down</Button>
        </div>
      </> : null}
    </div>
  );
}

export function AndroidScreen({ url, agentActive, onTap, onSwipe, onButton }: {
  url: string; agentActive: boolean;
  onTap: (x: number, y: number, holdMs: number) => Promise<unknown>;
  onSwipe: (fromX: number, fromY: number, toX: number, toY: number, durationMs: number) => Promise<unknown>;
  onButton: (button: AndroidButton) => void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number; time: number } | null>(null);
  useEffect(() => {
    let disposed = false, objectUrl: string | null = null, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const capture = async () => {
      try {
        if (document.visibilityState !== "hidden") {
          const response = await fetch(url, { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Android screenshot failed.");
          const blob = await response.blob();
          if (disposed) return;
          const next = URL.createObjectURL(blob);
          const previous = objectUrl; objectUrl = next; setFrame(next); setError(null);
          if (previous) URL.revokeObjectURL(previous);
        }
      } catch (cause) { if (!disposed) setError(describe(cause)); }
      finally { if (!disposed) timer = setTimeout(capture, 1000); }
    };
    void capture();
    return () => { disposed = true; clearTimeout(timer); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);
  const point = (event: PointerEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  };
  return <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30 p-3">
    {frame ? <img src={frame} alt="Android emulator screen" draggable={false} tabIndex={0}
      className="max-h-full max-w-full select-none rounded-xl border border-border bg-black object-contain shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ touchAction: "none", width: "auto", height: "auto" }}
      onPointerDown={(event) => {
        if (pointer.current || event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current = { id: event.pointerId, ...point(event), time: Date.now() };
      }}
      onPointerCancel={() => { pointer.current = null; }}
      onLostPointerCapture={() => { pointer.current = null; }}
      onPointerUp={(event) => {
        const from = pointer.current;
        if (!from || from.id !== event.pointerId) return;
        pointer.current = null;
        const to = point(event), duration = Math.min(5000, Date.now() - from.time);
        const moved = Math.hypot(to.x - from.x, to.y - from.y) > 0.015;
        void (moved ? onSwipe(from.x, from.y, to.x, to.y, Math.max(50, duration))
          : onTap(to.x, to.y, duration >= 500 ? duration : 0)).catch((cause) => toast.error(describe(cause)));
      }}
      onKeyDown={(event) => {
        const keys: Record<string, AndroidButton> = { Escape: "back", Enter: "enter", Backspace: "backspace", Home: "home" };
        if (keys[event.key]) { event.preventDefault(); onButton(keys[event.key]!); }
      }} /> : <p className="text-xs text-muted-foreground">Waiting for the Android screen…</p>}
    {agentActive ? <p className="pointer-events-none absolute top-4 rounded-full bg-foreground px-2.5 py-1 text-[11px] text-background">Agent is using this device</p> : null}
    {error ? <p role="alert" className="absolute inset-x-3 bottom-3 rounded-lg bg-background/95 p-2 text-center text-xs text-destructive">{error}</p> : null}
  </div>;
}
