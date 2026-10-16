import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { ReplayClip, ReplayClipInfo, ReplayStatus, TimelineEvent } from "@/lib/session-types";
import { Button } from "@/components/ui/button";
import { createReplayPlayer } from "./replay-player";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const timecode = (milliseconds: number) => {
  const total = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const actorLabel = { human: "You", agent: "Agent", system: "System" };
const eventLabel = { input: "Input", log: "App log", crash: "Crash", control: "Control", lifecycle: "App activity", error: "Error" };
type GlyphName = TimelineEvent["kind"] | "capture" | "activity" | "play" | "pause" | "download";

const glyphs: Record<GlyphName, ReactNode> = {
    capture: <path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2" />,
    activity: <><path d="M8 6h12M8 12h12M8 18h12" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    play: <path d="M9 5l10 7-10 7z" fill="currentColor" stroke="none" />,
    pause: <><path d="M8 5v14M16 5v14" strokeWidth="3" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" /></>,
    input: <><path d="m5 3 14 10-7 1-3 7z" /></>,
    log: <><path d="m4 6 5 5-5 5m8 1h8" /></>,
    crash: <><path d="m12 3 10 18H2zM12 9v5m0 3h.01" /></>,
    error: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></>,
    control: <><circle cx="12" cy="8" r="3" /><path d="M5 21v-3a7 7 0 0 1 14 0v3" /></>,
    lifecycle: <><path d="M4 12h4l3-8 3 16 3-8h3" /></>,
};

function Glyph({ name }: { name: GlyphName }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0">{glyphs[name]}</svg>;
}

const controlMotion = "transition-[background-color,color,opacity] duration-150 motion-reduce:transition-none";

export function ReplayPanel({ base, threadId, udid, status: initialStatus, onModeChange, onSaved, children }: {
  base: string; threadId: string; udid: string; status: ReplayStatus | undefined;
  onModeChange(replaying: boolean): void; onSaved(): void; children?: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState(initialStatus);
  const [viewing, setViewing] = useState(false);
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState<ReplayClipInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [clip, setClip] = useState<ReplayClip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const activityId = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const player = useRef<ReturnType<typeof createReplayPlayer> | null>(null);
  const mounted = useRef(true);
  const refreshRef = useRef(() => {});
  const clips = (status?.clips ?? []).filter((item) => item.threadId === threadId);
  if (saved && !clips.some((item) => item.id === saved.id)) clips.unshift(saved);
  const selectedId = selected || clips[0]?.id || "";
  const clipUrl = `${base}/replay?udid=${encodeURIComponent(udid)}&threadId=${encodeURIComponent(threadId)}&id=${encodeURIComponent(selectedId)}`;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void rpc.call("timeline", { threadId, udid }).then((next) => {
        if (!disposed) { setEvents(next.slice(-100)); setTimelineError(null); }
      }, (cause) => { if (!disposed) setTimelineError(describe(cause)); });
      void rpc.call("replayState", { threadId, udid }).then((next) => { if (!disposed) setStatus(next); }, () => {});
    };
    refreshRef.current = refresh;
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => { disposed = true; clearInterval(timer); refreshRef.current = () => {}; };
  }, [rpc, threadId, udid]);
  useRealtime("replay-changed", (payload) => {
    if ((payload as { udid?: unknown } | null)?.udid === udid) refreshRef.current();
  });

  useEffect(() => {
    setClip(null); setError(null); setPlaying(false);
    if (!viewing || !selectedId) return;
    const controller = new AbortController();
    void fetch(clipUrl, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load replay (${response.status}).`);
      const next: ReplayClip = await response.json();
      if (!Array.isArray(next.frames) || !Array.isArray(next.events) || typeof next.description !== "string")
        throw new Error("The saved replay is incomplete.");
      if (!controller.signal.aborted) { setClip(next); setPosition(next.startAt); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(describe(cause)); });
    return () => controller.abort();
  }, [viewing, selectedId, clipUrl]);

  useEffect(() => {
    if (!clip || !canvas.current) return;
    try {
      const instance = createReplayPlayer(canvas.current, clip, {
        onTime: setPosition, onEnded: () => setPlaying(false),
        onError: (message) => { setError(message); setPlaying(false); },
      });
      player.current = instance;
      void instance.seek(clip.startAt);
      return () => { instance.dispose(); if (player.current === instance) player.current = null; };
    } catch (cause) { setError(describe(cause)); }
  }, [clip]);

  const changeMode = (next: boolean) => { setViewing(next); setPlaying(false); player.current?.pause(); onModeChange(next); };
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const info = await rpc.call("saveReplay", { threadId, udid });
      if (!mounted.current) return;
      setSaved(info); setSelected(info.id); changeMode(true); onSaved();
    } catch (cause) { if (mounted.current) setError(describe(cause)); }
    finally { if (mounted.current) setSaving(false); }
  };
  const seek = (at: number) => { setPlaying(false); void player.current?.seek(at); };
  const togglePlayback = async () => {
    const instance = player.current;
    if (!instance || !clip) return;
    if (playing) { instance.pause(); setPlaying(false); return; }
    if (position >= clip.endAt) await instance.seek(clip.startAt);
    if (player.current !== instance) return;
    setPlaying(true); await instance.play();
  };
  const timeline = viewing ? clip?.events ?? [] : events;
  const visibleEvents = timeline.slice(-100);
  const current = viewing ? timeline.filter((event) => event.at <= position).at(-1)?.id : undefined;

  return (
    <div className="replay-panel flex min-h-0 flex-1 flex-col">
      <div className="replay-toolbar flex shrink-0 items-center gap-1.5 px-2 py-2">
        <div role="group" aria-label="Simulator view" className="replay-view-switch flex shrink-0 rounded-lg bg-muted/60 p-0.5">
          <Button size="sm" variant="ghost" className={`h-10 min-w-14 rounded-md px-3 ${controlMotion}`} aria-pressed={!viewing} onClick={() => changeMode(false)}>Live</Button>
          <Button size="sm" variant="ghost" className={`h-10 min-w-14 rounded-md px-3 ${controlMotion}`} aria-pressed={viewing} disabled={!selectedId} onClick={() => changeMode(true)}>Replay</Button>
        </div>
        <Button size="sm" variant="ghost" className={`replay-capture h-10 px-2 ${controlMotion}`} onClick={() => void save()} disabled={saving || !status?.recording || status.bufferedMs <= 0}>
          <Glyph name="capture" />{saving ? "Capturing…" : "Capture 30s"}
        </Button>
        <Button size="sm" variant="ghost" aria-label="Activity" aria-expanded={activityOpen} aria-controls={activityId}
          className={`replay-activity-toggle ml-auto h-10 w-10 shrink-0 px-2 text-muted-foreground ${controlMotion}`}
          onClick={() => setActivityOpen((open) => !open)}>
          <Glyph name="activity" />
        </Button>
      </div>
      {error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {viewing ? <>
        <div className="replay-stage relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20 p-4">
          <canvas ref={canvas} aria-label="Saved simulator replay" className="replay-canvas max-h-full max-w-full rounded-lg bg-black object-contain shadow-sm" />
          {!clip && !error ? <span className="absolute text-xs text-muted-foreground">Loading replay…</span> : null}
        </div>
        <div className="replay-transport shrink-0 px-3 pb-2 pt-1">
          <div className="flex items-center gap-2">
            <Button size="icon" variant="ghost" className={`h-10 w-10 shrink-0 ${controlMotion}`} aria-label={playing ? "Pause" : "Play"} onClick={() => void togglePlayback()} disabled={!clip || !!error}>
              <Glyph name={playing ? "pause" : "play"} />
            </Button>
            <input aria-label="Replay position" type="range" className="h-10 min-w-0 flex-1 cursor-pointer accent-foreground disabled:cursor-default" min={clip?.startAt ?? 0} max={clip?.endAt ?? 1}
            step={1} value={clip ? Math.max(clip.startAt, Math.min(clip.endAt, position)) : 0} disabled={!clip || !!error} onChange={(event) => seek(Number(event.target.value))} />
            <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{clip ? `${timecode(position - clip.startAt)} / ${timecode(clip.endAt - clip.startAt)}` : "—"}</span>
          </div>
          {clips.length > 1 ? <select aria-label="Saved replay" value={selectedId} onChange={(event) => { setSelected(event.target.value); changeMode(true); }}
            className={`replay-clip-picker h-10 w-full min-w-0 rounded-md bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${controlMotion}`}>
            {clips.map((item) => <option key={item.id} value={item.id}>Capture at {clock(item.createdAt)} · {timecode(item.endAt - item.startAt)}</option>)}
          </select> : null}
        </div>
      </> : <div className="replay-live relative flex min-h-0 flex-1 flex-col">{children}</div>}
      {activityOpen ? <section id={activityId} aria-label={viewing ? "Replay activity" : "Recent activity"} className="replay-activity flex max-h-[35%] min-h-0 shrink-0 flex-col border-t border-border/60">
        <div className="min-h-0 overflow-y-auto px-3 pb-2">
          <div className="flex items-center justify-between px-2 pb-1 pt-3 text-[11px] font-medium"><span>Activity</span><span className="tabular-nums text-muted-foreground">{visibleEvents.length}</span></div>
          {timelineError && !viewing ? <p className="py-3 text-xs text-muted-foreground">Activity unavailable: {timelineError}</p> : null}
          {visibleEvents.length ? <ol className="py-1">
          {visibleEvents.map((event) => <li key={event.id} className="replay-event-row">
            <button type="button" disabled={!viewing || !clip} aria-current={event.id === current ? "true" : undefined}
              onClick={() => seek(event.at)} className={`flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-xs enabled:hover:bg-muted aria-current:bg-muted disabled:cursor-default ${controlMotion}`}>
              <span className="shrink-0 text-muted-foreground" title={eventLabel[event.kind]}><Glyph name={event.kind} /></span>
              <span className="min-w-0 flex-1 break-words py-2">{event.label}</span>
              {event.actor !== "system" ? <span className="shrink-0 text-[10px] text-muted-foreground">{actorLabel[event.actor]}</span> : null}
              <time className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{viewing && clip ? timecode(event.at - clip.startAt) : clock(event.at)}</time>
            </button>
            {event.detail ? <details className="replay-event-detail ml-8 text-[11px] text-muted-foreground">
              <summary className="flex min-h-10 cursor-pointer items-center">View details</summary>
              <p className="whitespace-pre-wrap break-words pb-3">{event.detail}</p>
            </details> : null}
          </li>)}
          </ol> : <div className="replay-activity-empty flex items-center gap-3 px-2 py-5 text-muted-foreground">
            <Glyph name="activity" /><div><p className="text-xs font-medium text-foreground">{viewing ? "No activity in this capture" : "No activity yet"}</p>
              <p className="mt-1 text-[11px]">Inputs and app events appear here as you work.</p></div>
          </div>}
          <div className="replay-metadata space-y-2 border-t border-border/50 px-2 py-3 text-[11px] text-muted-foreground">
            <p>{status?.recording ? `${timecode(status.bufferedMs)} ready to capture` : "Capture becomes available when the simulator stream is ready."}</p>
            {status?.error ? <p>{status.error}</p> : null}
            {status?.app ? <p className="break-all"><span className="mr-2">App</span>{status.app}</p> : null}
            {status?.diagnostics ? <p className="text-pretty">{status.diagnostics}</p> : null}
            {clips.length ? <div className="flex flex-wrap items-center justify-between gap-x-3">
              <span>Temporary replays. Download to keep.</span>
              {selectedId ? <a aria-label="Download replay JSON" className={`inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${controlMotion}`} href={`${clipUrl}&download=1`} download={`simulator-replay-${selectedId}.json`}><Glyph name="download" />Download .json</a> : null}
            </div> : null}
          </div>
        </div>
      </section> : null}
    </div>
  );
}
