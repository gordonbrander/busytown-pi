import { spawn } from "node:child_process";
import { type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { renderTemplate } from "./lib/template.ts";
import { stderr, stdout, lineStream } from "./lib/web-stream.ts";
import type { AgentSetup, HandleOptions } from "./agent.ts";

const logger = loggerOf({ source: "shell-agent.ts" });

export type ShellAgentConfig = {
  shellScript: string;
  env?: Record<string, string | undefined>;
};

/** A signal that will never abort */
const neverAbortSignal = new AbortController().signal;

export const shellAgentOf = (config: ShellAgentConfig): AgentSetup => {
  return async (id, send) => {
    const disposeController = new AbortController();
    const { shellScript, env = {} } = config;

    const handle = async (
      event: Event,
      { signal: handleAbortSignal = neverAbortSignal }: HandleOptions = {},
    ): Promise<void> => {
      if (disposeController.signal.aborted)
        throw new Error("Shell agent disposed");

      const abortSignal = AbortSignal.any([
        disposeController.signal,
        handleAbortSignal,
      ]);
      const correlationId = `${event.id}`;

      const rendered = renderTemplate(
        shellScript,
        event as unknown as Record<string, unknown>,
      );

      const proc = spawn("/bin/sh", ["-c", rendered], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });

      const onAbort = (): void => {
        proc.kill("SIGTERM");
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });

      // Pipe stderr to logger (fire-and-forget)
      stderr(proc)
        .pipeThrough(lineStream())
        .pipeTo(
          new WritableStream({
            write(line) {
              logger.warn("stderr", { agent: id, line });
            },
          }),
        )
        .catch(() => {});

      const lines = stdout(proc).pipeThrough(lineStream());
      const reader = lines.getReader();

      const exitPromise = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve) => {
        proc.once("exit", (code, signal) => resolve({ code, signal }));
      });

      await send(`agent.${id}.start`, {
        correlation_id: correlationId,
        event_type: event.type,
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const { code, signal } = await exitPromise;
            if (code !== 0 && code !== null) {
              await send(`agent.${id}.error`, {
                correlation_id: correlationId,
                code,
                signal,
              });
            }
            break;
          }
          await send(`agent.${id}.response`, { line: value });
        }
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
        reader.releaseLock();
        await send(`agent.${id}.end`, { correlation_id: correlationId });
      }
    };

    const dispose = async (): Promise<void> => {
      disposeController.abort(new Error("Dispose shell-agent"));
    };

    return {
      handle,
      [Symbol.asyncDispose]: dispose,
    };
  };
};
