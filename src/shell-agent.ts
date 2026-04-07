import { spawn } from "node:child_process";
import { type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { renderTemplate } from "./lib/template.ts";
import { stderr, stdout, lineStream } from "./lib/web-stream.ts";
import type { AgentSetup, SendFn } from "./agent.ts";

const logger = loggerOf({ source: "shell-agent.ts" });

export type ShellAgentConfig = {
  shellScript: string;
  env?: Record<string, string | undefined>;
};

const handleEvent = async (
  id: string,
  send: SendFn,
  config: ShellAgentConfig,
  event: Event,
): Promise<void> => {
  const { shellScript, env = {} } = config;
  const correlationId = `${event.id}`;

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
    reader.releaseLock();
    await send(`agent.${id}.end`, { correlation_id: correlationId });
  }
};

export const shellAgentOf =
  (config: ShellAgentConfig): AgentSetup =>
  async (id, send) => {
    let disposed = false;
    return {
      async handle(event) {
        if (disposed) throw new Error("Shell agent disposed");
        await handleEvent(id, send, config, event);
      },
      async [Symbol.asyncDispose]() {
        disposed = true;
      },
    };
  };
