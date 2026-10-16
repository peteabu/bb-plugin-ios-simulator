// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DevicePicker } from "./device-picker";

const DEVICES = [
  { udid: "a", name: "iPhone 17 Pro", runtime: "iOS 26.0", state: "Booted", isAvailable: true },
  { udid: "b", name: "iPhone 17", runtime: "iOS 26.0", state: "Shutdown", isAvailable: true },
  { udid: "c", name: "iPad Air", runtime: "iPadOS 26.0", state: "Booted", isAvailable: true },
  { udid: "d", name: "iPhone unavailable", runtime: "iOS 18.0", state: "Shutdown", isAvailable: false },
];
const children = <span>Current device</span>;

describe("device picker", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("announces the current device and navigates groups without moving trigger focus", () => {
    const onChange = vi.fn();
    const slot = render(<DevicePicker devices={DEVICES} attached={["a"]} value="a" onChange={onChange}>{children}</DevicePicker>);
    const trigger = slot.getByRole("combobox", { name: "Simulator device" });
    trigger.focus();
    expect(trigger.getAttribute("aria-controls")).toBeNull();
    expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe("iPhone 17 Pro, iOS 26.0, Running");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-controls")).toBe(slot.getByRole("listbox", { name: "Simulator devices" }).id);
    expect(slot.getByRole("group", { name: "Attached to thread" })).toBeTruthy();
    expect(slot.getByRole("group", { name: "Available" })).toBeTruthy();
    const selected = slot.getByRole("option", { name: "iPhone 17 Pro, iOS 26.0, Running" });
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(selected.id);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(slot.getByRole("option", { name: "iPhone 17, iOS 26.0" }).id);
    fireEvent.keyDown(trigger, { key: "End" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(slot.getByRole("option", { name: "iPad Air, iPadOS 26.0, Running" }).id);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(selected.id);
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(slot.queryByRole("listbox")).toBeNull();
    expect(trigger.getAttribute("aria-activedescendant")).toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBeNull();
  });

  it("selects with Enter, Space and Tab, and closes on a parent value switch", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState("a");
      return <DevicePicker devices={DEVICES} attached={["a"]} value={value} onChange={(next) => { onChange(next); setValue(next); }}>{children}</DevicePicker>;
    }
    const slot = render(<Harness />);
    const trigger = slot.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(slot.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(trigger, { key: " " });
    fireEvent.keyDown(trigger, { key: "Home" });
    fireEvent.keyDown(trigger, { key: " " });
    expect(onChange).toHaveBeenLastCalledWith("a");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "End" });
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(trigger, tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles typeahead matches and resets the prefix after a pause", () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const onChange = vi.fn();
    const slot = render(<DevicePicker devices={DEVICES} attached={["a"]} value="a" onChange={onChange}>{children}</DevicePicker>);
    const trigger = slot.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "i" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(slot.getByRole("option", { name: "iPhone 17, iOS 26.0" }).id);
    fireEvent.keyDown(trigger, { key: "i" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(slot.getByRole("option", { name: "iPad Air, iPadOS 26.0, Running" }).id);
    now += 701;
    for (const key of "iphone 17 p") fireEvent.keyDown(trigger, { key });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(slot.getByRole("option", { name: "iPhone 17 Pro, iOS 26.0, Running" }).id);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(slot.queryByRole("listbox")).toBeNull();
  });

  it("supports pointer selection, ignores unavailable rows, and dismisses outside without selection", () => {
    const onChange = vi.fn();
    const slot = render(<DevicePicker devices={DEVICES} attached={["a"]} value="a" onChange={onChange}>{children}</DevicePicker>);
    const trigger = slot.getByRole("combobox");
    trigger.focus();
    fireEvent.click(trigger);
    const unavailable = slot.getByRole("option", { name: /Unavailable/ });
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(unavailable);
    expect(onChange).not.toHaveBeenCalled();
    const next = slot.getByRole("option", { name: "iPhone 17, iOS 26.0" });
    fireEvent.mouseEnter(next);
    expect(trigger.getAttribute("aria-activedescendant")).toBe(next.id);
    expect(fireEvent.mouseDown(next)).toBe(false);
    fireEvent.click(next);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("b");
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "End" });
    fireEvent.pointerDown(document.body);
    expect(slot.queryByRole("listbox")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.click(trigger);
    const blur = new Event("focusout", { bubbles: true });
    Object.defineProperty(blur, "relatedTarget", { value: window });
    fireEvent(trigger, blur);
    expect(slot.queryByRole("listbox")).toBeNull();
  });

  it("closes for external selection or disabling and removes its outside listener on unmount", () => {
    const onChange = vi.fn();
    const remove = vi.spyOn(document, "removeEventListener");
    const slot = render(<DevicePicker devices={DEVICES} attached={[]} value="a" onChange={onChange}>{children}</DevicePicker>);
    fireEvent.click(slot.getByRole("combobox"));
    slot.rerender(<DevicePicker devices={DEVICES} attached={[]} value="b" onChange={onChange}>{children}</DevicePicker>);
    expect(slot.queryByRole("listbox")).toBeNull();
    fireEvent.click(slot.getByRole("combobox"));
    slot.rerender(<DevicePicker devices={DEVICES} attached={[]} value="b" onChange={onChange} disabled>{children}</DevicePicker>);
    expect(slot.queryByRole("listbox")).toBeNull();
    expect((slot.getByRole("combobox") as HTMLButtonElement).disabled).toBe(true);
    slot.rerender(<DevicePicker devices={DEVICES} attached={[]} value="b" onChange={onChange}>{children}</DevicePicker>);
    fireEvent.click(slot.getByRole("combobox"));
    slot.unmount();
    expect(remove.mock.calls.filter(([event]) => event === "pointerdown").length).toBe(3);
    fireEvent.pointerDown(document.body);
    expect(onChange).not.toHaveBeenCalled();
  });
});
