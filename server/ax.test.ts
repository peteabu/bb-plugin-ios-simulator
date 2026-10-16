import { describe, expect, it } from "vitest";
import { centerNormalized, findElement, formatAxSnapshot, normalizeAxTree } from "./ax";

const RAW = JSON.stringify([
  {
    AXUniqueId: null,
    AXLabel: null,
    AXValue: null,
    enabled: true,
    frame: { x: 0, y: 0, width: 400, height: 800 },
    role_description: "application",
    type: "Application",
    children: [
      {
        AXUniqueId: "signin",
        AXLabel: "Sign in",
        AXValue: null,
        enabled: true,
        frame: { x: 100, y: 700, width: 200, height: 50 },
        role_description: "button",
        type: "Button",
        children: [],
      },
      {
        AXUniqueId: null,
        AXLabel: "Email",
        AXValue: "me@example.com",
        enabled: true,
        frame: { x: 20, y: 300, width: 360, height: 44 },
        role_description: "text field",
        type: "TextField",
        children: [],
      },
    ],
  },
]);

describe("accessibility snapshots", () => {
  it("flattens the tree, skipping the screen-sized root", () => {
    const snapshot = normalizeAxTree(RAW);
    expect(snapshot.screen).toEqual({ width: 400, height: 800 });
    expect(snapshot.elements.map((element) => element.label)).toEqual(["Sign in", "Email"]);
    expect(snapshot.elements[1]!.path).toBe("0.1");
  });

  it("finds elements by label or value and computes normalized centers", () => {
    const snapshot = normalizeAxTree(RAW);
    const button = findElement(snapshot, "sign in");
    expect(button?.id).toBe("signin");
    expect(centerNormalized(button!, snapshot.screen)).toEqual({ x: 0.5, y: 0.90625 });
    expect(findElement(snapshot, "example.com")?.label).toBe("Email");
    expect(findElement(snapshot, "logout")).toBeNull();
  });

  it("formats a compact listing with tap coordinates and filters", () => {
    const text = formatAxSnapshot(normalizeAxTree(RAW), { filter: "button" });
    expect(text).toContain('button "Sign in" [100,700 200x50] @(0.500,0.906)');
    expect(text).not.toContain("Email");
  });

  it("reports unreadable trees instead of throwing", () => {
    const snapshot = normalizeAxTree("not json");
    expect(snapshot.errors[0]).toMatch(/not JSON/);
    expect(formatAxSnapshot(snapshot)).toMatch(/unavailable/);
  });
});
