import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { Agent } from "./agent.ts";
import { type EventDraft, type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { parseSlug } from "./lib/slug.ts";
import { renderTemplate } from "./lib/template.ts";
import { lineStream } from "./lib/web-stream.ts";

const logger = loggerOf({ source: "shell-agent.ts" });

export type ShellAgentConfig = {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
  shellScript: string;
};

export const shellAgentOf = (config: ShellAgentConfig): Agent => {
  const { listen, ignoreSelf = false, shellScript } = config;
  const id = parseSlug(config.id);
  const agentAbortController = new AbortController();

  const stream = (event: Event): ReadableStream<EventDraft> => {
    agentAbortController.signal.throwIfAborted();

    const rendered = renderTemplate(
      shellScript,
      event as unknown as Record<string, unknown>,
    );

    const proc = spawn("/bin/sh", ["-c", rendered], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Pipe stderr to logger (fire-and-forget)
    const stderr = (
      Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>
    ).pipeThrough(lineStream());

    stderr
      .pipeTo(
        new WritableStream({
          write(line) {
            logger.warn("stderr", { agent: id, line });
          },
        }),
      )
      .catch(() => {});

    // Build stdout line stream
    const stdout = (
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    ).pipeThrough(lineStream());

    const reader = stdout.getReader();

    const exitPromise = new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      proc.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const cleanup = () => {
      reader.releaseLock();
    };

    return new ReadableStream<EventDraft>(
      {
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              const { code, signal } = await exitPromise;
              if (code !== 0 && code !== null) {
                controller.enqueue({
                  type: `agent.${id}.error`,
                  payload: { code, signal },
                });
              }
              cleanup();
              controller.close();
              return;
            }
            controller.enqueue({
              type: `agent.${id}.response`,
              payload: { line: value },
            });
          } catch (e) {
            cleanup();
            controller.error(e);
          }
        },
        cancel() {
          proc.kill("SIGTERM");
          cleanup();
        },
      },
      { highWaterMark: 0 },
    );
  };

  const asyncDispose = async (): Promise<void> => {
    if (agentAbortController.signal.aborted) return;
    agentAbortController.abort(new Error("Shell agent disposed"));
  };

  return {
    id,
    listen,
    ignoreSelf,
    stream,
    disposed: agentAbortController.signal,
    [Symbol.asyncDispose]: asyncDispose,
  };
};
