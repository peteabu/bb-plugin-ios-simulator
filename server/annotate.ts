// Annotate's backend: a screenshot read together with the accessibility tree,
// and the notes the panel turns into composer pills. Notes live in the
// plugin's database; each one's marked screenshot lives in its thread's
// storage, and the mention provider hands both to the agent at send time.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  NOTE_PROVIDER,
  annotateTree,
  formatNote,
  type AnnotateNode,
  type AnnotateNote,
  type AnnotateSnapshot,
} from "../lib/annotate";

const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const screenSchema = z.object({ width: z.number().positive(), height: z.number().positive() });
const shortText = z.string().max(400).nullable();

export const annotateNodeSchema: z.ZodType<AnnotateNode> = z.lazy(() =>
  z.object({
    type: z.string().max(100),
    label: shortText,
    identifier: shortText,
    value: shortText,
    frame: boxSchema,
    children: z.array(annotateNodeSchema).max(500),
  }),
);

export const annotateSnapshotSchema: z.ZodType<AnnotateSnapshot> = z.object({
  udid: z.string(),
  device: z.string(),
  runtime: z.string(),
  takenAt: z.number(),
  image: z.object({ data: z.string(), mimeType: z.string() }),
  screen: screenSchema,
  app: z.string().nullable(),
  tree: annotateNodeSchema,
});

export const noteIdSchema = z.string().regex(/^n[a-z0-9]{6,30}$/);

export const annotateNoteSchema: z.ZodType<AnnotateNote> = z.object({
  id: noteIdSchema,
  number: z.number().int().positive().max(9999),
  comment: z.string().trim().min(1).max(4000),
  udid: z.string().max(100),
  device: z.string().max(200),
  runtime: z.string().max(100),
  app: z.string().max(200).nullable(),
  element: z.object({
    type: z.string().max(100),
    label: shortText,
    identifier: shortText,
    value: shortText,
    frame: boxSchema,
    ancestors: z.array(z.string().max(200)).max(20),
    screen: screenSchema,
  }),
});

/** A JPEG of up to 4 MB, base64-encoded. */
export const MAX_NOTE_IMAGE_BASE64 = Math.ceil((4 * 1024 * 1024 * 4) / 3);

/**
 * Read the screen and the tree together so they describe the same frame.
 * Rejects when the tree is unavailable: without it nothing can be picked.
 */
export async function readAnnotateSnapshot(
  device: { udid: string; name: string; runtime: string },
  read: {
    screenshot: (signal?: AbortSignal) => Promise<{ data: string; mimeType: string }>;
    accessibility: (signal?: AbortSignal) => Promise<string>;
  },
  signal?: AbortSignal,
): Promise<AnnotateSnapshot> {
  const [image, raw] = await Promise.all([read.screenshot(signal), read.accessibility(signal)]);
  const tree = annotateTree(raw);
  if (!tree || tree.frame.width <= 0 || tree.frame.height <= 0) {
    throw new Error("The simulator returned no accessibility elements for this screen.");
  }
  return {
    udid: device.udid,
    device: device.name,
    runtime: device.runtime,
    takenAt: Date.now(),
    image: { data: image.data, mimeType: image.mimeType },
    screen: { width: tree.frame.width, height: tree.frame.height },
    app: tree.label,
    tree,
  };
}

interface NoteRow {
  thread_id: string;
  note: string;
  image_path: string | null;
}

/** Stored notes, the screenshot writer, and the mention provider. */
export function registerAnnotateNotes(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE annotate_notes (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, note TEXT NOT NULL, image_path TEXT)",
    "CREATE INDEX annotate_notes_thread ON annotate_notes(thread_id)",
  ]);
  // A note id belongs to the thread that stored it first.
  const upsert = db.prepare(
    `INSERT INTO annotate_notes (id, thread_id, note) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET note = excluded.note
      WHERE thread_id = excluded.thread_id`,
  );
  const select = db.prepare<[string], NoteRow>(
    "SELECT thread_id, note, image_path FROM annotate_notes WHERE id = ?",
  );
  const setImage = db.prepare("UPDATE annotate_notes SET image_path = ? WHERE id = ?");
  const removeThread = db.prepare("DELETE FROM annotate_notes WHERE thread_id = ?");
  const parse = (row: NoteRow): AnnotateNote => annotateNoteSchema.parse(JSON.parse(row.note));
  const owned = (id: string, threadId: string) => {
    const row = select.get(id);
    return row?.thread_id === threadId ? row : undefined;
  };

  bb.ui.registerMentionProvider({
    id: NOTE_PROVIDER,
    label: "Simulator notes",
    // Notes come from the panel's Annotate mode, never from the @ menu.
    search: () => [],
    resolve(id) {
      const row = select.get(id);
      if (!row) {
        throw new Error("A simulator note in this message no longer exists. Remove its pill and add the note again.");
      }
      const note = parse(row);
      return {
        context: formatNote(note),
        ...(row.image_path && {
          experimental_images: [{
            type: "localImage" as const,
            path: row.image_path,
            context: `Screenshot for simulator note ${note.number}: a blue outline and pin ${note.number} mark the element.`,
          }],
        }),
      };
    },
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    removeThread.run(thread.id);
  });

  return {
    save(threadId: string, note: AnnotateNote) {
      upsert.run(note.id, threadId, JSON.stringify(note));
    },
    get(threadId: string, ids: string[]): AnnotateNote[] {
      return ids.flatMap((id) => {
        const row = owned(id, threadId);
        return row ? [parse(row)] : [];
      });
    },
    async saveImage(threadId: string, id: string, base64: string) {
      if (!owned(id, threadId)) throw new Error("This note no longer exists.");
      const bytes = Buffer.from(base64, "base64");
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        throw new Error("The note screenshot must be a JPEG.");
      }
      const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({ threadId });
      const path = `${storageRootPath}/ios-simulator/notes/${id}.jpg`;
      await bb.sdk.files.write({
        hostId,
        rootPath: storageRootPath,
        path,
        content: base64,
        contentEncoding: "base64",
        createParents: true,
      });
      setImage.run(path, id);
    },
  };
}
