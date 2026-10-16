// The iOS Simulator tab: a device picker, the live MJPEG stream with touch
// and keyboard relayed over the plugin's HID WebSocket, hardware buttons,
// and the agent-consent switch. Mirrors Apple's Simulator shortcuts.
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
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
import { startVideoStream, webCodecsAvailable, type VideoStats } from "@/components/video-stream";

type Device = SimulatorState["devices"][number];
type Session = SimulatorState["sessions"][number];

const AGENT_BADGE_MS = 2_500;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function pluginHttpBase(pluginId: string): string {
  return `/api/v1/plugins/${pluginId}/http`;
}

function hidSocketUrl(base: string, udid: string): string {
  const origin = window.location.origin.replace(/^http/, "ws");
  return `${origin}${base}/hid?udid=${encodeURIComponent(udid)}`;
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
  const byHeight = availableHeight / (1 + 2 * bezelFraction * ratio);
  const byWidth = availableWidth / (1 + 2 * bezelFraction) / ratio;
  const screenHeight = Math.max(0, Math.min(byHeight, byWidth));
  const screenWidth = screenHeight * ratio;
  const bezel = Math.max(4, Math.min(18, screenWidth * bezelFraction));
  const screenRadius = screenWidth * (kind === "phone" ? 0.13 : 0.045);
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
  udid,
  session,
  base,
  kind,
  agentActive,
  inputShadowed,
  onShortcut,
  onConfig,
  onStats,
  onPasteText,
}: {
  udid: string;
  session: Session;
  base: string;
  kind: DeviceKind;
  agentActive: boolean;
  inputShadowed: boolean;
  onShortcut: (shortcut: Shortcut) => void;
  onConfig: (config: ScreenConfig | null) => void;
  onStats: (stats: VideoStats | null) => void;
  onPasteText: (text: string) => void;
}) {
  const { send, config, connected } = useHidSocket(hidSocketUrl(base, udid));
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null);
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
          onSize: (width, height) => setNaturalRatio(width / height),
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

  const ratio = config ? config.width / config.height : (naturalRatio ?? (kind === "phone" ? 9 / 19.5 : 3 / 4));
  const fit = fitDevice(box, ratio, kind);
  const localFit = bezel ? fitBezel(box, bezel, config?.orientation, ratio > 1) : null;
  const width = localFit?.screenWidth ?? fit.screenWidth;
  const height = localFit?.screenHeight ?? fit.screenHeight;

  const normalized = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    const point = normalized(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDown.current = true;
    send(HID.TOUCH, { type: "begin", ...point });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerDown.current) return;
    const point = normalized(event);
    if (!point) return;
    pendingMove.current = point;
    if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(flushMove);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerDown.current) return;
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
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30"
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
          <>
            {sideButton("left", "14%", "4%")}
            {sideButton("left", "21%", "7%")}
            {sideButton("left", "30%", "7%")}
            {sideButton("right", "23%", "11%")}
          </>
        ) : null}
      <div
        ref={surfaceRef}
        tabIndex={0}
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
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          event.preventDefault();
          onPasteText(text);
        }}
      >
        {mode === "video" ? (
          <canvas
            ref={canvasRef}
            className={cn("block h-full w-full select-none bg-black transition-opacity", !loaded && "opacity-0")}
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
              setNaturalRatio(image.naturalWidth / image.naturalHeight);
            }
          }}
          onError={() => {
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => setNonce((value) => value + 1), 1_500);
          }}
          className={cn(
            "block h-full w-full select-none bg-black object-contain transition-opacity",
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
            Input is captured by Xcode's Device Hub. Use Repair input below.
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
  destructive,
  pending,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  pending?: boolean;
}) {
  return (
    <span title={label} className="inline-flex shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-10 shrink-0 text-muted-foreground transition-transform hover:text-foreground active:scale-[0.96]", pending && "bg-accent text-foreground", destructive && "hover:text-destructive")}
        aria-label={label}
        aria-busy={pending || undefined}
        onClick={onClick}
        disabled={disabled || pending}
      >
        <Icon name={icon} className="size-4" />
      </Button>
    </span>
  );
}

function deviceLabel(device: Device): string {
  return `${device.name} · ${device.runtime}${device.state === "Booted" ? " · booted" : ""}`;
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
  useRealtime("attached", (payload) => {
    const signal = payload as { threadId?: unknown } | null;
    if (signal?.threadId === threadId) refetch();
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
  const agentActive =
    activeUdid !== null && Date.now() - (activity[activeUdid] ?? 0) < AGENT_BADGE_MS;

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
    if (!activeUdid) return;
    void run(shutdown ? "shutdown" : "detach", () =>
      rpc.call("detach", { threadId, udid: activeUdid, shutdown }),
    );
  };
  const pressButton = (button: HardwareButton) => {
    if (!activeUdid) return;
    void runControl(button, () => rpc.call("button", { udid: activeUdid, button }));
  };
  const rotate = () => {
    if (!activeUdid || controlsInFlight.current.has(`${activeUdid}:rotate`)) return;
    // Config arrives asynchronously; rapid presses should advance from the
    // requested orientation instead of sending the same rotation twice.
    const previous = requestedOrientation.current?.udid === activeUdid
      ? requestedOrientation.current.orientation : screen?.orientation;
    const requested = { udid: activeUdid, orientation: nextOrientation(previous) };
    requestedOrientation.current = requested;
    void runControl("rotate", async () => {
      try { await rpc.call("rotate", requested); }
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
  const setConsent = (allow: boolean) => {
    if (!activeUdid) return;
    void run("consent", () => rpc.call("setConsent", { udid: activeUdid, allow }));
  };

  const repairInput = () => {
    if (!activeUdid) return;
    void run("repair", async () => {
      const { repaired } = await rpc.call("repairInput", { udid: activeUdid });
      toast[repaired ? "success" : "message"](
        repaired
          ? "Input repaired. Running apps were closed; relaunch your app."
          : "Input is not captured by Device Hub.",
      );
    });
  };

  const problems = state?.ready.problems ?? [];
  const consentState = activeUdid ? state?.consent[activeUdid] : undefined;
  const inputShadowed = activeUdid !== null && (state?.inputShadowed ?? []).includes(activeUdid);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground antialiased tabular-nums">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="Smartphone" className="size-4 shrink-0 text-muted-foreground" />
        <select
          aria-label="Simulator device"
          className="h-8 min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={activeUdid ?? ""}
          onChange={(event) => setSelected(event.target.value || null)}
          disabled={devices.length === 0}
        >
          {devices.length === 0 ? <option value="">No simulators found</option> : null}
          {attached.length > 0 ? (
            <optgroup label="Attached to this thread">
              {devices
                .filter((device) => attached.includes(device.udid))
                .map((device) => (
                  <option key={device.udid} value={device.udid}>
                    {deviceLabel(device)}
                  </option>
                ))}
            </optgroup>
          ) : null}
          <optgroup label="Available">
            {devices
              .filter((device) => device.isAvailable && !attached.includes(device.udid))
              .map((device) => (
                <option key={device.udid} value={device.udid}>
                  {deviceLabel(device)}
                </option>
              ))}
          </optgroup>
        </select>
        {isAttached ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => detach(false)}
            disabled={busy !== null}
                >
            <Icon name={glyph("unplug")} className="size-4" />
            Detach
          </Button>
        ) : (
          <Button
            size="sm"
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
        <div className="flex items-start gap-2 border-b border-border px-3 py-2">
          <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Xcode's Device Hub has taken over input</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Taps and keys from this panel and from agents are ignored while Device Hub
              shows this device. Repair hands input back; it restarts SpringBoard and
              closes running apps. Closing the device window in Device Hub avoids it.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={repairInput} disabled={busy !== null}>
            <Icon
              name={glyph(busy === "repair" ? "spinner" : "wrench")}
              className={cn("size-4", busy === "repair" && "animate-spin")}
            />
            {busy === "repair" ? "Repairing…" : "Repair input"}
          </Button>
        </div>
      ) : null}

      {activeSession && activeUdid ? (
        <DeviceScreen
          key={`${activeUdid}:${activeSession.startedAt}`}
          udid={activeUdid}
          session={activeSession}
          base={base}
          kind={deviceKindFor(activeDevice?.name)}
          agentActive={agentActive}
          inputShadowed={inputShadowed}
          onShortcut={onShortcut}
          onConfig={setScreen}
          onStats={setVideoStats}
          onPasteText={(text) => {
            rpc.call("pasteText", { udid: activeUdid, text }).catch((cause) => toast.error(describe(cause)));
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-xs text-center">
            <Icon name="Smartphone" className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">
              {state === null
                ? "Loading…"
                : devices.length === 0
                  ? "No iOS simulators yet"
                  : "No simulator attached"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {state === null
                ? ""
                : devices.length === 0
                  ? "Install the iOS platform in Xcode → Settings → Components, then come back."
                  : "Pick a device and press Attach, or ask the agent to run the app. It boots the simulator, streams it here, and you can tap along."}
            </p>
          </div>
        </div>
      )}

      {activeSession && activeUdid ? (
        <div className="shrink-0 border-t border-border px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Simulator controls">
          <ControlButton icon={glyph("home")} label="Home (⌘⇧H)" onClick={() => pressButton("home")} pending={controlPending("home")} />
          <ControlButton icon={glyph("lock")} label="Lock (⌘L)" onClick={() => pressButton("lock")} pending={controlPending("lock")} />
          <ControlButton icon={glyph("volume-up")} label="Volume up (⌘↑)" onClick={() => pressButton("volume-up")} pending={controlPending("volume-up")} />
          <ControlButton icon={glyph("volume-down")} label="Volume down (⌘↓)" onClick={() => pressButton("volume-down")} pending={controlPending("volume-down")} />
          <ControlButton icon={glyph("rotate")} label="Rotate (⌘→)" onClick={rotate} pending={controlPending("rotate")} />
          <ControlButton icon={glyph("camera")} label="Save screenshot (⌘S)" onClick={screenshot} />
          <span className="flex-1" />
          {state?.agentControl === "ask" ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => setConsent(consentState !== true)}
                    >
              <Icon
                name={glyph(consentState === true ? "shield-check" : "shield-off")}
                className="size-3.5"
              />
              {consentState === true ? "Agent allowed" : "Let agent use it"}
            </Button>
          ) : null}
          <ControlButton
            icon={glyph("power")}
            label="Shut down the simulator"
            onClick={() => detach(true)}
            disabled={busy !== null}
            destructive
          />
          </div>
          <div
            className="h-4 truncate px-1 font-mono text-[11px] leading-4 text-muted-foreground"
            title="Codec · painted frames per second (decoded) · decoder queue · stream bandwidth"
          >
            {videoStats
              ? `H.264 · ${videoStats.paintedFps} fps (${videoStats.decodedFps}) · q${videoStats.queue} · ${Math.round(videoStats.bytesPerSecond / 1024)} KB/s`
              : "MJPEG fallback"}
            {screen ? ` · ${screen.width}×${screen.height}` : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}
