import type { ControlState, Driver } from "../lib/session-types";

export interface ControlOperation {
  readonly signal: AbortSignal;
  release(): void;
}

interface Lease {
  state: ControlState;
  operations: Set<(reason: unknown) => void>;
}

/** One in-memory owner per device. Only an explicit human handoff can replace it. */
export class ControlLeases {
  private readonly leases = new Map<string, Lease>();
  private disposed = false;

  constructor(
    private readonly onChange: (udid: string, state: ControlState | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  state(udid: string): ControlState | null {
    const state = this.leases.get(udid)?.state;
    return state ? { ...state } : null;
  }

  /** Attachment claims an unowned device; it never undoes an existing handoff. */
  ensure(udid: string, threadId: string, mode: Driver): ControlState {
    this.assertAvailable();
    return this.state(udid) ?? this.set(udid, threadId, mode);
  }

  /** Explicit panel action: may transfer ownership from another thread or mode. */
  set(udid: string, threadId: string, mode: Driver): ControlState {
    this.assertAvailable();
    const previous = this.leases.get(udid);
    if (previous?.state.threadId === threadId && previous.state.mode === mode) {
      return { ...previous.state };
    }
    this.leases.set(udid, {
      state: { threadId, mode, changedAt: this.now() },
      operations: new Set(),
    });
    this.abort(previous, new Error(`Control of simulator ${udid} changed. The previous operation was cancelled.`));
    this.onChange(udid, this.state(udid));
    return this.state(udid)!;
  }

  assert(udid: string, threadId: string, mode: Driver): void {
    this.assertAvailable();
    const state = this.leases.get(udid)?.state;
    if (!state) {
      throw new Error(`No thread controls simulator ${udid}. Attach it or take control in the simulator panel first.`);
    }
    if (state.threadId !== threadId) {
      throw new Error(`Simulator ${udid} is controlled by thread ${state.threadId} (${state.mode}). Take control in this thread's simulator panel before sending input.`);
    }
    if (state.mode !== mode) {
      throw new Error(mode === "agent"
        ? `Simulator ${udid} is in human control. The user can choose Let agent drive in the simulator panel.`
        : `Simulator ${udid} is in agent control. Choose Take control in the simulator panel before sending input.`);
    }
  }

  /** Hold a cancellable operation for either a human RPC or an agent tool. */
  begin(udid: string, threadId: string, mode: Driver, parentSignal?: AbortSignal): ControlOperation {
    this.assert(udid, threadId, mode);
    parentSignal?.throwIfAborted();
    const lease = this.leases.get(udid)!;
    const controller = new AbortController();
    let released = false;
    const finish = (reason: unknown) => {
      if (released) return;
      released = true;
      // Capture the original lease: an old operation cannot release a new owner.
      lease.operations.delete(finish);
      parentSignal?.removeEventListener("abort", parentAborted);
      controller.abort(reason);
    };
    const parentAborted = () => finish(parentSignal?.reason);
    lease.operations.add(finish);
    parentSignal?.addEventListener("abort", parentAborted, { once: true });
    if (parentSignal?.aborted) parentAborted();
    return {
      signal: controller.signal,
      release: () => finish(new Error(`The ${mode} operation on simulator ${udid} has ended.`)),
    };
  }

  beginAgent(udid: string, threadId: string, parentSignal?: AbortSignal): ControlOperation {
    return this.begin(udid, threadId, "agent", parentSignal);
  }

  /** Observers cannot release another thread's ownership. */
  release(udid: string, threadId: string): void {
    const lease = this.leases.get(udid);
    if (!lease || lease.state.threadId !== threadId) return;
    this.leases.delete(udid);
    this.abort(lease, new Error(`Thread ${threadId} released control of simulator ${udid}.`));
    this.onChange(udid, this.state(udid));
  }

  releaseThread(threadId: string): void {
    for (const [udid, lease] of [...this.leases]) {
      if (lease.state.threadId === threadId) this.release(udid, threadId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const previous = [...this.leases];
    this.leases.clear();
    for (const [udid, lease] of previous) {
      this.abort(lease, new Error("Simulator control ended because the plugin is stopping."));
      this.onChange(udid, null);
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Simulator control is unavailable because the plugin is stopping.");
  }

  private abort(lease: Lease | undefined, reason: unknown): void {
    if (!lease) return;
    for (const finish of [...lease.operations]) finish(reason);
  }
}
