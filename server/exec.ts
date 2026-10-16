import { execFile } from "node:child_process";
import type { Exec, ExecResult } from "./simctl";

/** Run a program to completion, never throwing on a non-zero exit. */
export function createNodeExec(): Exec {
  return (file, args, options = {}) =>
    new Promise<ExecResult>((resolve) => {
      const child = execFile(
        file,
        args,
        {
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: 64 * 1024 * 1024,
          signal: options.signal,
          killSignal: options.killSignal ?? "SIGTERM",
          env: options.env ? { ...process.env, ...options.env } : process.env,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as NodeJS.ErrnoException).code === "number"
              ? ((error as NodeJS.ErrnoException).code as unknown as number)
              : error
                ? (typeof (error as { code?: unknown }).code === "string" ? 127 : 1)
                : 0;
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || (error && code === 127 ? error.message : ""),
            code,
          });
        },
      );
      if (options.input !== undefined && child.stdin) {
        child.stdin.end(options.input);
      }
    });
}
