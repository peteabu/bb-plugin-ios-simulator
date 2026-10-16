// One serve-sim process per attached simulator. serve-sim captures the
// device's framebuffer and serves it as MJPEG plus a binary HID WebSocket on
// a loopback port; this module owns those processes and the connections to
// them. Everything external (spawn, fetch, ports, binaries) is injectable.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { WebSocket } from "ws";
import {
  HID,
  decodeHid,
  encodeHid,
  screenConfigFrom,
  type ScreenConfig,
} from "../lib/sim-protocol";

export interface NodeCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  source: string;
}

export interface ServeSimEntry {
  kind: "script" | "binary";
  path: string;
  source: string;
}

export interface StreamSession {
  udid: string;
  port: number;
  pid: number | null;
  startedAt: number;
}

export interface HidConnection {
  readonly config: ScreenConfig | null;
  send(opcode: number, payload: unknown): void;
  sendRaw(data: Uint8Array): void;
  onMessage(listener: (data: Uint8Array) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

interface LogLike {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

export interface StreamManagerOptions {
  log: LogLike;
  node: () => NodeCommand | null;
  serveSim: () => ServeSimEntry | null;
  spawn?: SpawnLike;
  fetch?: typeof fetch;
  freePort?: () => Promise<number>;
  webSocket?: typeof WebSocket;
  onChange?: () => void;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Forced-capture rate. serve-sim captures on framebuffer change
   * notifications, which the headless iOS 27 simulator delivers unreliably
   * (stalls of 200 ms and more mid-animation). Its "preferred size" message
   * forces a capture, so a pacer sends it at this rate; unchanged frames are
   * skipped by the seed check upstream of the H.264 encoder. 0 disables.
   */
  captureHz?: () => number;
}

interface InternalSession extends StreamSession {
  child: ChildProcess;
  output: string[];
  exited: boolean;
  ready: Promise<StreamSession>;
  pacer: { stop(): void } | null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function newestVersionDir(root: string): string | null {
  try {
    const versions = readdirSync(root)
      .map((name) => ({ name, parts: name.replace(/^v/, "").split(".").map(Number) }))
      .filter((entry) => entry.parts.every((part) => Number.isFinite(part)))
      .sort((a, b) => {
        for (let index = 0; index < 3; index++) {
          const diff = (b.parts[index] ?? 0) - (a.parts[index] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    return versions[0] ? join(root, versions[0].name) : null;
  } catch {
    return null;
  }
}

/** Find a Node.js the serve-sim child can run under. */
export function resolveNodeCommand(options: {
  override?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  isElectron?: boolean;
  home?: string;
  executable?: (path: string) => boolean;
} = {}): NodeCommand | null {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const isElectron = options.isElectron ?? Boolean(process.versions.electron);
  const home = options.home ?? homedir();
  const executable = options.executable ?? isExecutable;
  const override = options.override?.trim() ?? "";
  if (override !== "") return { command: override, args: [], source: "setting" };

  const dirs = [
    ...(env.PATH ?? "").split(":").filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".volta", "bin"),
    join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
    join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin"),
  ];
  const nvmRoot = newestVersionDir(join(home, ".nvm", "versions", "node"));
  if (nvmRoot) dirs.push(join(nvmRoot, "bin"));
  for (const dir of dirs) {
    const candidate = join(dir, "node");
    if (executable(candidate)) return { command: candidate, args: [], source: dir };
  }
  if (isElectron) {
    return {
      command: execPath,
      args: [],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      source: "electron",
    };
  }
  if (basename(execPath) === "node") return { command: execPath, args: [], source: "execPath" };
  return null;
}

/** Locate serve-sim's CLI entry: a setting override, else the bundled dependency. */
export function resolveServeSimEntry(options: {
  override?: string;
  importMetaUrl?: string;
  exists?: (path: string) => boolean;
} = {}): ServeSimEntry | null {
  const exists = options.exists ?? existsSync;
  const override = options.override?.trim() ?? "";
  if (override !== "") {
    return {
      kind: override.endsWith(".js") || override.endsWith(".mjs") ? "script" : "binary",
      path: override,
      source: "setting",
    };
  }
  try {
    // serve-sim exports only "./middleware" and "./state", so resolve a
    // sibling of the CLI entry rather than package.json.
    const require = createRequire(options.importMetaUrl ?? import.meta.url);
    const middleware = require.resolve("serve-sim/middleware");
    const entry = join(dirname(middleware), "serve-sim.js");
    if (exists(entry)) return { kind: "script", path: entry, source: "dependency" };
  } catch {
    // fall through
  }
  return null;
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("No free port"))));
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class StreamManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly spawnFn: SpawnLike;
  private readonly fetchFn: typeof fetch;
  private readonly freePort: () => Promise<number>;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly healthTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: StreamManagerOptions) {
    this.spawnFn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.fetchFn = options.fetch ?? fetch;
    this.freePort = options.freePort ?? findFreePort;
    this.WebSocketCtor = options.webSocket ?? WebSocket;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 90_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 300;
  }

  list(): StreamSession[] {
    return [...this.sessions.values()]
      .filter((session) => !session.exited)
      .map((session) => this.publicSession(session));
  }

  get(udid: string): StreamSession | null {
    const session = this.sessions.get(udid);
    return session && !session.exited ? this.publicSession(session) : null;
  }

  helperUrl(udid: string, path: string): string {
    const session = this.sessions.get(udid);
    if (!session || session.exited) throw new Error(`No stream is running for ${udid}.`);
    return `http://127.0.0.1:${session.port}/helper/${encodeURIComponent(udid)}${path}`;
  }

  /** Start (or reuse) the stream for a booted device and wait until it serves frames. */
  async ensure(udid: string, signal?: AbortSignal): Promise<StreamSession> {
    const existing = this.sessions.get(udid);
    if (existing && !existing.exited) return existing.ready;

    const node = this.options.node();
    const entry = this.options.serveSim();
    if (!entry) {
      throw new Error(
        "serve-sim is not installed. Run `npm install` in the iOS Simulator plugin directory, or set its path in the plugin settings.",
      );
    }
    if (entry.kind === "script" && !node) {
      throw new Error(
        "Node.js was not found on PATH. Install Node 20 or newer, or set the Node.js path in the iOS Simulator plugin settings.",
      );
    }
    const port = await this.freePort();
    const command = entry.kind === "script" ? node!.command : entry.path;
    const args = [
      ...(entry.kind === "script" ? [...node!.args, entry.path] : []),
      udid,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--panes",
      "none",
      "--quiet",
      "--exit-on-simulator-shutdown",
    ];
    const child = this.spawnFn(command, args, {
      env: { ...process.env, ...(entry.kind === "script" ? node!.env : {}), BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const session: InternalSession = {
      udid,
      port,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      child,
      output: [],
      exited: false,
      ready: Promise.resolve({ udid, port, pid: child.pid ?? null, startedAt: Date.now() }),
      pacer: null,
    };
    const remember = (chunk: unknown) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() === "") continue;
        session.output.push(line);
        if (session.output.length > 40) session.output.shift();
        this.options.log.debug(`[serve-sim ${udid.slice(0, 8)}] ${line}`);
      }
    };
    child.stdout?.on("data", remember);
    child.stderr?.on("data", remember);
    child.on("error", (error) => {
      remember(`spawn error: ${error.message}`);
      this.markExited(session);
    });
    child.on("exit", (code, exitSignal) => {
      remember(`exited (code ${code ?? "null"}, signal ${exitSignal ?? "none"})`);
      this.markExited(session);
    });
    this.sessions.set(udid, session);
    this.options.log.info(`starting serve-sim for ${udid} on port ${port} via ${command}`);
    session.ready = this.waitUntilHealthy(session, signal);
    try {
      const ready = await session.ready;
      session.pacer = this.startPacer(session);
      this.options.onChange?.();
      return ready;
    } catch (error) {
      await this.stop(udid);
      throw error;
    }
  }

  /** Keep a HID socket open and ask for a capture at a steady rate. */
  private startPacer(session: InternalSession): { stop(): void } | null {
    // The rate is re-read on every tick so a settings change (or the patched
    // capture module turning the pacer off) applies without restarting.
    const rate = () => this.options.captureHz?.() ?? 60;
    if (!this.options.captureHz) return null;
    const intervalMs = 8;
    let lastSent = 0;
    let stopped = false;
    let connection: HidConnection | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const hz = rate();
      if (!(hz > 0) || !connection) return;
      const now = Date.now();
      if (now - lastSent < 1000 / hz - 1) return;
      lastSent = now;
      // 0x0 clears any preferred surface so the capture keeps following the
      // largest live framebuffer (it changes on rotation); the message still
      // forces an immediate capture, which is the point.
      connection.send(HID.PREFERRED_SIZE, { width: 0, height: 0 });
    };
    const connect = () => {
      if (stopped || session.exited) return;
      this.openHid(session.udid).then(
        (hid) => {
          if (stopped) {
            hid.close();
            return;
          }
          connection = hid;
          hid.onClose(() => {
            connection = null;
            if (timer) clearInterval(timer);
            timer = null;
            if (!stopped && !session.exited) reconnect = setTimeout(connect, 1_000);
          });
          timer = setInterval(tick, intervalMs);
          timer.unref?.();
        },
        () => {
          if (!stopped && !session.exited) reconnect = setTimeout(connect, 1_000);
        },
      );
    };
    connect();
    return {
      stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        if (reconnect) clearTimeout(reconnect);
        connection?.close();
        connection = null;
      },
    };
  }

  private async waitUntilHealthy(
    session: InternalSession,
    signal?: AbortSignal,
  ): Promise<StreamSession> {
    const deadline = Date.now() + this.healthTimeoutMs;
    const url = `http://127.0.0.1:${session.port}/helper/${encodeURIComponent(session.udid)}/health`;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Cancelled while starting the simulator stream.");
      if (session.exited) {
        throw new Error(
          `serve-sim exited before it could stream ${session.udid}.\n${session.output.slice(-8).join("\n")}`,
        );
      }
      try {
        const response = await this.fetchFn(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return this.publicSession(session);
      } catch {
        // not listening yet
      }
      await sleep(this.pollIntervalMs, signal);
    }
    throw new Error(
      `Timed out waiting for the simulator stream on port ${session.port}.\n${session.output.slice(-8).join("\n")}`,
    );
  }

  private markExited(session: InternalSession): void {
    if (session.exited) return;
    session.exited = true;
    session.pacer?.stop();
    session.pacer = null;
    if (this.sessions.get(session.udid) === session) this.sessions.delete(session.udid);
    this.options.onChange?.();
  }

  async stop(udid: string): Promise<void> {
    const session = this.sessions.get(udid);
    if (!session) return;
    this.sessions.delete(udid);
    session.pacer?.stop();
    session.pacer = null;
    if (session.exited) return;
    this.options.log.info(`stopping serve-sim for ${udid}`);
    await terminate(session.child);
    session.exited = true;
    this.options.onChange?.();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((udid) => this.stop(udid)));
  }

  async fetchHelper(udid: string, path: string, init?: RequestInit): Promise<Response> {
    return this.fetchFn(this.helperUrl(udid, path), init);
  }

  async screenConfig(udid: string): Promise<ScreenConfig | null> {
    const response = await this.fetchHelper(udid, "/config", { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    return screenConfigFrom(await response.json());
  }

  async rawAccessibility(udid: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchHelper(udid, "/ax", { signal: signal ?? AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // keep raw text
      }
      throw new Error(`Accessibility snapshot failed (${response.status}): ${message}`);
    }
    return text;
  }

  /** Open a HID socket to the helper; resolves once the helper accepted it. */
  openHid(udid: string): Promise<HidConnection> {
    const session = this.sessions.get(udid);
    if (!session || session.exited) {
      return Promise.reject(new Error(`No stream is running for ${udid}.`));
    }
    const url = `ws://127.0.0.1:${session.port}/helper/${encodeURIComponent(udid)}/ws`;
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketCtor(url);
      socket.binaryType = "nodebuffer";
      const messageListeners = new Set<(data: Uint8Array) => void>();
      const closeListeners = new Set<() => void>();
      let config: ScreenConfig | null = null;
      let settled = false;
      const connection: HidConnection = {
        get config() {
          return config;
        },
        send: (opcode, payload) => {
          if (socket.readyState === socket.OPEN) socket.send(encodeHid(opcode, payload));
        },
        sendRaw: (data) => {
          if (socket.readyState === socket.OPEN) socket.send(data);
        },
        onMessage: (listener) => {
          messageListeners.add(listener);
          return () => messageListeners.delete(listener);
        },
        onClose: (listener) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
        close: () => {
          try {
            socket.close();
          } catch {
            // already closed
          }
        },
      };
      socket.on("open", () => {
        settled = true;
        resolve(connection);
      });
      socket.on("message", (raw) => {
        const data = toBytes(raw);
        const decoded = decodeHid(data);
        const next = decoded ? screenConfigFrom(decoded.payload) : null;
        if (next) config = next;
        for (const listener of messageListeners) listener(data);
      });
      socket.on("close", () => {
        for (const listener of closeListeners) listener();
        if (!settled) {
          settled = true;
          reject(new Error("The simulator input socket closed before it opened."));
        }
      });
      socket.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Could not reach the simulator input socket: ${error.message}`));
        }
      });
    });
  }

  async withHid<T>(udid: string, work: (hid: HidConnection) => Promise<T>): Promise<T> {
    const hid = await this.openHid(udid);
    try {
      return await work(hid);
    } finally {
      // Give the last frame time to flush before the socket closes.
      await sleep(30);
      hid.close();
    }
  }

  private publicSession(session: InternalSession): StreamSession {
    return {
      udid: session.udid,
      port: session.port,
      pid: session.pid,
      startedAt: session.startedAt,
    };
  }
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw as Buffer[]));
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  return new Uint8Array(0);
}

function terminate(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // gone
      }
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
