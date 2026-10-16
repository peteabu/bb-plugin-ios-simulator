// bb-plugin-ios-simulator — backend entry.
//
// Streams Apple's iOS Simulator into a BB thread panel and gives agents
// native tools to boot, install, screenshot, and drive the same device. The
// heavy lifting (framebuffer capture, HID injection) is serve-sim, run as a
// child process per device; this file wires BB surfaces to the service.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  HARDWARE_BUTTON_NAMES,
  ORIENTATIONS,
  clamp01,
  HID,
  decodeHid,
  screenConfigFrom,
  type HardwareButton,
} from "./lib/sim-protocol";
import { centerNormalized, findElement } from "./server/ax";
import { createNodeExec } from "./server/exec";
import { Simctl, type Exec, type SimDevice } from "./server/simctl";
import {
  CHANNELS,
  SimulatorError,
  SimulatorService,
  describe,
} from "./server/simulator-service";
import {
  StreamManager,
  resolveNodeCommand,
  resolveServeSimEntry,
} from "./server/stream-manager";
import { installNativePatch, nativePatchStatus } from "./server/native-patch";
import { registerAndroid } from "./server/android";
import { registerDeviceBezels } from "./server/device-bezel";
import { ControlLeases } from "./server/control";
import { ReplayRecorder } from "./server/replay";
import type { TimelineEvent } from "./lib/session-types";

export const AGENT_CONTROL_MODES = ["ask", "always", "never"] as const;
export type AgentControlMode = (typeof AGENT_CONTROL_MODES)[number];

const deviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  state: z.string(),
  runtime: z.string(),
  runtimeId: z.string(),
  deviceType: z.string().nullable(),
  isAvailable: z.boolean(),
});

const controlSchema = z.object({ threadId: z.string(), mode: z.enum(["human", "agent"]), changedAt: z.number() });
const clipSchema = z.object({
  id: z.string(), udid: z.string(), threadId: z.string(), createdAt: z.number(),
  startAt: z.number(), endAt: z.number(), frameCount: z.number(),
});
const eventSchema = z.object({
  id: z.string(), at: z.number(), kind: z.enum(["input", "log", "crash", "control", "lifecycle", "error"]),
  actor: z.enum(["human", "agent", "system"]), label: z.string(), detail: z.string().optional(), threadId: z.string().optional(),
});
const replaySchema = z.object({
  recording: z.boolean(), bufferedMs: z.number(), bytes: z.number(), error: z.string().nullable(),
  app: z.string().nullable(), diagnostics: z.string().nullable(), clips: z.array(clipSchema),
});

const stateSchema = z.object({
  ready: z.object({
    ok: z.boolean(),
    problems: z.array(z.string()),
    xcode: z.string().nullable(),
    node: z.string().nullable(),
    serveSim: z.string().nullable(),
  }),
  devices: z.array(deviceSchema),
  sessions: z.array(
    z.object({ udid: z.string(), port: z.number(), startedAt: z.number() }),
  ),
  attached: z.array(z.string()),
  bootedByPlugin: z.array(z.string()),
  consent: z.record(z.string(), z.boolean()),
  controls: z.record(z.string(), controlSchema),
  replay: z.record(z.string(), replaySchema),
  /** Devices whose input Xcode's Device Hub currently captures (taps are ignored until repaired). */
  inputShadowed: z.array(z.string()),
  agentControl: z.enum(AGENT_CONTROL_MODES),
  error: z.string().nullable(),
});
export type SimulatorState = z.infer<typeof stateSchema>;

const ok = z.object({ ok: z.literal(true) });
const buttonEnum = z.enum(HARDWARE_BUTTON_NAMES as [HardwareButton, ...HardwareButton[]]);
const orientationEnum = z.enum(ORIENTATIONS);

export const rpcContract = defineRpcContract({
  state: {
    input: z.object({ threadId: z.string().nullable() }).strict(),
    output: stateSchema,
  },
  attach: {
    input: z.object({ threadId: z.string(), device: z.string().nullable() }).strict(),
    output: z.object({ udid: z.string(), port: z.number(), name: z.string() }),
  },
  detach: {
    input: z
      .object({ threadId: z.string(), udid: z.string(), shutdown: z.boolean() })
      .strict(),
    output: ok,
  },
  button: {
    input: z.object({ threadId: z.string(), udid: z.string(), button: buttonEnum }).strict(),
    output: ok,
  },
  rotate: {
    input: z.object({ threadId: z.string(), udid: z.string(), orientation: orientationEnum }).strict(),
    output: ok,
  },
  openUrl: {
    input: z.object({ threadId: z.string(), udid: z.string(), url: z.string().url() }).strict(),
    output: ok,
  },
  repairInput: {
    input: z.object({ threadId: z.string(), udid: z.string() }).strict(),
    output: z.object({ repaired: z.boolean() }),
  },
  pasteText: {
    input: z.object({ threadId: z.string(), udid: z.string(), text: z.string().max(65536) }).strict(),
    output: ok,
  },
  control: {
    input: z.object({ threadId: z.string(), udid: z.string(), mode: z.enum(["human", "agent"]) }).strict(),
    output: controlSchema,
  },
  saveReplay: {
    input: z.object({ threadId: z.string(), udid: z.string() }).strict(), output: clipSchema,
  },
  timeline: {
    input: z.object({ threadId: z.string(), udid: z.string() }).strict(), output: z.array(eventSchema),
  },
  replayState: {
    input: z.object({ threadId: z.string(), udid: z.string() }).strict(), output: replaySchema,
  },
});

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = string | { content: ToolContent[]; isError?: boolean };

function toolError(error: unknown): ToolResult {
  return { content: [{ type: "text", text: describe(error) }], isError: true };
}

function normalizeAgentControl(value: unknown): AgentControlMode {
  return AGENT_CONTROL_MODES.includes(value as AgentControlMode)
    ? (value as AgentControlMode)
    : "ask";
}

function deviceLine(device: SimDevice, attached: ReadonlySet<string>): string {
  const marker = attached.has(device.udid) ? "*" : "-";
  const suffix = attached.has(device.udid) ? " (attached to this thread)" : "";
  return `${marker} ${device.name} — ${device.runtime} — ${device.state}${suffix} — ${device.udid}`;
}

/** Collaborators a test can replace; production uses real processes. */
export interface PluginDependencies {
  exec?: Exec;
  streams?: StreamManager;
  replay?: ReplayRecorder;
}

export function createPlugin(dependencies: PluginDependencies = {}) {
  return async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({
      agentControl: {
        type: "select",
        label: "Agent control",
        options: [...AGENT_CONTROL_MODES],
        default: "ask",
      },
      idleShutdownMinutes: {
        type: "number",
        label: "Shut down simulators this plugin booted after detaching (minutes, 0 = never)",
        default: 10,
        experimental_schema: z.number().int().min(0).max(1440),
      },
      screenshotMaxDimension: {
        type: "number",
        label: "Longest side of screenshots sent to agents (pixels)",
        default: 1200,
        experimental_schema: z.number().int().min(200).max(4000),
      },
      captureHz: {
        type: "number",
        label: "Forced capture rate (frames per second; 0 = automatic: 60 unless the patched capture module is installed)",
        default: 0,
        experimental_schema: z.number().int().min(0).max(120),
      },
      nodePath: {
        type: "string",
        label: "Node.js executable (optional; found on PATH by default)",
        default: "",
      },
      serveSimPath: {
        type: "string",
        label: "serve-sim entry script (optional; the bundled dependency by default)",
        default: "",
      },
    });
    let current = await settings.get();
    settings.onChange((next) => {
      current = next;
    });

    const exec = dependencies.exec ?? createNodeExec();
    const simctl = new Simctl(exec);
    // Swap in the rebuilt capture module (polls the framebuffer for changes
    // instead of relying on the simulator's unreliable notifications) when the
    // plugin ships one. Harmless no-op otherwise.
    let nativePatched = false;
    if (!dependencies.streams) {
      try {
        const entry = resolveServeSimEntry({ override: current.serveSimPath });
        installNativePatch(entry?.path ?? null, { log: (message) => bb.log.info(message) });
        nativePatched = nativePatchStatus(entry?.path ?? null).installed;
      } catch (error) {
        bb.log.warn(`could not install the patched capture module: ${describe(error)}`);
      }
    }
    const streams =
      dependencies.streams ??
      new StreamManager({
        log: bb.log,
        node: () => resolveNodeCommand({ override: current.nodePath }),
        serveSim: () => resolveServeSimEntry({ override: current.serveSimPath }),
        onChange: () => { syncRecorders(); bb.realtime.publish(CHANNELS.sessions, {}); },
        // 0 = automatic: the forced-capture pacer is only needed with the
        // stock serve-sim capture; the patched module polls on its own.
        captureHz: () => (current.captureHz > 0 ? current.captureHz : nativePatched ? 0 : 60),
      });
    const service = new SimulatorService({
      simctl,
      exec,
      streams,
      kv: bb.storage.kv,
      log: bb.log,
      publish: (channel, payload) => { syncRecorders(); bb.realtime.publish(channel, payload); },
      idleShutdownMs: async () => current.idleShutdownMinutes * 60_000,
      screenshotMaxDimension: async () => current.screenshotMaxDimension,
      deviceAvailableTo: (threadId, udid) => { const owner = controls.state(udid); return !owner || owner.threadId === threadId; },
    });
    const replay = dependencies.replay ?? new ReplayRecorder();
    const panelInputs = new Map<string, Set<() => void>>();
    const controls = new ControlLeases((udid, control) => {
      for (const release of panelInputs.get(udid) ?? []) release();
      replay.record(udid, {
        kind: "control", actor: "system", label: control ? `${control.mode === "human" ? "Human" : "Agent"} took control` : "Control released",
        ...(control ? { threadId: control.threadId } : {}),
      });
      bb.realtime.publish("control-changed", { udid, control });
    });
    const recordedDevices = new Set<string>();
    const endedThreads = new Set<string>();
    async function attachThread(threadId: string, device: string | null | undefined, options: Parameters<SimulatorService["attach"]>[2]) {
      if (endedThreads.has(threadId)) throw new SimulatorError("This thread is archived or deleted.");
      const result = await service.attach(threadId, device, options);
      if (endedThreads.has(threadId)) {
        await service.detach(threadId, result.device.udid, { shutdown: result.booted });
        throw new SimulatorError("The thread closed while its simulator was attaching.");
      }
      return result;
    }
    function syncRecorders() {
      const live = new Set(service.sessions().map((session) => session.udid));
      for (const udid of live) {
        if (!recordedDevices.has(udid)) {
          recordedDevices.add(udid);
          replay.ensure(udid, streams.helperUrl(udid, "/stream.avcc"), streams.helperUrl(udid, "/config"));
        }
      }
      for (const udid of recordedDevices) {
        if (!live.has(udid)) { replay.stop(udid); recordedDevices.delete(udid); }
      }
    }
    function assertAttached(threadId: string, udid: string) {
      if (!service.attachedTo(threadId).includes(udid)) throw new SimulatorError("Attach this simulator to this thread first.");
    }
    function event(udid: string, actor: "human" | "agent", threadId: string, label: string, kind: TimelineEvent["kind"] = "input") {
      replay.record(udid, { actor, threadId, label, kind });
    }
    async function human<T>(threadId: string, udid: string, label: string, work: (signal: AbortSignal) => Promise<T>) {
      assertAttached(threadId, udid);
      const operation = controls.begin(udid, threadId, "human");
      try { const result = await work(operation.signal); operation.signal.throwIfAborted(); event(udid, "human", threadId, label); return result; }
      catch (error) { event(udid, "human", threadId, `${label}: ${describe(error)}`, "error"); throw error; }
      finally { operation.release(); }
    }
    registerAndroid(bb, { agentControl: () => normalizeAgentControl(current.agentControl) });
    registerDeviceBezels(bb, { exec, simctl });

    async function readiness(): Promise<SimulatorState["ready"]> {
      const problems: string[] = [];
      const xcode = await simctl.xcodePath();
      if (!xcode) {
        problems.push(
          "Xcode was not found. Install it from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app`.",
        );
      }
      const node = resolveNodeCommand({ override: current.nodePath });
      const entry = resolveServeSimEntry({ override: current.serveSimPath });
      if (!entry) {
        problems.push(
          "serve-sim is missing. Run `npm install` in the iOS Simulator plugin directory, or set its path in the plugin settings.",
        );
      }
      if (entry?.kind === "script" && !node) {
        problems.push(
          "Node.js 20 or newer was not found on PATH. Install it, or set its path in the plugin settings.",
        );
      }
      return {
        ok: problems.length === 0,
        problems,
        xcode,
        node: node?.command ?? null,
        serveSim: entry?.path ?? null,
      };
    }

    // ----- RPC: the panel's data plane -----------------------------------
    bb.rpc.register(rpcContract, {
      async state({ threadId }) {
        await service.ready();
        const ready = await readiness();
        let devices: SimDevice[] = [];
        let error: string | null = null;
        if (ready.xcode) {
          try {
            devices = await service.devices();
          } catch (cause) {
            error = describe(cause);
          }
        }
        const sessionUdids = new Set(service.sessions().map((session) => session.udid));
        const inputShadowed: string[] = [];
        for (const udid of sessionUdids) {
          if (await service.inputShadowed(udid).catch(() => false)) inputShadowed.push(udid);
        }
        return {
          ready,
          devices,
          sessions: service
            .sessions()
            .map(({ udid, port, startedAt }) => ({ udid, port, startedAt })),
          attached: threadId
            ? service.attachedTo(threadId).filter((udid) => sessionUdids.has(udid))
            : [],
          bootedByPlugin: service.bootedDevices(),
          consent: await service.consent(),
          controls: Object.fromEntries([...sessionUdids].flatMap((udid) => {
            const state = controls.state(udid); return state ? [[udid, state]] : [];
          })),
          replay: Object.fromEntries([...sessionUdids].map((udid) => [udid, replay.status(udid, threadId ?? "")])),
          inputShadowed,
          agentControl: normalizeAgentControl(current.agentControl),
          error,
        };
      },
      async attach({ threadId, device }) {
        const result = await attachThread(threadId, device, { allowDefault: true, select: true });
        controls.ensure(result.device.udid, threadId, "human");
        return {
          udid: result.device.udid,
          port: result.session.port,
          name: result.device.name,
        };
      },
      async detach({ threadId, udid, shutdown }) {
        const operation = shutdown ? controls.begin(udid, threadId, "human") : null;
        try {
          await service.detach(threadId, udid, { shutdown, signal: operation?.signal });
          operation?.signal.throwIfAborted();
        } finally {
          if (!service.attachedTo(threadId).includes(udid)) controls.release(udid, threadId);
          operation?.release();
        }
        return { ok: true as const };
      },
      async button({ threadId, udid, button }) {
        await human(threadId, udid, `Pressed ${button}`, (signal) => service.pressButton(udid, button, signal));
        return { ok: true as const };
      },
      async rotate({ threadId, udid, orientation }) {
        await human(threadId, udid, `Rotated to ${orientation}`, (signal) => service.rotate(udid, orientation, signal));
        return { ok: true as const };
      },
      async openUrl({ threadId, udid, url }) {
        await human(threadId, udid, "Opened URL", (signal) => service.openUrl(udid, url, signal));
        return { ok: true as const };
      },
      async repairInput({ threadId, udid }) {
        return human(threadId, udid, "Repaired input", (signal) => service.repairInput(udid, signal));
      },
      async pasteText({ threadId, udid, text }) {
        if (!streams.get(udid)) throw new SimulatorError("Attach the simulator before pasting.");
        if (await service.inputShadowed(udid)) throw new SimulatorError("Device Hub captures input. Close its device window and repair input before pasting.");
        await human(threadId, udid, `Pasted ${text.length} characters`, (signal) => service.pasteText(udid, text, signal));
        return { ok: true as const };
      },
      async control({ threadId, udid, mode }) {
        await service.ready();
        assertAttached(threadId, udid);
        if (mode === "agent" && normalizeAgentControl(current.agentControl) === "never") {
          throw new SimulatorError("Agent control is turned off in the plugin settings.");
        }
        // This explicit human action grants permission as well as the lease.
        const grant = mode === "agent" ? service.setConsent(udid, true) : null;
        const next = controls.set(udid, threadId, mode);
        await grant;
        return controls.state(udid) ?? next;
      },
      async saveReplay({ threadId, udid }) {
        assertAttached(threadId, udid);
        const clip = replay.save(udid, threadId);
        bb.realtime.publish("replay-changed", { udid });
        return clip;
      },
      async timeline({ threadId, udid }) {
        assertAttached(threadId, udid);
        return replay.events(udid).filter((entry) => !entry.threadId || entry.threadId === threadId).slice(-200);
      },
      async replayState({ threadId, udid }) {
        assertAttached(threadId, udid);
        return replay.status(udid, threadId);
      },
    });

    // ----- HTTP: the live stream, screenshots, and the input relay --------
    bb.http.route("GET", "/stream", async (c) => {
      const udid = c.req.query("udid") ?? "";
      if (!streams.get(udid)) {
        return c.json({ error: `No stream is running for ${udid || "(missing udid)"}.` }, 404);
      }
      const upstream = await fetch(streams.helperUrl(udid, "/stream.mjpeg"), {
        signal: c.req.raw.signal,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type":
            upstream.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=frame",
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no",
        },
      });
    });

    // Hardware H.264 (AVCC records, see lib/avcc.ts): the panel's preferred
    // stream. MJPEG above stays as the fallback for clients without WebCodecs.
    bb.http.route("GET", "/video", async (c) => {
      const udid = c.req.query("udid") ?? "";
      if (!streams.get(udid)) {
        return c.json({ error: `No stream is running for ${udid || "(missing udid)"}.` }, 404);
      }
      const upstream = await fetch(streams.helperUrl(udid, "/stream.avcc"), {
        signal: c.req.raw.signal,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no",
        },
      });
    });

    bb.http.route("GET", "/screenshot", async (c) => {
      const udid = c.req.query("udid") ?? "";
      if (udid === "") return c.json({ error: "udid is required" }, 400);
      try {
        const png = await service.screenshotPng(udid, c.req.raw.signal);
        const headers: Record<string, string> = {
          "content-type": "image/png",
          "cache-control": "no-store",
        };
        if (c.req.query("download") === "1") {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          headers["content-disposition"] = `attachment; filename="simulator-${stamp}.png"`;
        }
        return new Response(new Uint8Array(png) as unknown as BodyInit, { headers });
      } catch (error) {
        return c.json({ error: describe(error) }, 500);
      }
    });

    bb.http.route("GET", "/replay", async (c) => {
      const udid = c.req.query("udid") ?? "";
      const threadId = c.req.query("threadId") ?? "";
      const id = c.req.query("id") ?? "";
      if (!service.attachedTo(threadId).includes(udid)) return c.json({ error: "Simulator is not attached to this thread." }, 403);
      const clip = replay.clip(udid, id, threadId);
      if (!clip) return c.json({ error: "Replay expired or belongs to another thread." }, 404);
      const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
      if (c.req.query("download") === "1") headers["content-disposition"] = `attachment; filename="simulator-replay-${clip.createdAt}.json"`;
      return new Response(JSON.stringify(clip), { headers });
    });

    bb.http.experimental_websocket("/hid", ({ url }) => {
      const udid = url.searchParams.get("udid") ?? "";
      const threadId = url.searchParams.get("threadId") ?? "";
      let upstream: Awaited<ReturnType<StreamManager["openHid"]>> | null = null;
      let closed = false;
      let invalidate = () => {};
      let touching: { x: number; y: number } | null = null;
      const keys = new Set<number>();
      const releaseInput = () => {
        if (touching) { try { upstream?.send(HID.TOUCH, { type: "end", ...touching }); } catch {} touching = null; }
        for (const usage of keys) { try { upstream?.send(HID.KEY, { type: "up", usage }); } catch {} }
        keys.clear();
      };
      return {
        async onOpen(socket) {
          invalidate = () => {
            closed = true;
            releaseInput();
            panelInputs.get(udid)?.delete(invalidate);
            upstream?.close();
            socket.close(1000, "Control changed");
          };
          const releases = panelInputs.get(udid) ?? new Set<() => void>();
          releases.add(invalidate);
          panelInputs.set(udid, releases);
          try {
            const connection = await streams.openHid(udid);
            if (closed) {
              connection.close();
              return;
            }
            upstream = connection;
            connection.onMessage((data) => {
              const message = decodeHid(data);
              const config = message && screenConfigFrom(message.payload);
              if (config) replay.setConfig(udid, config);
              socket.send(data);
            });
            connection.onClose(() => socket.close(1011, "simulator input socket closed"));
          } catch (error) {
            closed = true;
            panelInputs.get(udid)?.delete(invalidate);
            upstream?.close();
            socket.close(1011, describe(error).slice(0, 120));
          }
        },
        onMessage(socket, data) {
          if (closed) return;
          const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
          if (upstream) {
            try {
              assertAttached(threadId, udid);
              controls.assert(udid, threadId, "human");
              const message = decodeHid(bytes);
              if (!message) return;
              const payload = message.payload as Record<string, unknown> | null;
              if (message.opcode === HID.TOUCH && payload && typeof payload.x === "number" && typeof payload.y === "number") {
                touching = payload.type === "end" ? null : { x: payload.x, y: payload.y };
                if (payload.type === "begin" || payload.type === "end") event(udid, "human", threadId, `${payload.type === "begin" ? "Touch" : "Release"} (${payload.x.toFixed(2)}, ${payload.y.toFixed(2)})`);
              } else if (message.opcode === HID.KEY && payload && typeof payload.usage === "number") {
                if (payload.type === "down") keys.add(payload.usage); else keys.delete(payload.usage);
                if (payload.type === "down") event(udid, "human", threadId, "Key pressed");
              } else if (message.opcode === HID.BUTTON) event(udid, "human", threadId, "Hardware button");
              upstream.sendRaw(bytes);
            }
            catch (error) { socket.close(1011, describe(error).slice(0, 120)); }
          }
        },
        onClose() {
          closed = true;
          releaseInput();
          panelInputs.get(udid)?.delete(invalidate);
          upstream?.close();
        },
        onError() {
          closed = true;
          releaseInput();
          panelInputs.get(udid)?.delete(invalidate);
          upstream?.close();
        },
      };
    });

    // ----- Agent tools ----------------------------------------------------
    async function ensureConsent(
      threadId: string,
      device: SimDevice,
      signal?: AbortSignal,
    ): Promise<void> {
      const mode = normalizeAgentControl(current.agentControl);
      if (mode === "always") return;
      if (mode === "never") {
        throw new SimulatorError(
          "Agent control of simulators is turned off in the iOS Simulator plugin settings. The user can still tap through the panel; ask them to.",
        );
      }
      const consent = await service.consent();
      if (consent[device.udid] === true) return;
      if (consent[device.udid] === false) {
        throw new SimulatorError(
          `The user declined agent control of ${device.name}. Ask them to tap through the simulator panel, or to allow agent control from the panel.`,
        );
      }
      const answer = await bb.ui.requestInput(
        {
          threadId,
          rendererId: "device-consent",
          title: `Allow the agent to control ${device.name}`,
          payload: { udid: device.udid, name: device.name, runtime: device.runtime },
        },
        { signal },
      );
      signal?.throwIfAborted();
      if (answer.outcome !== "submitted") throw new SimulatorError("Simulator control request was cancelled. Consent has not changed.");
      const allowed =
        answer.outcome === "submitted" &&
        typeof answer.value === "object" &&
        answer.value !== null &&
        (answer.value as { allow?: unknown }).allow === true;
      await service.setConsent(device.udid, allowed);
      if (!allowed) {
        throw new SimulatorError(
          `The user declined agent control of ${device.name}. Ask them to tap through the simulator panel instead.`,
        );
      }
    }

    interface ToolCtx {
      threadId: string;
      signal: AbortSignal;
    }

    async function withDevice(
      ctx: ToolCtx,
      query: string | undefined,
      options: { allowDefault?: boolean; select?: boolean; consent?: boolean; input?: boolean; action?: string },
      work: (device: SimDevice, booted: boolean, signal: AbortSignal) => Promise<ToolResult>,
    ): Promise<ToolResult> {
      try {
        const { device, booted } = await attachThread(ctx.threadId, query, {
          allowDefault: options.allowDefault ?? false,
          select: options.select,
          signal: ctx.signal,
        });
        controls.ensure(device.udid, ctx.threadId, "agent");
        const operation = options.input || options.action ? controls.beginAgent(device.udid, ctx.threadId, ctx.signal) : null;
        const signal = operation?.signal ?? ctx.signal;
        try {
          if (options.consent !== false) await ensureConsent(ctx.threadId, device, signal);
          if (options.input && (await service.inputShadowed(device.udid, signal))) {
            throw new SimulatorError(
              `Xcode's Device Hub has captured input on ${device.name}, so taps and keys would be ignored. Call ios_sim_repair_input (it restarts SpringBoard and closes running apps, so relaunch the app afterwards), or ask the user to close the device's window in Device Hub.`,
            );
          }
          signal.throwIfAborted();
          service.agentActivity(device.udid, true);
          try {
            if (options.input || options.action) event(device.udid, "agent", ctx.threadId, options.action ?? "Input");
            return await work(device, booted, signal);
          } catch (error) {
            event(device.udid, "agent", ctx.threadId, describe(error), "error");
            throw error;
          } finally {
            service.agentActivity(device.udid, false);
          }
        } finally { operation?.release(); }
      } catch (error) {
        return toolError(error);
      }
    }

    const deviceParam = z
      .string()
      .min(1)
      .optional()
      .describe(
        "Simulator name or udid. Defaults to the simulator attached to this thread.",
      );
    const coordinate = z.number().min(0).max(1);

    bb.agents.registerTool({
      name: "ios_sim_list_devices",
      description:
        "List the iOS simulators Xcode provides with their runtime, state (Booted or Shutdown), udid, and which one is attached to this thread.",
      presentation: { label: { pending: "Listing simulators", completed: "Listed simulators" } },
      parameters: z.object({}),
      async execute(_params, ctx) {
        try {
          const devices = await service.devices(ctx.signal);
          const attached = new Set(service.attachedTo(ctx.threadId));
          const available = devices.filter((device) => device.isAvailable);
          if (available.length === 0) {
            return "Xcode lists no available simulators. Install the iOS platform from Xcode → Settings → Components or run `xcodebuild -downloadPlatform iOS`.";
          }
          return [
            "Simulators (* = attached to this thread):",
            ...available.map((device) => deviceLine(device, attached)),
          ].join("\n");
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_attach",
      description:
        "Boot an iOS simulator if needed, start streaming it into the iOS Simulator panel beside this thread, and make it this thread's device. Call it before building when the task is about running, seeing, or testing an iOS app.",
      instructions:
        "When the user wants to run, see, or test an iOS app, use the ios_sim_* tools: ios_sim_attach first, build with xcodebuild for `-destination 'platform=iOS Simulator,id=<udid>'`, then ios_sim_install_and_launch, then ios_sim_screenshot or ios_sim_describe_ui to verify what you built. The user watches the same device live. Take control / Let agent drive in the panel hands the device between human and agent; respect human control and other threads' ownership. Use ios_sim_session for recent input/app diagnostics and ios_sim_save_replay to capture the available last 30 seconds.",
      presentation: { label: { pending: "Attaching simulator", completed: "Attached simulator" } },
      parameters: z.object({ device: deviceParam }),
      async execute({ device }, ctx) {
        return withDevice(ctx, device, { allowDefault: true, select: true, consent: false }, async (dev, booted, signal) => {
          const config = await streams.screenConfig(dev.udid).catch(() => null);
          const shadowed = await service.inputShadowed(dev.udid, signal).catch(() => false);
          const controller = controls.state(dev.udid);
          return [
            shadowed
              ? "Note: Xcode's Device Hub currently captures this device's input; taps will be ignored until ios_sim_repair_input runs (that closes running apps) or the user closes the device window in Device Hub."
              : "",
            `${booted ? "Booted and attached" : "Attached"} ${dev.name} (${dev.runtime}) — udid ${dev.udid}. The iOS Simulator panel shows it live.`,
            controller && (controller.threadId !== ctx.threadId || controller.mode !== "agent")
              ? "Observation only: another thread or the human controls this device. Respect the handoff; the user can return agent control in the panel." : "Agent control is assigned to this thread.",
            config
              ? `Screen: ${config.width}x${config.height} points, ${config.orientation ?? "portrait"}.`
              : "",
            `Build with: xcodebuild -scheme <Scheme> -destination 'platform=iOS Simulator,id=${dev.udid}' -derivedDataPath build build`,
            "Then: ios_sim_install_and_launch with the .app path.",
          ]
            .filter(Boolean)
            .join("\n");
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_screenshot",
      description:
        "Capture the attached simulator's screen as an image. Use it after launching the app and after every UI change to verify the result.",
      presentation: { label: { pending: "Taking a screenshot", completed: "Took a screenshot" } },
      parameters: z.object({ device: deviceParam }),
      async execute({ device }, ctx) {
        return withDevice(ctx, device, {}, async (dev, _booted, signal) => {
          const shot = await service.screenshot(dev.udid, signal);
          const config = await streams.screenConfig(dev.udid).catch(() => null);
          return {
            content: [
              { type: "image", data: shot.data, mimeType: shot.mimeType },
              {
                type: "text",
                text: `Screenshot of ${dev.name}${config ? ` (${config.width}x${config.height} points, ${config.orientation ?? "portrait"})` : ""}. Coordinates for ios_sim_tap are normalized 0..1 across this image.`,
              },
            ],
          };
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_describe_ui",
      description:
        "List the accessibility elements on the attached simulator's screen: role, label, value, frame, and the normalized center to pass to ios_sim_tap. Prefer this over guessing coordinates.",
      presentation: { label: { pending: "Reading the screen", completed: "Read the screen" } },
      parameters: z.object({
        device: deviceParam,
        filter: z
          .string()
          .optional()
          .describe("Only elements whose label, value, role, or id contains this text."),
        limit: z.number().int().min(1).max(500).optional().describe("Max elements (default 120)."),
      }),
      async execute({ device, filter, limit }, ctx) {
        return withDevice(ctx, device, {}, (dev, _booted, signal) =>
          service.describeUi(dev.udid, { filter, limit, signal }),
        );
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_tap",
      description:
        "Tap the attached simulator. Give either `element` (an accessibility label, value, or id from ios_sim_describe_ui) or normalized `x`/`y` in 0..1. Set holdMs for a long press.",
      presentation: { label: { pending: "Tapping", completed: "Tapped" } },
      parameters: z.object({
        device: deviceParam,
        element: z.string().min(1).optional(),
        x: coordinate.optional(),
        y: coordinate.optional(),
        holdMs: z.number().int().min(20).max(5000).optional(),
      }),
      async execute({ device, element, x, y, holdMs }, ctx) {
        return withDevice(ctx, device, { input: true, action: "Tap" }, async (dev, _booted, signal) => {
          if (element) {
            const snapshot = await service.accessibility(dev.udid, signal);
            const match = findElement(snapshot, element);
            if (!match) {
              const labels = snapshot.elements
                .map((entry) => entry.label || entry.value)
                .filter(Boolean)
                .slice(0, 15);
              throw new SimulatorError(
                `No element matches "${element}". Visible labels: ${labels.join(", ") || "(none; try ios_sim_screenshot)"}.`,
              );
            }
            const center = centerNormalized(match, snapshot.screen);
            await service.tap(dev.udid, center.x, center.y, holdMs, signal);
            return `Tapped "${match.label || match.value || match.id}" (${match.role || match.type}) at (${center.x.toFixed(3)}, ${center.y.toFixed(3)}).`;
          }
          if (x === undefined || y === undefined) {
            throw new SimulatorError("Pass either `element` or both `x` and `y` (normalized 0..1).");
          }
          await service.tap(dev.udid, clamp01(x), clamp01(y), holdMs, signal);
          return `Tapped (${x.toFixed(3)}, ${y.toFixed(3)}).`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_swipe",
      description:
        "Swipe or scroll on the attached simulator. Give a `direction` (the content moves that way from the screen center) or explicit normalized from/to points.",
      presentation: { label: { pending: "Swiping", completed: "Swiped" } },
      parameters: z.object({
        device: deviceParam,
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        fromX: coordinate.optional(),
        fromY: coordinate.optional(),
        toX: coordinate.optional(),
        toY: coordinate.optional(),
        durationMs: z.number().int().min(50).max(5000).optional(),
      }),
      async execute({ device, direction, fromX, fromY, toX, toY, durationMs }, ctx) {
        return withDevice(ctx, device, { input: true, action: "Swipe" }, async (dev, _booted, signal) => {
          let from = { x: fromX ?? NaN, y: fromY ?? NaN };
          let to = { x: toX ?? NaN, y: toY ?? NaN };
          if (direction) {
            const presets = {
              up: [{ x: 0.5, y: 0.72 }, { x: 0.5, y: 0.28 }],
              down: [{ x: 0.5, y: 0.28 }, { x: 0.5, y: 0.72 }],
              left: [{ x: 0.85, y: 0.5 }, { x: 0.15, y: 0.5 }],
              right: [{ x: 0.15, y: 0.5 }, { x: 0.85, y: 0.5 }],
            } as const;
            [from, to] = presets[direction];
          }
          if ([from.x, from.y, to.x, to.y].some((value) => Number.isNaN(value))) {
            throw new SimulatorError("Pass a `direction` or all of fromX, fromY, toX, toY.");
          }
          await service.swipe(dev.udid, from, to, durationMs, signal);
          return `Swiped from (${from.x.toFixed(2)}, ${from.y.toFixed(2)}) to (${to.x.toFixed(2)}, ${to.y.toFixed(2)}).`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_type",
      description:
        "Type into the focused field using the simulator pasteboard (supports Unicode; \\n presses Return and \\t presses Tab). Tap the field first. Set method to keys for US-keyboard ASCII events when an app blocks paste.",
      presentation: { label: { pending: "Typing", completed: "Typed" } },
      parameters: z.object({ device: deviceParam, text: z.string().min(1).max(4000), method: z.enum(["paste", "keys"]).optional() }),
      async execute({ device, text, method }, ctx) {
        return withDevice(ctx, device, { input: true, action: `Typed ${text.length} characters` }, async (dev, _booted, signal) => {
          await service.typeText(dev.udid, text, method, signal);
          return `Typed ${text.length} character${text.length === 1 ? "" : "s"}.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_paste",
      description: "Paste literal text, including Unicode and line breaks, into the focused simulator field. Tap the field first. Uses the guest pasteboard and Command-V without opening Device Hub.",
      presentation: { label: { pending: "Pasting text", completed: "Pasted text" } },
      parameters: z.object({ device: deviceParam, text: z.string().min(1).max(65536) }),
      async execute({ device, text }, ctx) {
        return withDevice(ctx, device, { input: true, action: `Pasted ${text.length} characters` }, async (dev, _booted, signal) => {
          await service.pasteText(dev.udid, text, signal);
          return `Pasted ${text.length} characters. Use ios_sim_screenshot to verify the field.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_press_button",
      description:
        "Press a hardware button on the attached simulator: home, lock (power), volume-up, volume-down, action, or side-button.",
      presentation: { label: { pending: "Pressing a button", completed: "Pressed a button" } },
      parameters: z.object({ device: deviceParam, button: buttonEnum }),
      async execute({ device, button }, ctx) {
        return withDevice(ctx, device, { input: true, action: `Pressed ${button}` }, async (dev, _booted, signal) => {
          await service.pressButton(dev.udid, button, signal);
          return `Pressed ${button}.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_rotate",
      description: "Rotate the attached simulator to portrait, portrait_upside_down, landscape_left, or landscape_right.",
      presentation: { label: { pending: "Rotating", completed: "Rotated" } },
      parameters: z.object({ device: deviceParam, orientation: orientationEnum }),
      async execute({ device, orientation }, ctx) {
        return withDevice(ctx, device, { action: "Rotate" }, async (dev, _booted, signal) => {
          await service.rotate(dev.udid, orientation, signal);
          return `Rotated to ${orientation}.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_install_and_launch",
      description:
        "Install a built .app bundle on the attached simulator and launch it (relaunching if it is already running). Reads the bundle id from the app's Info.plist when omitted.",
      presentation: { label: { pending: "Installing and launching", completed: "Installed and launched" } },
      parameters: z.object({
        device: deviceParam,
        appPath: z.string().min(1).describe("Absolute path to the .app bundle built for the simulator."),
        bundleId: z.string().min(1).optional(),
        launchArgs: z.array(z.string()).optional(),
      }),
      async execute({ device, appPath, bundleId, launchArgs }, ctx) {
        return withDevice(ctx, device, { action: "Install and launch app" }, async (dev, _booted, signal) => {
          const result = await service.installAndLaunch(dev.udid, appPath, {
            bundleId,
            launchArgs,
            signal,
          });
          replay.watchApp(dev.udid, result.bundleId, result.output);
          return `Installed and launched ${result.bundleId} on ${dev.name}${result.output ? ` (${result.output})` : ""}. Take ios_sim_screenshot to verify.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_launch",
      description: "Launch (or relaunch) an installed app on the attached simulator by bundle id.",
      presentation: { label: { pending: "Launching app", completed: "Launched app" } },
      parameters: z.object({
        device: deviceParam,
        bundleId: z.string().min(1),
        launchArgs: z.array(z.string()).optional(),
        terminateFirst: z.boolean().optional().describe("Default true: quit a running instance first."),
      }),
      async execute({ device, bundleId, launchArgs, terminateFirst }, ctx) {
        return withDevice(ctx, device, { action: "Launch app" }, async (dev, _booted, signal) => {
          const output = await service.launch(dev.udid, bundleId, {
            launchArgs,
            terminateFirst,
            signal,
          });
          replay.watchApp(dev.udid, bundleId, output);
          return `Launched ${bundleId}${output ? ` (${output})` : ""}.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_open_url",
      description: "Open a URL on the attached simulator: a deep link into your app or a web page in Safari.",
      presentation: { label: { pending: "Opening URL", completed: "Opened URL" } },
      parameters: z.object({ device: deviceParam, url: z.string().min(1) }),
      async execute({ device, url }, ctx) {
        return withDevice(ctx, device, { action: "Open URL" }, async (dev, _booted, signal) => {
          await service.openUrl(dev.udid, url, signal);
          return `Opened ${url}.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_set_appearance",
      description: "Switch the attached simulator between light and dark appearance.",
      presentation: { label: { pending: "Setting appearance", completed: "Set appearance" } },
      parameters: z.object({ device: deviceParam, appearance: z.enum(["light", "dark"]) }),
      async execute({ device, appearance }, ctx) {
        return withDevice(ctx, device, { action: "Set appearance" }, async (dev, _booted, signal) => {
          await service.setAppearance(dev.udid, appearance, signal);
          return `Appearance set to ${appearance}.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_repair_input",
      description:
        "Take simulator input back from Xcode 27's Device Hub when taps and keys are being ignored. Restarts SpringBoard and closes running apps on the device, so relaunch the app afterwards. Only needed when another tool reports input is captured.",
      presentation: { label: { pending: "Repairing simulator input", completed: "Repaired simulator input" } },
      parameters: z.object({ device: deviceParam }),
      async execute({ device }, ctx) {
        return withDevice(ctx, device, { action: "Repair input" }, async (dev, _booted, signal) => {
          const { repaired } = await service.repairInput(dev.udid, signal);
          return repaired
            ? `Input repaired on ${dev.name}. SpringBoard restarted and running apps were closed; relaunch the app, then continue.`
            : `Input on ${dev.name} was not captured by Device Hub; nothing to repair.`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_session",
      description: "Read who controls this simulator, replay buffer health, saved replay metadata, and recent input/app diagnostics. Does not take control from a human or another thread.",
      parameters: z.object({ device: deviceParam }),
      async execute({ device }, ctx) {
        return withDevice(ctx, device, { consent: false }, async (dev) => JSON.stringify({
          control: controls.state(dev.udid), replay: replay.status(dev.udid, ctx.threadId),
          events: replay.events(dev.udid).filter((entry) => !entry.threadId || entry.threadId === ctx.threadId).slice(-100),
        }));
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_save_replay",
      description: "Save the last 30 seconds of the attached iOS video and synchronized input/app diagnostics. The replay stays in bounded memory until detach/reload; view or download it in the Simulator panel.",
      parameters: z.object({ device: deviceParam }),
      async execute({ device }, ctx) {
        return withDevice(ctx, device, { consent: false }, async (dev) => {
          const clip = replay.save(dev.udid, ctx.threadId);
          bb.realtime.publish("replay-changed", { udid: dev.udid });
          return `Replay saved. Open Replay in the Simulator panel to view or download it. ${JSON.stringify(clip)}`;
        });
      },
    });

    bb.agents.registerTool({
      name: "ios_sim_detach",
      description:
        "Stop streaming this thread's simulator. Set shutdown to also power the device off. Leave devices attached unless the user asks otherwise.",
      presentation: { label: { pending: "Detaching simulator", completed: "Detached simulator" } },
      parameters: z.object({ device: deviceParam, shutdown: z.boolean().optional() }),
      async execute({ device, shutdown }, ctx) {
        try {
          const dev = await service.resolveDevice(ctx.threadId, device, { signal: ctx.signal });
          const operation = shutdown || controls.state(dev.udid)?.threadId === ctx.threadId
            ? controls.beginAgent(dev.udid, ctx.threadId, ctx.signal) : null;
          try {
            if (shutdown) await ensureConsent(ctx.threadId, dev, operation!.signal);
            operation?.signal.throwIfAborted();
            await service.detach(ctx.threadId, dev.udid, { shutdown: shutdown ?? false, signal: operation?.signal ?? ctx.signal });
            operation?.signal.throwIfAborted();
          } finally {
            if (!service.attachedTo(ctx.threadId).includes(dev.udid)) controls.release(dev.udid, ctx.threadId);
            operation?.release();
          }
          return `${shutdown ? "Shut down" : "Detached"} ${dev.name}.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    // ----- Thread lifecycle -----------------------------------------------
    const release = (threadId: string) => {
      endedThreads.add(threadId);
      controls.releaseThread(threadId);
      service.releaseThread(threadId).catch((error) => {
        bb.log.warn(`releasing simulators for ${threadId} failed: ${describe(error)}`);
      });
    };
    bb.events.on("thread.archived", ({ thread }) => release(thread.id));
    bb.events.on("thread.deleted", ({ thread }) => release(thread.id));
    bb.events.on("thread.unarchived", ({ thread }) => { endedThreads.delete(thread.id); });

    // ----- CLI ------------------------------------------------------------
    const threadOption = {
      type: "string",
      description: "Thread id; defaults to the thread running the command",
    } as const;
    const jsonOption = { type: "boolean", description: "Machine-readable JSON output" } as const;
    bb.cli.register(
      defineCli({
        name: "ios-simulator",
        summary: "List, attach, and release iOS simulators for BB threads",
        commands: {
          session: cliCommand({
            summary: "Read device control, replay status, and recent diagnostics as JSON",
            positionals: [{ name: "device", description: "Simulator name or udid; defaults to this thread’s device", required: false }],
            options: { thread: threadOption },
            async run(input, ctx) {
              const threadId = input.options.thread ?? ctx.threadId;
              if (!threadId) throw new PluginCliError("Pass --thread <thread id>.");
              const device = await service.resolveDevice(threadId, input.positionals.device, { signal: ctx.signal });
              assertAttached(threadId, device.udid);
              return { exitCode: 0, stdout: JSON.stringify({
                control: controls.state(device.udid), replay: replay.status(device.udid, threadId),
                events: replay.events(device.udid).filter((entry) => !entry.threadId || entry.threadId === threadId).slice(-100),
              }) };
            },
          }),
          replay: cliCommand({
            summary: "Save the last 30 seconds for playback in the Simulator panel",
            positionals: [{ name: "device", description: "Simulator name or udid; defaults to this thread’s device", required: false }],
            options: { thread: threadOption },
            async run(input, ctx) {
              const threadId = input.options.thread ?? ctx.threadId;
              if (!threadId) throw new PluginCliError("Pass --thread <thread id>.");
              const device = await service.resolveDevice(threadId, input.positionals.device, { signal: ctx.signal });
              assertAttached(threadId, device.udid);
              const clip = replay.save(device.udid, threadId);
              bb.realtime.publish("replay-changed", { udid: device.udid });
              return { exitCode: 0, stdout: JSON.stringify(clip) };
            },
          }),
          devices: cliCommand({
            summary: "List simulators with runtime, state, and udid",
            options: { json: jsonOption },
            async run(input, ctx) {
              const devices = (await service.devices(ctx.signal)).filter((device) => device.isAvailable);
              const attached = new Set(ctx.threadId ? service.attachedTo(ctx.threadId) : []);
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(devices)
                  : devices.map((device) => deviceLine(device, attached)).join("\n") || "No simulators.",
              };
            },
          }),
          attach: cliCommand({
            summary: "Boot a simulator if needed, stream it, and attach it to a thread",
            positionals: [
              {
                name: "device",
                description: "Simulator name or udid; defaults to a booted simulator or the newest iPhone",
                required: false,
              },
            ],
            options: { thread: threadOption, json: jsonOption },
            async run(input, ctx) {
              const threadId = input.options.thread ?? ctx.threadId;
              if (!threadId) {
                throw new PluginCliError("No thread to attach the simulator to.", {
                  code: "missing_thread",
                  hint: "Pass --thread <thread id>.",
                });
              }
              const result = await attachThread(threadId, input.positionals.device ?? null, {
                allowDefault: true,
                select: true,
                signal: ctx.signal,
              });
              controls.ensure(result.device.udid, threadId, "agent");
              const summary = { udid: result.device.udid, name: result.device.name, port: result.session.port };
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(summary)
                  : `Attached ${result.device.name} (${result.device.udid}) to ${threadId}.`,
              };
            },
          }),
          "repair-input": cliCommand({
            summary: "Take input back from Xcode 27's Device Hub (restarts SpringBoard, closes apps)",
            positionals: [
              { name: "device", description: "Simulator name or udid; defaults to the attached one", required: false },
            ],
            options: { thread: threadOption },
            async run(input, ctx) {
              const threadId = input.options.thread ?? ctx.threadId;
              if (!threadId) throw new PluginCliError("Attach from a thread before repairing input.");
              const device = await service.resolveDevice(threadId, input.positionals.device ?? null, {
                signal: ctx.signal,
              });
              assertAttached(threadId, device.udid);
              controls.ensure(device.udid, threadId, "agent");
              const operation = controls.beginAgent(device.udid, threadId, ctx.signal);
              let repaired: boolean;
              try {
                await ensureConsent(threadId, device, operation.signal);
                ({ repaired } = await service.repairInput(device.udid, operation.signal));
              }
              finally { operation.release(); }
              return {
                exitCode: 0,
                stdout: repaired
                  ? `Input repaired on ${device.name}; relaunch your app.`
                  : `Input on ${device.name} is not captured by Device Hub.`,
              };
            },
          }),
          "diag-cpu": cliCommand({
            summary: "Diagnostic: top processes by CPU on the server Mac, plus serve-sim and simulator processes",
            hidden: true,
            async run(_input, ctx) {
              const top = await exec("ps", ["-Ao", "pid,ppid,%cpu,%mem,rss,etime,command", "-r"], { timeoutMs: 10_000, signal: ctx.signal });
              const lines = top.stdout.split("\n");
              const header = lines[0] ?? "";
              const interesting = lines.slice(1).filter((line) => /serve-sim|node|SimRender|DeviceHub/i.test(line)).slice(0, 30).map((line) => line.length > 260 ? line.slice(0, 260) + "…" : line);
              const load = await exec("sysctl", ["-n", "vm.loadavg", "hw.ncpu"], { timeoutMs: 5_000, signal: ctx.signal });
              return {
                exitCode: 0,
                stdout: [`load/ncpu: ${load.stdout.trim().replace(/\n/g, " | ")}`, "", "top 12 by CPU:", ...lines.slice(0, 13), "", "simulator-related:", header, ...interesting].join("\n"),
              };
            },
          }),
          "diag-record": cliCommand({
            summary: "Diagnostic: record the simulator with simctl for N seconds and print the file path",
            hidden: true,
            positionals: [
              { name: "device", description: "Simulator name or udid; defaults to the attached one", required: false },
            ],
            options: {
              seconds: { type: "integer", min: 1, max: 30, default: 4, description: "Recording length" },
              out: { type: "string", description: "Output .mov path on the server; defaults to a temp file" },
            },
            async run(input, ctx) {
              const device = await service.resolveDevice(ctx.threadId ?? null, input.positionals.device ?? null, {
                signal: ctx.signal,
              });
              const outPath =
                input.options.out ??
                `${(await import("node:os")).tmpdir()}/bb-ios-sim-${Date.now()}.mov`;
              await simctl.recordVideo(device.udid, outPath, input.options.seconds, ctx.signal);
              return { exitCode: 0, stdout: outPath };
            },
          }),
          detach: cliCommand({
            summary: "Detach a thread's simulator; --shutdown also powers it off",
            positionals: [
              { name: "device", description: "Simulator name or udid; defaults to the attached one", required: false },
            ],
            options: {
              thread: threadOption,
              shutdown: { type: "boolean", description: "Shut the simulator down as well" },
            },
            async run(input, ctx) {
              const threadId = input.options.thread ?? ctx.threadId;
              if (!threadId) {
                throw new PluginCliError("No thread to detach from.", {
                  code: "missing_thread",
                  hint: "Pass --thread <thread id>.",
                });
              }
              const device = await service.resolveDevice(threadId, input.positionals.device ?? null, {
                signal: ctx.signal,
              });
              const operation = input.options.shutdown || controls.state(device.udid)?.threadId === threadId
                ? controls.beginAgent(device.udid, threadId, ctx.signal) : null;
              try {
                if (input.options.shutdown) await ensureConsent(threadId, device, operation?.signal ?? ctx.signal);
                operation?.signal.throwIfAborted();
                await service.detach(threadId, device.udid, {
                  shutdown: input.options.shutdown,
                  signal: operation?.signal ?? ctx.signal,
                });
                operation?.signal.throwIfAborted();
              } finally {
                if (!service.attachedTo(threadId).includes(device.udid)) controls.release(device.udid, threadId);
                operation?.release();
              }
              return {
                exitCode: 0,
                stdout: `${input.options.shutdown ? "Shut down" : "Detached"} ${device.name}.`,
              };
            },
          }),
        },
      }),
    );

    bb.onDispose(async () => {
      controls.dispose();
      replay.dispose();
      await service.dispose();
    });
    bb.log.info("iOS Simulator plugin loaded");
    // Streams die with the previous generation on reload; bring them back for
    // devices threads still hold so open panels do not go dark.
    service.restoreSessions().catch((error) => {
      bb.log.warn(`restoring simulator streams failed: ${describe(error)}`);
    });
  };
}

export default createPlugin();
