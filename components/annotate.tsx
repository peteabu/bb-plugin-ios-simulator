// Annotate: freeze the iOS screen, pick an accessibility element, and send
// a note about it to the agent as a composer pill with a marked screenshot.
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import {
  NOTE_PROVIDER,
  climb,
  describeNode,
  hitTest,
  noteIds,
  pillLabel,
  withoutNote,
  type AnnotateBox,
  type AnnotateNode,
  type AnnotateNote,
  type AnnotateSnapshot,
} from "@/lib/annotate";

const ACCENT = "#007aff";

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const newNoteId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The mounted panels' toggles, so the command finds the one of its thread. */
const toggles = new Map<string, () => void>();

export function canToggleAnnotate(threadId: string): boolean {
  return toggles.has(threadId);
}

export function toggleAnnotate(threadId: string): void {
  toggles.get(threadId)?.();
}

/** The screenshot with the element outlined and pinned, as a base64 JPEG. */
async function markedShot(snapshot: AnnotateSnapshot, note: AnnotateNote): Promise<string | null> {
  const image = new Image();
  image.src = `data:${snapshot.image.mimeType};base64,${snapshot.image.data}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const scale = image.naturalWidth / note.element.screen.width;
  const { x, y, width, height } = note.element.frame;
  context.lineWidth = Math.max(2, 2 * scale);
  context.strokeStyle = ACCENT;
  context.fillStyle = "rgba(0, 122, 255, 0.12)";
  context.beginPath();
  context.roundRect(x * scale, y * scale, width * scale, height * scale, 3 * scale);
  context.fill();
  context.stroke();
  const radius = 10 * scale;
  const cx = Math.max(radius, x * scale);
  const cy = Math.max(radius, y * scale);
  context.fillStyle = ACCENT;
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#fff";
  context.font = `600 ${11 * scale}px -apple-system, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(note.number), cx, cy + 0.5 * scale);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? null;
}

function NoteEditor({
  title,
  initial,
  anchor,
  stage,
  onSave,
  onCancel,
  onDelete,
}: {
  title: string;
  initial: string;
  anchor: AnnotateBox;
  stage: { width: number; height: number };
  onSave: (comment: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const width = Math.min(260, Math.max(160, stage.width - 16));
  const height = 136;
  const below = anchor.y + anchor.height + 8;
  const top = below + height <= stage.height ? below : Math.max(8, anchor.y - height - 8);
  const left = Math.min(Math.max(8, anchor.x), Math.max(8, stage.width - width - 8));
  const save = () => {
    const comment = value.trim();
    if (comment) onSave(comment);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  };
  return (
    <form
      aria-label="Note for the agent"
      className="absolute z-10 flex flex-col gap-1.5 rounded-xl bg-neutral-800 p-2 text-white shadow-xl"
      style={{ left, top, width }}
      onSubmit={(event) => { event.preventDefault(); save(); }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <p className="truncate text-[11px] text-white/70">{title}</p>
      <textarea
        ref={input}
        value={value}
        maxLength={4000}
        placeholder="A note for the agent"
        className="h-14 resize-none rounded-md border border-[#007aff] bg-neutral-900 px-2 py-1.5 text-xs text-white outline-none"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center gap-1.5">
        {onDelete ? (
          <button type="button" className="rounded-md px-1 text-xs text-red-400" onClick={onDelete}>Delete</button>
        ) : null}
        <span className="flex-1" />
        <button type="button" className="h-6 rounded-md bg-neutral-700 px-2.5 text-xs" onClick={onCancel}>Cancel</button>
        <button type="submit" className="h-6 rounded-md bg-[#007aff] px-2.5 text-xs disabled:opacity-50" disabled={!value.trim()}>
          {onDelete ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}

type Editing = { kind: "new"; path: AnnotateNode[] } | { kind: "edit"; id: string };

/**
 * Annotate for one device in one thread. `start` freezes the screen; the
 * overlay picks an element; a saved note becomes a pill in the thread's
 * composer and the panel returns to the live stream.
 */
export function useAnnotate(threadId: string, udid: string | null, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const [snapshot, setSnapshot] = useState<AnnotateSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<AnnotateNode[]>([]);
  const [levels, setLevels] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notes, setNotes] = useState<ReadonlyMap<string, AnnotateNote>>(new Map());
  // Notes whose pills are not in the draft yet.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const ids = noteIds(composer.draft);
  const idsKey = ids.join(" ");
  const latest = useRef({ pending });
  latest.current = { pending };
  const remember = (note: AnnotateNote) => setNotes((current) => new Map(current).set(note.id, note));
  const forget = (id: string) => setPending((current) => {
    const next = new Set(current);
    next.delete(id);
    return next;
  });

  const stop = useCallback(() => {
    setSnapshot(null);
    setHover([]);
    setLevels(0);
    setEditing(null);
  }, []);
  const start = useCallback(async () => {
    if (!udid || !enabled || loading) return;
    setLoading(true);
    try {
      setSnapshot(await rpc.call("annotateSnapshot", { threadId, udid }));
    } catch (cause) {
      toast.error(describe(cause));
    } finally {
      setLoading(false);
    }
  }, [rpc, threadId, udid, enabled, loading]);
  const active = snapshot !== null && snapshot.udid === udid;
  const toggle = useCallback(() => {
    if (active) stop();
    else void start();
  }, [active, start, stop]);

  useEffect(() => {
    toggles.set(threadId, toggle);
    return () => {
      if (toggles.get(threadId) === toggle) toggles.delete(threadId);
    };
  }, [threadId, toggle]);
  // Another device, or the device going away, ends the pick.
  useEffect(() => {
    if (snapshot && (snapshot.udid !== udid || !enabled)) stop();
  }, [snapshot, udid, enabled, stop]);
  useEffect(() => composer.onSubmitted(stop), [composer, stop]);

  // Pills from before this panel mounted, such as after a reload.
  useEffect(() => {
    const missing = ids.filter((id) => !notes.has(id));
    if (!missing.length) return;
    let live = true;
    rpc.call("annotateGetNotes", { threadId, ids: missing })
      .then((found) => { if (live) found.forEach(remember); })
      .catch(() => {});
    return () => { live = false; };
  }, [idsKey, threadId]);

  // Escape ends the pick; ↑/↓ walk the selected element's ancestors.
  useEffect(() => {
    if (!active || editing) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const editable = target instanceof HTMLElement
        && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key === "Escape") stop();
      else if (event.key === "ArrowUp" && !editable) setLevels((level) => level + 1);
      else if (event.key === "ArrowDown" && !editable) setLevels((level) => Math.max(0, level - 1));
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [active, editing, stop]);

  const drafted = [...new Set([...ids, ...pending])].flatMap((id) => notes.get(id) ?? []);
  const next = Math.max(0, ...drafted.map((note) => note.number)) + 1;

  const add = (path: AnnotateNode[], comment: string) => {
    const shot = snapshot;
    const element = path[path.length - 1];
    if (!shot || !element) return;
    const note: AnnotateNote = {
      id: newNoteId(),
      number: next,
      comment,
      udid: shot.udid,
      device: shot.device,
      runtime: shot.runtime,
      app: shot.app,
      element: {
        type: element.type,
        label: element.label,
        identifier: element.identifier,
        value: element.value,
        frame: element.frame,
        ancestors: path.slice(0, -1).map(describeNode).slice(-20),
        screen: shot.screen,
      },
    };
    remember(note);
    setPending((current) => new Set(current).add(note.id));
    stop();
    void (async () => {
      await rpc.call("annotateSaveNote", { threadId, note });
      // The screenshot comes before the pill, so a message sent at once has
      // it too; a slow one gives up after 5 seconds.
      const image = (async () => {
        const base64 = await markedShot(shot, note);
        if (base64) await rpc.call("annotateSaveNoteImage", { threadId, id: note.id, base64 });
      })().catch(() => {});
      await Promise.race([image, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (latest.current.pending.has(note.id)) {
        composer.insert([{ provider: NOTE_PROVIDER, id: note.id, label: pillLabel(note) }, " "], { at: "end" });
      }
    })()
      .catch((cause) => toast.error(describe(cause)))
      .finally(() => forget(note.id));
  };
  const edit = (id: string, comment: string) => {
    const note = notes.get(id);
    setEditing(null);
    if (!note) return;
    const edited = { ...note, comment };
    remember(edited);
    rpc.call("annotateSaveNote", { threadId, note: edited }).catch((cause) => toast.error(describe(cause)));
  };
  const remove = (id: string) => {
    setEditing(null);
    forget(id);
    composer.replace((draft) => withoutNote(draft, id));
  };

  /**
   * The frozen screen at `size` CSS pixels: `screen` goes inside the device's
   * masked screen, over the live video; `layer` goes above it, unclipped, so
   * the note editor can extend past the screen's rounded corners.
   */
  const render = (size: { width: number; height: number }): { screen: ReactNode; layer: ReactNode } | null => {
    if (!active || !snapshot || size.width <= 0) return null;
    const scale = size.width / snapshot.screen.width;
    const toStage = (box: AnnotateBox): AnnotateBox => ({
      x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale,
    });
    const selected = climb(hover, levels);
    const target = editing ? null : selected[selected.length - 1];
    const pins = drafted.filter((note) => note.udid === snapshot.udid);
    const editNote = editing?.kind === "edit" ? notes.get(editing.id) : undefined;
    const editElement = editing?.kind === "new" ? editing.path[editing.path.length - 1] : editNote?.element;
    const pointAt = (event: ReactPointerEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
    };
    const box = (frame: AnnotateBox, className: string) => {
      const stageBox = toStage(frame);
      return <div aria-hidden="true" className={className}
        style={{ left: stageBox.x, top: stageBox.y, width: stageBox.width, height: stageBox.height }} />;
    };
    const screen = <img alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full"
      src={`data:${snapshot.image.mimeType};base64,${snapshot.image.data}`} />;
    const layer = (
      <div
        role="application"
        aria-label="Annotate the simulator screen. Point at an element and click it to write a note."
        className="absolute inset-0 cursor-crosshair select-none"
        onPointerMove={(event) => {
          if (editing) return;
          const { x, y } = pointAt(event);
          const path = hitTest(snapshot.tree, x, y);
          if (path[path.length - 1] !== hover[hover.length - 1]) {
            setHover(path);
            setLevels(0);
          }
        }}
        onPointerLeave={() => { if (!editing) setHover([]); }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          if (editing) setEditing(null);
          else if (target) setEditing({ kind: "new", path: selected });
        }}
      >
        {pins.map((note) => {
          const stageBox = toStage(note.element.frame);
          return (
            <div key={note.id}>
              {box(note.element.frame, "pointer-events-none absolute rounded-[3px] border-[1.5px] border-[#007aff]")}
              <button
                type="button"
                title={note.comment}
                aria-label={`Note ${note.number}: ${note.comment}`}
                className="absolute flex size-[18px] items-center justify-center rounded-full border-[1.5px] border-white bg-[#007aff] text-[10px] font-semibold text-white shadow"
                style={{ left: Math.max(0, stageBox.x - 9), top: Math.max(0, stageBox.y - 9) }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setEditing({ kind: "edit", id: note.id })}
              >
                {note.number}
              </button>
            </div>
          );
        })}
        {target ? (() => {
          const stageBox = toStage(target.frame);
          return <>
            {box(target.frame, "pointer-events-none absolute rounded-[3px] border-2 border-[#007aff] bg-[#007aff]/10")}
            <div className="pointer-events-none absolute max-w-[220px] truncate rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] leading-4 text-white"
              style={{ left: Math.min(stageBox.x, Math.max(0, size.width - 220)), top: stageBox.y >= 24 ? stageBox.y - 22 : stageBox.y + stageBox.height + 4 }}>
              {describeNode(target)}
              {target.identifier ? <span className="text-sky-300"> #{target.identifier}</span> : null}
              {` ${Math.round(target.frame.width)}×${Math.round(target.frame.height)}`}
            </div>
          </>;
        })() : null}
        {editing && editElement ? <>
          {editing.kind === "new" ? box(editElement.frame, "pointer-events-none absolute rounded-[3px] border-2 border-[#007aff] bg-[#007aff]/10") : null}
          <NoteEditor
            key={editing.kind === "edit" ? editing.id : "new"}
            title={`${editNote?.number ?? next} · ${describeNode(editElement)}`}
            initial={editNote?.comment ?? ""}
            anchor={toStage(editElement.frame)}
            stage={size}
            onCancel={() => setEditing(null)}
            onSave={(comment) => (editing.kind === "new" ? add(editing.path, comment) : edit(editing.id, comment))}
            onDelete={editing.kind === "edit" ? () => remove(editing.id) : undefined}
          />
        </> : null}
      </div>
    );
    return { screen, layer };
  };

  return { active, loading, toggle, stop, render };
}
