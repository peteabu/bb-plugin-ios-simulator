// Accessibility snapshots for agents. serve-sim's helper returns the raw AXe
// tree; this module flattens it the way serve-sim's own preview does and
// renders it compactly so a model can pick an element and tap its center.

export interface AxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AxElement {
  id: string;
  path: string;
  label: string;
  value: string;
  role: string;
  type: string;
  enabled: boolean;
  frame: AxRect;
}

export interface AxSnapshot {
  screen: { width: number; height: number };
  elements: AxElement[];
  errors: string[];
}

interface RawAxeNode {
  AXUniqueId?: string | null;
  AXLabel?: string | null;
  AXValue?: string | null;
  enabled?: boolean;
  frame?: Partial<AxRect>;
  role_description?: string;
  type?: string;
  children?: RawAxeNode[];
}

const MAX_ELEMENTS = 500;

function rectOf(node: RawAxeNode): AxRect {
  const frame = node.frame ?? {};
  return {
    x: Number(frame.x ?? 0),
    y: Number(frame.y ?? 0),
    width: Number(frame.width ?? 0),
    height: Number(frame.height ?? 0),
  };
}

function sameRect(a: AxRect, b: AxRect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

export function normalizeAxTree(rawJson: string): AxSnapshot {
  let roots: RawAxeNode[];
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    roots = Array.isArray(parsed) ? (parsed as RawAxeNode[]) : [parsed as RawAxeNode];
  } catch (cause) {
    return {
      screen: { width: 1, height: 1 },
      elements: [],
      errors: [
        `Accessibility tree was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    };
  }
  const screen = roots[0] ? rectOf(roots[0]) : { x: 0, y: 0, width: 1, height: 1 };
  const elements: AxElement[] = [];
  const visit = (node: RawAxeNode, path: string) => {
    if (elements.length >= MAX_ELEMENTS) return;
    const frame = rectOf(node);
    if (!sameRect(frame, screen)) {
      elements.push({
        id: node.AXUniqueId ?? path,
        path,
        label: node.AXLabel ?? "",
        value: node.AXValue ?? "",
        role: node.role_description ?? "",
        type: node.type ?? "",
        enabled: node.enabled !== false,
        frame,
      });
    }
    const children = node.children ?? [];
    for (let index = 0; index < children.length && elements.length < MAX_ELEMENTS; index++) {
      visit(children[index]!, `${path}.${index}`);
    }
  };
  roots.forEach((root, index) => visit(root, String(index)));
  return {
    screen: { width: screen.width || 1, height: screen.height || 1 },
    elements,
    errors: [],
  };
}

export function centerNormalized(
  element: AxElement,
  screen: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.min(1, Math.max(0, (element.frame.x + element.frame.width / 2) / screen.width)),
    y: Math.min(1, Math.max(0, (element.frame.y + element.frame.height / 2) / screen.height)),
  };
}

/** Score an element against a free-text query; higher is better, 0 is no match. */
function matchScore(element: AxElement, needle: string): number {
  const label = element.label.toLowerCase();
  const value = element.value.toLowerCase();
  const id = element.id.toLowerCase();
  if (id === needle || label === needle) return 100;
  if (value === needle) return 90;
  if (label.startsWith(needle)) return 70;
  if (label.includes(needle)) return 50;
  if (value.includes(needle)) return 40;
  if (id.includes(needle)) return 30;
  return 0;
}

export function findElement(snapshot: AxSnapshot, query: string): AxElement | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  let best: { element: AxElement; score: number } | null = null;
  for (const element of snapshot.elements) {
    const score = matchScore(element, needle) + (element.enabled ? 1 : 0);
    if (score > 1 && (best === null || score > best.score)) best = { element, score };
  }
  return best?.element ?? null;
}

function trim(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** One line per element, with the normalized center a tap tool accepts. */
export function formatAxSnapshot(
  snapshot: AxSnapshot,
  options: { filter?: string; limit?: number } = {},
): string {
  const limit = options.limit ?? 120;
  const filter = options.filter?.trim().toLowerCase() ?? "";
  if (snapshot.errors.length > 0) {
    return `Accessibility snapshot unavailable: ${snapshot.errors.join("; ")}`;
  }
  const rows = snapshot.elements.filter((element) => {
    if (filter === "") return true;
    return `${element.label} ${element.value} ${element.role} ${element.type} ${element.id}`
      .toLowerCase()
      .includes(filter);
  });
  const lines = [
    `screen ${Math.round(snapshot.screen.width)}x${Math.round(snapshot.screen.height)} points; ${rows.length} element${rows.length === 1 ? "" : "s"}${filter ? ` matching "${options.filter}"` : ""}. Tap with the normalized center shown as @(x,y).`,
  ];
  for (const element of rows.slice(0, limit)) {
    const center = centerNormalized(element, snapshot.screen);
    const parts = [
      element.role || element.type || "element",
      element.label ? `"${trim(element.label, 60)}"` : "",
      element.value ? `= "${trim(element.value, 40)}"` : "",
      element.enabled ? "" : "(disabled)",
      `[${Math.round(element.frame.x)},${Math.round(element.frame.y)} ${Math.round(element.frame.width)}x${Math.round(element.frame.height)}]`,
      `@(${center.x.toFixed(3)},${center.y.toFixed(3)})`,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" ")}`);
  }
  if (rows.length > limit) lines.push(`… ${rows.length - limit} more; pass a filter to narrow.`);
  return lines.join("\n");
}
