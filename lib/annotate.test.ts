import { describe, expect, it } from "vitest";
import {
  NOTE_PROVIDER,
  annotateTree,
  climb,
  formatNote,
  hitTest,
  noteIds,
  pillLabel,
  withoutNote,
  type AnnotateNode,
  type AnnotateNote,
} from "./annotate";

const node = (type: string, frame: [number, number, number, number], extra: Partial<AnnotateNode> = {}): AnnotateNode => ({
  type, label: null, identifier: null, value: null,
  frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] },
  children: [], ...extra,
});

// A full-screen group over a card, as UIKit and React Native report them.
const buy = node("Button", [16, 380, 370, 52], { label: "Buy Pro", identifier: "buy-pro" });
const card = node("Other", [8, 300, 386, 200], { children: [buy] });
const cardTwin = node("Other", [8, 300, 386, 200], { children: [card] });
const toolbar = node("Group", [0, 788, 402, 86], { label: "Toolbar" });
const overlay = node("Group", [0, 0, 402, 874], { children: [cardTwin] });
const root = node("Application", [0, 0, 402, 874], { label: "Nimbus", children: [overlay, toolbar] });

describe("annotateTree", () => {
  it("keeps the nested tree with trimmed text", () => {
    const tree = annotateTree(JSON.stringify([{
      type: "Application", AXLabel: "Nimbus", frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [{ type: "Button", AXLabel: "  Buy\n Pro ", AXUniqueId: "buy-pro", AXValue: "", frame: { x: 16, y: 380, width: 370, height: 52 } }],
    }]));
    expect(tree).toEqual({
      type: "Application", label: "Nimbus", identifier: null, value: null,
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [{ type: "Button", label: "Buy Pro", identifier: "buy-pro", value: null,
        frame: { x: 16, y: 380, width: 370, height: 52 }, children: [] }],
    });
  });

  it("returns null for bad JSON or an empty list", () => {
    expect(annotateTree("not json")).toBeNull();
    expect(annotateTree("[]")).toBeNull();
  });
});

describe("hitTest and climb", () => {
  it("finds the smallest element under the point, with its ancestors", () => {
    expect(hitTest(root, 100, 400)).toEqual([root, overlay, cardTwin, card, buy]);
    expect(hitTest(root, 100, 800).at(-1)).toBe(toolbar);
    expect(hitTest(root, 500, 10)).toEqual([]);
  });

  it("walks up, skipping an ancestor with the same frame, never to the app", () => {
    const path = [root, overlay, cardTwin, card, buy];
    expect(climb(path, 0)).toEqual(path);
    expect(climb(path, 1).at(-1)).toBe(card);
    expect(climb(path, 2).at(-1)).toBe(overlay);
    expect(climb(path, 10).at(-1)).toBe(overlay);
  });
});

const note: AnnotateNote = {
  id: "nabc1234", number: 1, comment: "Make it green\nand bigger",
  udid: "AAAA-1", device: "iPhone 17 Pro", runtime: "iOS 26.0", app: "Nimbus",
  element: {
    type: "Button", label: "Buy Pro", identifier: "buy-pro", value: null,
    frame: { x: 16, y: 380.33333, width: 370, height: 52 },
    ancestors: ['Application "Nimbus"', "Group"], screen: { width: 402, height: 874 },
  },
};

describe("formatNote", () => {
  it("gives the agent the comment, the testID, and the frame", () => {
    const text = formatNote(note);
    expect(text).toContain("# Simulator note 1");
    expect(text).toContain("> Make it green\n> and bigger");
    expect(text).toContain('- Element: Button "Buy Pro"');
    expect(text).toContain("`buy-pro` (in React Native and Expo, the `testID` prop");
    expect(text).toContain("370×52 pt at (16, 380.3), on a 402×874 pt screen");
    expect(text).toContain('Application "Nimbus" › Group');
  });

  it("says when there is no identifier", () => {
    expect(formatNote({ ...note, element: { ...note.element, identifier: null } })).toContain("Identifier: none");
  });
});

describe("pills", () => {
  const pill = (id: string, from: number, to: number) => ({ kind: "plugin", provider: NOTE_PROVIDER, id, label: id, from, to });
  const draft = { text: "AA BB fix", mentions: [pill("na", 0, 2), pill("nb", 3, 5), { kind: "thread", from: 6, to: 9 }] };

  it("are labeled by the element's text", () => {
    expect(pillLabel(note)).toBe("1 · Buy Pro");
  });

  it("list note ids in order and remove one, shifting the rest", () => {
    expect(noteIds(draft)).toEqual(["na", "nb"]);
    const next = withoutNote(draft, "na");
    expect(next.text).toBe("BB fix");
    expect(next.mentions.map((mention) => [mention.from, mention.to])).toEqual([[0, 2], [3, 6]]);
  });
});
