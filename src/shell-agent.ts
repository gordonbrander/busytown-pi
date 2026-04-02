import { spawn } from "node:child_process";
import type { Agent } from "./agent.ts";
import { type EventDraft, type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { parseSlug } from "./lib/slug.ts";
import { renderTemplate } from "./lib/template.ts";
import { stderr, stdout, lineStream } from "./lib/web-stream.ts";

const logger = loggerOf({ source: "shell-agent.ts" });

export type ShellAgentConfig = {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
  shellScript: string;
  env?: Record<string, string | undefined>;
};

export const shellAgentOf = (config: ShellAgentConfig): Agent => {
  const { listen, ignoreSelf = true, shellScript, env = {} } = config;
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
      env: { ...process.env, ...env },
    });

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

    // Build stdout line stream
    const lines = stdout(proc).pipeThrough(lineStream());

    const reader = lines.getReader();

    const exitPromise = new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      proc.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const cleanup = () => {
      reader.releaseLock();
    };

    const correlationId = `${event.id}`;

    return new ReadableStream<EventDraft>(
      {
        start(controller) {
          controller.enqueue({
            type: `agent.${id}.start`,
            payload: { correlation_id: correlationId, event_type: event.type },
          });
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              const { code, signal } = await exitPromise;
              if (code !== 0 && code !== null) {
                controller.enqueue({
                  type: `agent.${id}.error`,
                  payload: { correlation_id: correlationId, code, signal },
                });
              }
              controller.enqueue({
                type: `agent.${id}.end`,
                payload: { correlation_id: correlationId },
              });
              cleanup();
              controller.close();
              return;
            }
            controller.enqueue({
              type: `agent.${id}.response`,
              payload: { line: value },
            });
          } catch (e) {
            controller.enqueue({
              type: `agent.${id}.error`,
              payload: { correlation_id: correlationId, error: String(e) },
            });
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
