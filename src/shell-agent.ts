import { spawn } from "node:child_process";
import { loggerOf } from "./lib/json-logger.ts";
import { renderTemplate } from "./lib/template.ts";
import { stderr, stdout, lineStream } from "./lib/web-stream.ts";
import type { AgentHandler } from "./agent-handler.ts";

const logger = loggerOf({ source: "shell-agent.ts" });

export const shellAgentHandler: AgentHandler = async (client, config) => {
  const {
    id,
    body,
    env = {},
    listen,
    ignoreSelf,
    pollInterval,
    signal,
  } = config;

  for await (const event of client.subscribe({
    listen,
    ignoreSelf,
    pollInterval,
    signal,
  })) {
    const correlationId = event.id;

    const rendered = renderTemplate(body, { event });

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

    client.publish(`agent.${id}.start`, {
      correlation_id: correlationId,
      event_type: event.type,
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const { code, signal } = await exitPromise;
          if (code !== 0 && code !== null) {
            client.publish(`agent.${id}.error`, {
              error: `Process exited unexpectedly (code ${code})`,
              correlation_id: correlationId,
              code,
              signal,
            });
          } else {
            client.publish(`agent.${id}.end`, {
              correlation_id: correlationId,
            });
          }
          break;
        }
        client.publish(`agent.${id}.output`, { line: value });
      }
    } catch (e) {
      client.publish(`agent.${id}.error`, {
        error: `${e}`,
        correlation_id: correlationId,
      });
    } finally {
      reader.releaseLock();
    }
  }
};
