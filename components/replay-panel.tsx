import { useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { ReplayClip, ReplayClipInfo, ReplayStatus, TimelineEvent } from "@/lib/session-types";
import { Button } from "@/components/ui/button";
import { createReplayPlayer } from "./replay-player";

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const seconds = (milliseconds: number) => `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;

export function ReplayPanel({ base, threadId, udid, status: initialStatus, onModeChange, onSaved }: {
  base: string; threadId: string; udid: string; status: ReplayStatus | undefined;
  onModeChange(replaying: boolean): void; onSaved(): void;
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
  const current = viewing ? timeline.filter((event) => event.at <= position).at(-1)?.id : undefined;

  return (
    <div className={viewing ? "flex min-h-0 flex-1 flex-col" : "shrink-0"}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div role="group" aria-label="Simulator view" className="flex gap-1">
          <Button size="sm" variant={!viewing ? "secondary" : "ghost"} aria-pressed={!viewing} onClick={() => changeMode(false)}>Live</Button>
          <Button size="sm" variant={viewing ? "secondary" : "ghost"} aria-pressed={viewing} disabled={!selectedId} onClick={() => changeMode(true)}>Replay</Button>
        </div>
        <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving || !status?.recording || status.bufferedMs <= 0}>
          {saving ? "Saving…" : "Save last 30s"}
        </Button>
        <span className="text-[11px] text-muted-foreground">{status?.recording ? `${seconds(status.bufferedMs)} buffered` : "Replay unavailable"}</span>
        {clips.length ? <select aria-label="Saved replay" value={selectedId} onChange={(event) => { setSelected(event.target.value); changeMode(true); }}
          className="h-8 min-w-0 max-w-52 rounded-md border border-input bg-background px-2 text-xs">
          {clips.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleTimeString()} · {seconds(item.endAt - item.startAt)}</option>)}
        </select> : null}
        {selectedId ? <a className="text-xs underline underline-offset-2" href={`${clipUrl}&download=1`} download={`simulator-replay-${selectedId}.json`}>Download replay JSON</a> : null}
        {clips.length ? <span className="text-[11px] text-muted-foreground">Temporary replays. Download to keep.</span> : null}
      </div>
      <div className="border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
        {status?.app ? `App: ${status.app}. ` : "No app selected for diagnostics. "}
        {status?.diagnostics ?? "App diagnostics unavailable."}
      </div>
      {error || status?.error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{error ?? status?.error}</p> : null}
      {viewing ? <>
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30 p-3">
          <canvas ref={canvas} aria-label="Saved simulator replay" className="max-h-full max-w-full bg-black object-contain" />
          {!clip && !error ? <span className="absolute text-xs text-muted-foreground">Loading replay…</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
          <Button size="sm" onClick={() => void togglePlayback()} disabled={!clip || !!error}>{playing ? "Pause" : "Play"}</Button>
          <input aria-label="Replay position" type="range" className="min-w-0 flex-1" min={clip?.startAt ?? 0} max={clip?.endAt ?? 1}
            step={1} value={clip ? Math.max(clip.startAt, Math.min(clip.endAt, position)) : 0} disabled={!clip || !!error} onChange={(event) => seek(Number(event.target.value))} />
          <span className="w-24 text-right font-mono text-[11px]">{clip ? `${seconds(position - clip.startAt)} / ${seconds(clip.endAt - clip.startAt)}` : "—"}</span>
        </div>
      </> : null}
      <details open={viewing} className="shrink-0 border-b border-border px-3 py-1.5">
        <summary className="cursor-pointer text-xs text-muted-foreground">{viewing ? "Replay events" : "Recent activity"} · {timeline.length}</summary>
        {timelineError && !viewing ? <p className="py-1 text-xs text-muted-foreground">Activity unavailable: {timelineError}</p> : null}
        <ol className="max-h-36 overflow-auto py-1">
          {timeline.slice(-100).map((event) => <li key={event.id}>
            <button type="button" disabled={!viewing || !clip} aria-current={event.id === current ? "true" : undefined}
              onClick={() => seek(event.at)} className="flex w-full gap-2 rounded px-1 py-1 text-left text-[11px] enabled:hover:bg-accent aria-current:bg-accent disabled:cursor-default">
              <time className="shrink-0 font-mono text-muted-foreground">{viewing && clip ? seconds(event.at - clip.startAt) : new Date(event.at).toLocaleTimeString()}</time>
              <span className="shrink-0 text-muted-foreground">{event.kind} · {event.actor}</span>
              <span className="min-w-0 break-words">{event.label}{event.detail ? <span className="block whitespace-pre-wrap text-muted-foreground">{event.detail}</span> : null}</span>
            </button>
          </li>)}
        </ol>
      </details>
    </div>
  );
}
