// The shared iOS device stage, replay controls, and human/agent handoff.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  experimental_usePluginId as usePluginId,
  useRealtime,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { SimulatorState, rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  HID,
  KEY_USAGE_BY_NAME,
  SHIFT_USAGE,
  clamp01,
  decodeHid,
  encodeHid,
  keyUsageForChar,
  nextOrientation,
  screenConfigFrom,
  type HardwareButton,
  type Orientation,
  type ScreenConfig,
} from "@/lib/sim-protocol";
import { cn } from "@/lib/utils";
import { BEZEL_ASSET_VERSION, fitBezel, isDeviceBezel, type DeviceBezel } from "@/lib/device-bezel";
import { displayPointToRaw, screenGeometry } from "@/lib/screen-geometry";
import { startVideoStream, webCodecsAvailable, type VideoStats } from "@/components/video-stream";
import { ReplayPanel } from "@/components/replay-panel";
import { DevicePicker } from "@/components/device-picker";

type Session = SimulatorState["sessions"][number];

const AGENT_BADGE_MS = 2_500;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function pluginHttpBase(pluginId: string): string {
  return `/api/v1/plugins/${pluginId}/http`;
}

function hidSocketUrl(base: string, udid: string, threadId: string): string {
  const origin = window.location.origin.replace(/^http/, "ws");
  return `${origin}${base}/hid?udid=${encodeURIComponent(udid)}&threadId=${encodeURIComponent(threadId)}`;
}

/** A reconnecting binary WebSocket to the plugin's HID relay for one device. */
function useHidSocket(url: string | null) {
  const socketRef = useRef<WebSocket | null>(null);
  const [config, setConfig] = useState<ScreenConfig | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!url) return;
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const decoded = decodeHid(new Uint8Array(event.data));
        const next = decoded ? screenConfigFrom(decoded.payload) : null;
        if (next) setConfig(next);
      };
      socket.onclose = () => {
        setConnected(false);
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        attempt += 1;
        timer = setTimeout(connect, Math.min(5_000, 400 * attempt));
      };
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
      setConfig(null);
    };
  }, [url]);

  const send = useCallback((opcode: number, payload: unknown) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(encodeHid(opcode, payload));
    }
  }, []);

  return { send, config, connected };
}

interface Shortcut {
  button?: HardwareButton;
  rotate?: boolean;
  screenshot?: boolean;
}

/** Apple Simulator's shortcuts: ⌘⇧H home, ⌘L lock, ⌘↑/↓ volume, ⌘→ rotate, ⌘S screenshot. */
export function shortcutFor(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): Shortcut | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "h" && event.shiftKey) return { button: "home" };
  if (key === "l") return { button: "lock" };
  if (key === "ArrowUp") return { button: "volume-up" };
  if (key === "ArrowDown") return { button: "volume-down" };
  if (key === "ArrowRight") return { rotate: true };
  if (key === "s") return { screenshot: true };
  return null;
}

type DeviceKind = "phone" | "tablet";

export function deviceKindFor(name: string | undefined): DeviceKind {
  return /ipad/i.test(name ?? "") ? "tablet" : "phone";
}

/**
 * Fit a bezelled device into a box. The bezel scales with the screen so the
 * frame keeps its proportions at any panel size; returns screen and frame
 * sizes in CSS pixels.
 */
export function fitDevice(
  box: { width: number; height: number },
  ratio: number,
  kind: DeviceKind,
  padding = 16,
) {
  const bezelFraction = kind === "phone" ? 0.04 : 0.03;
  const availableWidth = Math.max(0, box.width - padding * 2);
  const availableHeight = Math.max(0, box.height - padding * 2);
  const shortSideRatio = Math.min(ratio, 1);
  const byHeight = availableHeight / (1 + 2 * bezelFraction * shortSideRatio);
  const byWidth = availableWidth / (ratio + 2 * bezelFraction * shortSideRatio);
  const screenHeight = Math.max(0, Math.min(byHeight, byWidth));
  const screenWidth = screenHeight * ratio;
  const shortSide = Math.min(screenWidth, screenHeight);
  const bezel = Math.max(4, Math.min(18, shortSide * bezelFraction));
  const screenRadius = shortSide * (kind === "phone" ? 0.13 : 0.045);
  return {
    screenWidth,
    screenHeight,
    bezel,
    screenRadius,
    frameRadius: screenRadius + bezel,
    frameWidth: screenWidth + bezel * 2,
    frameHeight: screenHeight + bezel * 2,
  };
}

function DeviceScreen({
  threadId,
  udid,
  session,
  base,
  kind,
  agentActive,
  inputShadowed,
  inputEnabled,
  onShortcut,
  onConfig,
  onStats,
  onPasteText,
}: {
  threadId: string;
  udid: string;
  session: Session;
  base: string;
  kind: DeviceKind;
  agentActive: boolean;
  inputShadowed: boolean;
  inputEnabled: boolean;
  onShortcut: (shortcut: Shortcut) => void;
  onConfig: (config: ScreenConfig | null) => void;
  onStats: (stats: VideoStats | null) => void;
  onPasteText: (text: string) => void;
}) {
  const { send: sendHid, config, connected } = useHidSocket(hidSocketUrl(base, udid, threadId));
  const send = useCallback((opcode: number, payload: unknown) => {
    if (inputEnabled) sendHid(opcode, payload);
  }, [inputEnabled, sendHid]);
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [bezel, setBezel] = useState<DeviceBezel | null>(null);
  // Prefer hardware H.264 over WebCodecs; MJPEG <img> is the fallback.
  const [mode, setMode] = useState<"video" | "mjpeg">(() => (webCodecsAvailable() ? "video" : "mjpeg"));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointerDown = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pointer moves arrive at the mouse's event rate; the simulator only needs
  // one position per display refresh, so coalesce them.
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveFrame = useRef<number | null>(null);
  useEffect(() => {
    if (inputEnabled) return;
    pointerDown.current = false;
    pendingMove.current = null;
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = null;
  }, [inputEnabled]);
  const flushMove = useCallback(() => {
    moveFrame.current = null;
    const point = pendingMove.current;
    pendingMove.current = null;
    if (point && pointerDown.current) send(HID.TOUCH, { type: "move", ...point });
  }, [send]);
  useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  useEffect(() => onConfig(config), [config, onConfig]);

  // Apple supplies the artwork with Xcode. Load every piece before replacing
  // the CSS frame so a missing installation or failed image never leaves gaps.
  useEffect(() => {
    const controller = new AbortController();
    const images: HTMLImageElement[] = [];
    const load = async () => {
      const response = await fetch(`${base}/bezel?udid=${encodeURIComponent(udid)}`, { signal: controller.signal });
      if (!response.ok) return;
      const frame: unknown = await response.json();
      if (!isDeviceBezel(frame) || controller.signal.aborted) return;
      const urls = frame.layers.map((layer) => `${base}/bezel/image?udid=${encodeURIComponent(udid)}&part=${layer.id}&v=${BEZEL_ASSET_VERSION}`);
      if (frame.screen.mask) {
        for (const rotation of [0, 90, 180, 270]) {
          urls.push(`${base}/bezel/image?udid=${encodeURIComponent(udid)}&part=mask&rotation=${rotation}&v=${BEZEL_ASSET_VERSION}`);
        }
      }
      await Promise.all(urls.map((url) => new Promise<void>((resolve, reject) => {
        const image = new Image();
        images.push(image);
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Local bezel image unavailable"));
        image.src = url;
      })));
      if (!controller.signal.aborted) setBezel(frame);
    };
    void load().catch(() => {});
    return () => {
      controller.abort();
      for (const image of images) { image.onload = null; image.onerror = null; image.src = ""; }
    };
  }, [base, udid]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    setBox({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  const streamSrc = `${base}/stream?udid=${encodeURIComponent(udid)}&s=${session.startedAt}&n=${nonce}`;
  useEffect(() => setLoaded(false), [streamSrc, mode]);

  useEffect(() => {
    if (mode !== "video") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let handle: ReturnType<typeof startVideoStream> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const connect = () => {
      if (disposed) return;
      handle?.stop();
      handle = startVideoStream(
        `${base}/video?udid=${encodeURIComponent(udid)}&s=${session.startedAt}&a=${attempt}`,
        canvas,
        {
          onFirstFrame: () => {
            attempt = 0;
            setLoaded(true);
          },
          onSize: (width, height) => setNaturalSize({ width, height }),
          onStats,
          onFallback: () => {
            if (!disposed) {
              onStats(null);
              setMode("mjpeg");
            }
          },
          onDisconnect: () => {
            if (disposed) return;
            attempt += 1;
            retry = setTimeout(connect, Math.min(5_000, 500 * attempt));
          },
        },
      );
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      handle?.stop();
      onStats(null);
    };
  }, [mode, base, udid, session.startedAt, onStats]);

  const rawSize = naturalSize ?? config ?? (kind === "phone" ? { width: 9, height: 19.5 } : { width: 3, height: 4 });
  const geometry = screenGeometry(rawSize, config?.orientation);
  const ratio = geometry.width / geometry.height;
  const fit = fitDevice(box, ratio, kind);
  const localFit = bezel ? fitBezel(box, bezel, geometry.bodyRotation) : null;
  const width = localFit?.screenWidth ?? fit.screenWidth;
  const height = localFit?.screenHeight ?? fit.screenHeight;
  const quarterTurn = geometry.contentRotation === 90 || geometry.contentRotation === 270;
  const contentWidth = quarterTurn ? height : width;
  const contentHeight = quarterTurn ? width : height;
  const contentStyle: CSSProperties = {
    position: "absolute", width: contentWidth, height: contentHeight,
    left: (width - contentWidth) / 2, top: (height - contentHeight) / 2,
    transform: `rotate(${geometry.contentRotation}deg)`, transformOrigin: "center",
  };

  const normalized = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return displayPointToRaw({
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    }, geometry.contentRotation);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!inputEnabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    const point = normalized(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDown.current = true;
    send(HID.TOUCH, { type: "begin", ...point });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!inputEnabled || !pointerDown.current) return;
    const point = normalized(event);
    if (!point) return;
    pendingMove.current = point;
    if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(flushMove);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!inputEnabled || !pointerDown.current) return;
    // Deliver the last move before the lift so a fast flick keeps its velocity.
    if (moveFrame.current !== null) {
      cancelAnimationFrame(moveFrame.current);
      flushMove();
    }
    pointerDown.current = false;
    const point = normalized(event) ?? { x: 0.5, y: 0.5 };
    send(HID.TOUCH, { type: "end", ...point });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const shortcut = shortcutFor(event);
    if (!inputEnabled && !shortcut?.screenshot) return;
    if (shortcut) {
      event.preventDefault();
      onShortcut(shortcut);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const named = KEY_USAGE_BY_NAME[event.key];
    const key = named !== undefined ? { usage: named, shift: false } : keyUsageForChar(event.key);
    if (!key) return;
    event.preventDefault();
    if (key.shift) send(HID.KEY, { type: "down", usage: SHIFT_USAGE });
    send(HID.KEY, { type: "down", usage: key.usage });
    send(HID.KEY, { type: "up", usage: key.usage });
    if (key.shift) send(HID.KEY, { type: "up", usage: SHIFT_USAGE });
  };

  const sideButton = (side: "left" | "right", top: string, length: string) => (
    <div
      aria-hidden
      className="absolute w-[3px] rounded-sm bg-neutral-700"
      style={{
        top,
        height: length,
        [side]: -3,
      }}
    />
  );

  return (
    <div
      ref={containerRef}
      className="simulator-stage relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/15"
    >
      <div
        className={cn("relative", localFit ? "drop-shadow-xl" : "bg-neutral-900 shadow-xl ring-1 ring-black/40")}
        data-bezel={localFit ? "xcode" : "fallback"}
        style={{
          width: localFit?.frameWidth ?? fit.frameWidth,
          height: localFit?.frameHeight ?? fit.frameHeight,
          borderRadius: localFit ? undefined : fit.frameRadius,
        }}
      >
        {bezel && localFit ? (
          <div aria-hidden="true" className="pointer-events-none absolute" style={{
            width: localFit.bodyWidth, height: localFit.bodyHeight,
            left: (localFit.frameWidth - localFit.bodyWidth) / 2,
            top: (localFit.frameHeight - localFit.bodyHeight) / 2,
            transform: `rotate(${localFit.angle}deg)`,
          }}>
            {bezel.layers.map((layer) => (
              <img key={layer.id} alt="" draggable={false} className="absolute select-none"
                src={`${base}/bezel/image?udid=${encodeURIComponent(udid)}&part=${layer.id}&v=${BEZEL_ASSET_VERSION}`}
                onError={() => setBezel(null)}
                style={{ left: layer.x * localFit.scale, top: layer.y * localFit.scale,
                  width: layer.width * localFit.scale, height: layer.height * localFit.scale }} />
            ))}
          </div>
        ) : kind === "phone" ? (
          <div aria-hidden="true" className="pointer-events-none absolute" style={{
            width: geometry.landscape ? fit.frameHeight : fit.frameWidth,
            height: geometry.landscape ? fit.frameWidth : fit.frameHeight,
            left: geometry.landscape ? (fit.frameWidth - fit.frameHeight) / 2 : 0,
            top: geometry.landscape ? (fit.frameHeight - fit.frameWidth) / 2 : 0,
            transform: `rotate(${geometry.bodyRotation}deg)`,
          }}>
            {sideButton("left", "14%", "4%")}
            {sideButton("left", "21%", "7%")}
            {sideButton("left", "30%", "7%")}
            {sideButton("right", "23%", "11%")}
          </div>
        ) : null}
      <div
        ref={surfaceRef}
        tabIndex={inputEnabled ? 0 : -1}
        aria-disabled={!inputEnabled}
        role="application"
        aria-label="Simulator screen. Click to tap, drag to swipe, type to send keys."
        className="absolute overflow-hidden bg-black outline-none ring-ring focus-visible:ring-2"
        style={{ width, height, left: localFit?.screenX ?? fit.bezel, top: localFit?.screenY ?? fit.bezel,
          borderRadius: bezel?.screen.mask ? 0 : (localFit?.screenRadius ?? fit.screenRadius), touchAction: "none",
          ...(bezel?.screen.mask && localFit ? {
            maskImage: `url("${base}/bezel/image?udid=${encodeURIComponent(udid)}&part=mask&rotation=${localFit.angle}&v=${BEZEL_ASSET_VERSION}")`,
            maskSize: "100% 100%", maskMode: "alpha", maskRepeat: "no-repeat",
          } : {}) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          if (!inputEnabled) return;
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          event.preventDefault();
          onPasteText(text);
        }}
      >
        {mode === "video" ? (
          <canvas
            ref={canvasRef}
            style={contentStyle}
            className={cn("block select-none bg-black transition-opacity", !loaded && "opacity-0")}
          />
        ) : null}
        {mode === "mjpeg" ? (
        <img
          ref={imageRef}
          src={streamSrc}
          alt=""
          draggable={false}
          onLoad={(event) => {
            setLoaded(true);
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
            }
          }}
          onError={() => {
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => setNonce((value) => value + 1), 1_500);
          }}
          style={contentStyle}
          className={cn(
            "block select-none bg-black object-contain transition-opacity",
            !loaded && "opacity-0",
          )}
        />
        ) : null}
        {!loaded ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400">
            Waiting for the first frame…
          </div>
        ) : null}
        {inputShadowed ? (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg bg-background/90 px-2.5 py-1.5 text-center text-[11px] text-foreground shadow">
            Input paused by Xcode. Choose Repair input above.
          </div>
        ) : null}
        {agentActive ? (
          <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-foreground px-2.5 py-1 text-[11px] font-medium text-background shadow">
            Agent is using this device
          </div>
        ) : null}
        {loaded && !connected && !inputShadowed ? (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow">
            Reconnecting input…
          </div>
        ) : null}
      </div>
      </div>
    </div>
  );
}

function ControlButton({
  icon,
  label,
  onClick,
  disabled,
  pending,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
}) {
  return (
    <span title={label} className="inline-flex shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-10 shrink-0 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-[0.96] motion-reduce:transition-none", pending && "bg-accent text-foreground")}
        aria-label={label}
        aria-busy={pending || undefined}
        onClick={onClick}
        disabled={disabled || pending}
      >
        {pending ? <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 animate-spin motion-reduce:animate-none" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" opacity=".2" /><path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round" /></svg> : <Icon name={icon} className="size-4" />}
      </Button>
    </span>
  );
}

function DeviceOptions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={root} className="relative" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <span title="Device options" className="inline-flex">
      <Button ref={trigger} variant="ghost" size="icon" className="size-10 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:transition-none"
        aria-label="Device options" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
      </Button>
    </span>
    {open ? <div id={id} role="group" aria-label="Device options" className="simulator-options absolute bottom-full right-0 z-20 mb-2 w-60 rounded-xl border border-border/60 bg-background p-1.5 text-xs shadow-xl">
      {children}
    </div> : null}
  </div>;
}

export function SimulatorPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = usePluginId();
  const base = pluginHttpBase(pluginId);
  // Icons shipped with the plugin (declared in package.json), so they never
  // fall back to the host's generic glyph.
  const glyph = (name: string) => `${pluginId}/${name}`;
  const [state, setState] = useState<SimulatorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const [screen, setScreen] = useState<ScreenConfig | null>(null);
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null);
  const [pendingControls, setPendingControls] = useState<Record<string, boolean>>({});
  const controlsInFlight = useRef(new Set<string>());
  const requestedOrientation = useRef<{ udid: string; orientation: Orientation } | null>(null);
  const [, tick] = useState(0);

  const refetch = useCallback(() => {
    rpc.call("state", { threadId }).then(
      (next) => {
        setState(next);
        setError(null);
      },
      (cause) => setError(describe(cause)),
    );
  }, [rpc, threadId]);

  useEffect(() => {
    refetch();
    const timer = setInterval(refetch, 15_000);
    return () => clearInterval(timer);
  }, [refetch]);
  useRealtime("sessions-changed", refetch);
  useRealtime("control-changed", refetch);
  useRealtime("attached", (payload) => {
    const signal = payload as { threadId?: unknown; udid?: unknown } | null;
    if (signal?.threadId === threadId && typeof signal.udid === "string") {
      setSelected(signal.udid);
      refetch();
    }
  });
  useRealtime("agent-activity", (payload) => {
    const signal = payload as { udid?: unknown; active?: unknown } | null;
    if (!signal || typeof signal.udid !== "string") return;
    const udid = signal.udid;
    setActivity((previous) => ({ ...previous, [udid]: signal.active ? Date.now() : 0 }));
  });
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const devices = state?.devices ?? [];
  const attached = state?.attached ?? [];
  const sessions = state?.sessions ?? [];
  const activeUdid =
    selected && (attached.includes(selected) || devices.some((d) => d.udid === selected))
      ? selected
      : (attached[0] ?? null);
  const activeSession = sessions.find((session) => session.udid === activeUdid) ?? null;
  const activeDevice = devices.find((device) => device.udid === activeUdid) ?? null;
  const isAttached = activeUdid !== null && attached.includes(activeUdid);
  const controller = activeUdid ? state?.controls[activeUdid] : undefined;
  const ownsHumanControl = isAttached && controller?.threadId === threadId && controller.mode === "human";
  const canDrive = ownsHumanControl && !replaying && busy !== "control";
  const controlLabel = busy === "control" ? "Changing control…" : !controller ? "View only" : controller.threadId !== threadId
    ? "Viewing another thread" : controller.mode === "human" ? "You’re driving" : "Agent driving";
  const agentActive =
    activeUdid !== null && Date.now() - (activity[activeUdid] ?? 0) < AGENT_BADGE_MS;

  useEffect(() => {
    setReplaying(false);
  }, [activeUdid, isAttached]);

  useEffect(() => {
    const requested = requestedOrientation.current;
    if (requested && (requested.udid !== activeUdid || requested.orientation === screen?.orientation)) {
      requestedOrientation.current = null;
    }
  }, [activeUdid, screen?.orientation]);

  const run = useCallback(
    async (label: string, work: () => Promise<unknown>) => {
      setBusy(label);
      try {
        await work();
      } catch (cause) {
        toast.error(describe(cause));
      } finally {
        setBusy(null);
        refetch();
      }
    },
    [refetch],
  );

  const attach = (udid: string | null) =>
    run("attach", async () => {
      const result = await rpc.call("attach", { threadId, device: udid });
      setSelected(result.udid);
    });
  const detach = (shutdown: boolean) => {
    if (!activeUdid || (shutdown && !canDrive)) return;
    void run(shutdown ? "shutdown" : "detach", () =>
      rpc.call("detach", { threadId, udid: activeUdid, shutdown }),
    );
  };
  const pressButton = (button: HardwareButton) => {
    if (!activeUdid || !canDrive) return;
    void runControl(button, () => rpc.call("button", { threadId, udid: activeUdid, button }));
  };
  const rotate = () => {
    if (!activeUdid || !canDrive || controlsInFlight.current.has(`${activeUdid}:rotate`)) return;
    // Config arrives asynchronously; rapid presses should advance from the
    // requested orientation instead of sending the same rotation twice.
    const previous = requestedOrientation.current?.udid === activeUdid
      ? requestedOrientation.current.orientation : screen?.orientation;
    const requested = { udid: activeUdid, orientation: nextOrientation(previous) };
    requestedOrientation.current = requested;
    void runControl("rotate", async () => {
      try { await rpc.call("rotate", { threadId, ...requested }); }
      catch (error) {
        if (requestedOrientation.current === requested) requestedOrientation.current = null;
        throw error;
      }
    });
  };
  const controlPending = (action: string) => pendingControls[`${activeUdid}:${action}`] === true;
  const runControl = async (action: string, work: () => Promise<unknown>) => {
    const key = `${activeUdid}:${action}`;
    if (controlsInFlight.current.has(key)) return;
    controlsInFlight.current.add(key);
    setPendingControls((previous) => ({ ...previous, [key]: true }));
    try { await work(); }
    catch (cause) { toast.error(describe(cause)); }
    finally {
      controlsInFlight.current.delete(key);
      setPendingControls((previous) => { const next = { ...previous }; delete next[key]; return next; });
    }
  };
  const screenshot = () => {
    if (!activeUdid) return;
    const anchor = document.createElement("a");
    anchor.href = `${base}/screenshot?udid=${encodeURIComponent(activeUdid)}&download=1&t=${Date.now()}`;
    anchor.download = "";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };
  const onShortcut = (shortcut: Shortcut) => {
    if (shortcut.button) pressButton(shortcut.button);
    if (shortcut.rotate) rotate();
    if (shortcut.screenshot) screenshot();
  };
  const repairInput = () => {
    if (!activeUdid || !canDrive) return;
    void run("repair", async () => {
      const { repaired } = await rpc.call("repairInput", { threadId, udid: activeUdid });
      toast[repaired ? "success" : "message"](
        repaired
          ? "Input repaired. Running apps were closed; relaunch your app."
          : "Input is not captured by Device Hub.",
      );
    });
  };
  const handoff = (mode: "human" | "agent") => {
    if (!activeUdid || !isAttached || (mode === "agent" && !ownsHumanControl)) return;
    const udid = activeUdid;
    void run("control", async () => {
      const next = await rpc.call("control", { threadId, udid, mode });
      setState((previous) => previous ? { ...previous, controls: { ...previous.controls, [udid]: next } } : previous);
    });
  };

  const problems = state?.ready.problems ?? [];
  const inputShadowed = activeUdid !== null && (state?.inputShadowed ?? []).includes(activeUdid);
  const liveStage = activeSession && activeUdid ? <DeviceScreen
    key={`${activeUdid}:${activeSession.startedAt}`}
    udid={activeUdid} threadId={threadId} session={activeSession} base={base}
    kind={deviceKindFor(activeDevice?.name)} agentActive={agentActive}
    inputShadowed={inputShadowed} inputEnabled={canDrive}
    onShortcut={onShortcut} onConfig={setScreen} onStats={setVideoStats}
    onPasteText={(text) => {
      if (canDrive) rpc.call("pasteText", { threadId, udid: activeUdid, text }).catch((cause) => toast.error(describe(cause)));
    }}
  /> : null;

  return (
    <div className="simulator-panel @container flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground antialiased tabular-nums" style={{ containerType: "size" }}>
      <div className="simulator-header flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <DevicePicker devices={devices} attached={attached} value={activeUdid} onChange={setSelected} disabled={devices.length === 0}>
          <Icon name="Smartphone" className="hidden size-4 shrink-0 text-muted-foreground @[360px]:block" />
          <span className="min-w-0 flex-1 py-0.5">
            <span className="block truncate text-xs font-medium">{activeDevice?.name ?? (state ? "Select a device" : "Loading devices…")}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11px] text-muted-foreground">
              {isAttached ? <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", ownsHumanControl ? "bg-emerald-500" : "bg-muted-foreground/60")} /> : null}
              <span role="status" title={isAttached ? controlLabel : undefined} className="truncate">{isAttached ? controlLabel : activeDevice?.runtime ?? "iOS Simulator"}</span>
            </span>
          </span>
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m5 6 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </DevicePicker>
        {isAttached && activeSession ? <span title={ownsHumanControl && state?.agentControl === "never" ? "Agent control is turned off in plugin settings" : undefined}>
          <Button size="sm" variant={ownsHumanControl ? "ghost" : "secondary"}
            className="h-10 shrink-0 rounded-lg px-3 transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:transition-none"
            aria-label={ownsHumanControl ? "Let agent drive" : "Take control"} aria-busy={busy === "control" || undefined}
            disabled={busy === "control" || (ownsHumanControl && state?.agentControl === "never")}
            onClick={() => handoff(ownsHumanControl ? "agent" : "human")}>
            {busy === "control" ? <Icon name={glyph("spinner")} className="size-3.5 animate-spin motion-reduce:animate-none" /> :
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d={ownsHumanControl ? "M4 12h15m-6-6 6 6-6 6" : "m4 3 7 18 2-8 8-2z"} />
              </svg>}
            {ownsHumanControl ? "Let agent drive" : "Take control"}
          </Button>
        </span> : (
          <Button
            size="sm"
            className="h-10 min-w-20 rounded-lg transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:transition-none"
            onClick={() => void attach(activeUdid)}
            disabled={busy !== null || (devices.length === 0 && problems.length > 0)}
                >
            {busy === "attach" ? (
              <Icon name={glyph("spinner")} className="size-4 animate-spin" />
            ) : (
              <Icon name={glyph("play")} className="size-4" />
            )}
            {busy === "attach" ? "Starting…" : "Attach"}
          </Button>
        )}
      </div>

      {error ? (
        <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {state && problems.length > 0 ? (
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-medium">Finish setting up the simulator</p>
          <ul className="mt-1 space-y-1">
            {problems.map((problem) => (
              <li key={problem} className="flex gap-2 text-xs text-muted-foreground">
                <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" />
                <span>{problem}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {inputShadowed ? (
        <div className="mx-3 my-2 flex shrink-0 items-start gap-2 rounded-xl bg-muted/70 px-3 py-3">
          <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Input paused by Xcode</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Close this device in Device Hub to resume. Repair restarts the simulator and closes apps.
            </p>
          </div>
          <Button size="sm" variant="outline" className="h-10 shrink-0" onClick={repairInput} disabled={busy !== null || !canDrive}>
            <Icon
              name={glyph(busy === "repair" ? "spinner" : "wrench")}
              className={cn("size-4", busy === "repair" && "animate-spin")}
            />
            {busy === "repair" ? "Repairing…" : "Repair input"}
          </Button>
        </div>
      ) : null}

      {liveStage ? (isAttached && activeUdid ? <ReplayPanel key={`${threadId}:${activeUdid}`} base={base} threadId={threadId} udid={activeUdid}
        status={state?.replay[activeUdid]} onModeChange={setReplaying} onSaved={refetch}>{liveStage}</ReplayPanel> : liveStage) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-xs text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted/70"><Icon name="Smartphone" className="size-6 text-muted-foreground" /></div>
            <p className="mt-4 text-sm font-medium text-balance">
              {state === null
                ? "Loading…"
                : devices.length === 0
                  ? "No iOS simulators yet"
                  : "Your app, right here"}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-pretty text-muted-foreground">
              {state === null
                ? ""
                : devices.length === 0
                  ? "Install the iOS platform in Xcode → Settings → Components, then come back."
                  : "Choose a device and attach it, or ask your agent to run the app. You’ll share the same screen."}
            </p>
          </div>
        </div>
      )}

      {activeSession && activeUdid && !replaying ? (
        <div className="simulator-footer flex shrink-0 justify-center bg-muted/15 px-3 pb-3 pt-1">
          <div className="simulator-control-dock flex items-center gap-0.5 rounded-2xl bg-background p-1 shadow-sm ring-1 ring-border/60" role="group" aria-label="Simulator controls">
          <ControlButton icon={glyph("home")} label="Home (⌘⇧H)" onClick={() => pressButton("home")} disabled={!canDrive} pending={controlPending("home")} />
          <ControlButton icon={glyph("lock")} label="Lock (⌘L)" onClick={() => pressButton("lock")} disabled={!canDrive} pending={controlPending("lock")} />
          <ControlButton icon={glyph("rotate")} label="Rotate (⌘→)" onClick={rotate} disabled={!canDrive} pending={controlPending("rotate")} />
          <ControlButton icon={glyph("camera")} label="Save screenshot (⌘S)" onClick={screenshot} />
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
          <DeviceOptions key={activeUdid}>
            <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1">
              <span className="text-muted-foreground">Volume</span>
              <div className="flex gap-1">
                <ControlButton icon={glyph("volume-down")} label="Volume down (⌘↓)" onClick={() => pressButton("volume-down")} disabled={!canDrive} pending={controlPending("volume-down")} />
                <ControlButton icon={glyph("volume-up")} label="Volume up (⌘↑)" onClick={() => pressButton("volume-up")} disabled={!canDrive} pending={controlPending("volume-up")} />
              </div>
            </div>
            <details className="border-t border-border/60 px-2 text-muted-foreground">
              <summary className="flex min-h-10 cursor-pointer items-center">Stream details</summary>
              <dl className="space-y-1 pb-3 text-[11px] tabular-nums">
                <div className="flex justify-between"><dt>Format</dt><dd>{videoStats ? "H.264" : "Image stream"}</dd></div>
                {screen ? <div className="flex justify-between"><dt>Resolution</dt><dd>{screen.width} × {screen.height}</dd></div> : null}
                {videoStats ? <>
                  <div className="flex justify-between"><dt>Frame rate</dt><dd>{videoStats.paintedFps} fps</dd></div>
                  <div className="flex justify-between"><dt>Decode queue</dt><dd>{videoStats.queue}</dd></div>
                  <div className="flex justify-between"><dt>Bandwidth</dt><dd>{Math.round(videoStats.bytesPerSecond / 1024)} KB/s</dd></div>
                </> : null}
              </dl>
            </details>
            <div className="space-y-0.5 border-t border-border/60 pt-1">
              <Button size="sm" variant="ghost" className="h-10 w-full justify-start rounded-lg px-2" onClick={() => detach(false)} disabled={busy !== null || !isAttached}><Icon name={glyph("unplug")} />Detach</Button>
              <Button size="sm" variant="ghost" className="h-10 w-full justify-start rounded-lg px-2 text-destructive hover:text-destructive" onClick={() => detach(true)} disabled={busy !== null || !canDrive}><Icon name={glyph("power")} />Shut down</Button>
            </div>
          </DeviceOptions>
          </div>
        </div>
      ) : null}
    </div>
  );
}
