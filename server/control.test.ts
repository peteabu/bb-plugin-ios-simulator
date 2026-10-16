import { describe, expect, it, vi } from "vitest";
import { ControlLeases } from "./control";

describe("ControlLeases ownership", () => {
  it("claims an unowned device in its actor's mode and preserves existing ownership on reattachment", () => {
    const changed = vi.fn();
    let now = 100;
    const control = new ControlLeases(changed, () => now);
    expect(control.state("phone")).toBeNull();
    expect(control.ensure("phone", "thread-a", "agent")).toEqual({ threadId: "thread-a", mode: "agent", changedAt: 100 });
    now = 200;
    expect(control.ensure("phone", "thread-b", "human")).toEqual({ threadId: "thread-a", mode: "agent", changedAt: 100 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(control.ensure("tablet", "thread-b", "human")).toEqual({ threadId: "thread-b", mode: "human", changedAt: 200 });
  });

  it("transfers control explicitly and returns snapshots that cannot mutate the lease", () => {
    const changed = vi.fn();
    const control = new ControlLeases(changed, () => 123);
    const first = control.ensure("phone", "thread-a", "agent");
    first.threadId = "changed";
    const next = control.set("phone", "thread-b", "human");
    next.mode = "agent";
    const observed = control.state("phone")!;
    observed.changedAt = 0;
    const published = changed.mock.calls[1]![1];
    published.threadId = "changed";
    expect(control.state("phone")).toEqual({ threadId: "thread-b", mode: "human", changedAt: 123 });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("rejects unowned, wrong-thread and wrong-mode mutations with clear guidance", () => {
    const control = new ControlLeases(() => {});
    expect(() => control.assert("phone", "thread-a", "human")).toThrow("No thread controls");
    control.ensure("phone", "thread-a", "human");
    expect(() => control.assert("phone", "thread-b", "human")).toThrow("controlled by thread thread-a");
    expect(() => control.beginAgent("phone", "thread-a")).toThrow("Let agent drive");
    expect(() => control.assert("phone", "thread-a", "human")).not.toThrow();
    control.set("phone", "thread-a", "agent");
    expect(() => control.assert("phone", "thread-a", "human")).toThrow("Take control");
    expect(() => control.assert("phone", "thread-a", "agent")).not.toThrow();
  });

  it("treats an unchanged explicit set as idempotent without cancelling ongoing work", () => {
    const changed = vi.fn();
    let now = 100;
    const control = new ControlLeases(changed, () => now);
    control.ensure("phone", "thread-a", "agent");
    const operation = control.beginAgent("phone", "thread-a");
    now = 200;
    expect(control.set("phone", "thread-a", "agent").changedAt).toBe(100);
    control.ensure("phone", "thread-b", "human");
    expect(operation.signal.aborted).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    operation.release();
  });
});

describe("ControlLeases operation cancellation", () => {
  it("rejects a pre-aborted parent before registering an operation or listener", () => {
    const control = new ControlLeases(() => {});
    control.ensure("phone", "thread-a", "agent");
    const parent = new AbortController();
    parent.abort(new Error("stopped"));
    const add = vi.spyOn(parent.signal, "addEventListener");
    expect(() => control.beginAgent("phone", "thread-a", parent.signal)).toThrow("stopped");
    expect(add).not.toHaveBeenCalled();
    expect(control.state("phone")?.threadId).toBe("thread-a");
  });

  it("aborts every active operation on handoff and prevents stale releases from affecting the new owner", () => {
    const control = new ControlLeases(() => {});
    control.ensure("phone", "thread-a", "agent");
    const first = control.beginAgent("phone", "thread-a");
    const second = control.beginAgent("phone", "thread-a");
    control.set("phone", "thread-b", "human");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(() => first.signal.throwIfAborted()).toThrow("Control of simulator phone changed");
    const replacement = control.begin("phone", "thread-b", "human");
    first.release(); first.release(); second.release();
    expect(replacement.signal.aborted).toBe(false);
    expect(control.state("phone")?.threadId).toBe("thread-b");
    replacement.release();
  });

  it("also aborts an asynchronous human operation when its mode changes to agent", () => {
    const control = new ControlLeases(() => {});
    control.ensure("phone", "thread-a", "human");
    const operation = control.begin("phone", "thread-a", "human");
    control.set("phone", "thread-a", "agent");
    expect(operation.signal.aborted).toBe(true);
    expect(() => operation.signal.throwIfAborted()).toThrow("changed");
    expect(control.beginAgent("phone", "thread-a").signal.aborted).toBe(false);
    control.dispose();
  });

  it("cancels only operations belonging to an aborted parent and removes all parent listeners", () => {
    const control = new ControlLeases(() => {});
    control.ensure("phone", "thread-a", "agent");
    const parent = new AbortController(), otherParent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const otherRemove = vi.spyOn(otherParent.signal, "removeEventListener");
    const first = control.beginAgent("phone", "thread-a", parent.signal);
    const second = control.beginAgent("phone", "thread-a", parent.signal);
    const other = control.beginAgent("phone", "thread-a", otherParent.signal);
    const reason = new Error("agent stopped");
    parent.abort(reason);
    expect(first.signal.reason).toBe(reason);
    expect(second.signal.reason).toBe(reason);
    expect(other.signal.aborted).toBe(false);
    expect(remove).toHaveBeenCalledTimes(2);
    other.release(); other.release(); first.release(); second.release();
    expect(other.signal.aborted).toBe(true);
    expect(otherRemove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("removes every parent listener when ownership is released", () => {
    const changed = vi.fn();
    const control = new ControlLeases(changed);
    control.ensure("phone", "thread-a", "agent");
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const first = control.beginAgent("phone", "thread-a", parent.signal);
    const second = control.beginAgent("phone", "thread-a", parent.signal);
    control.release("phone", "thread-b");
    expect(first.signal.aborted).toBe(false);
    expect(control.state("phone")?.threadId).toBe("thread-a");
    control.release("phone", "thread-a");
    control.release("phone", "thread-a");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(control.state("phone")).toBeNull();
    expect(changed).toHaveBeenLastCalledWith("phone", null);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe("ControlLeases lifecycle", () => {
  it("releases only devices owned by the disappearing thread", () => {
    const control = new ControlLeases(() => {});
    control.ensure("phone", "thread-a", "agent");
    control.ensure("tablet", "thread-a", "human");
    control.ensure("other", "thread-b", "agent");
    const agent = control.beginAgent("phone", "thread-a");
    const human = control.begin("tablet", "thread-a", "human");
    const other = control.beginAgent("other", "thread-b");
    control.releaseThread("thread-a");
    expect(agent.signal.aborted).toBe(true);
    expect(human.signal.aborted).toBe(true);
    expect(control.state("phone")).toBeNull();
    expect(control.state("tablet")).toBeNull();
    expect(control.state("other")?.threadId).toBe("thread-b");
    expect(other.signal.aborted).toBe(false);
    control.dispose();
  });

  it("disposes active work, listeners and ownership once, without persisting to a new instance", () => {
    const changed = vi.fn();
    const control = new ControlLeases(changed);
    control.ensure("phone", "thread-a", "agent");
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const operation = control.beginAgent("phone", "thread-a", parent.signal);
    control.dispose(); control.dispose(); operation.release();
    expect(operation.signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(control.state("phone")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(() => control.ensure("phone", "thread-a", "agent")).toThrow("plugin is stopping");
    expect(() => control.set("phone", "thread-a", "human")).toThrow("plugin is stopping");
    expect(() => control.assert("phone", "thread-a", "agent")).toThrow("plugin is stopping");
    expect(new ControlLeases(() => {}).state("phone")).toBeNull();
  });
});
