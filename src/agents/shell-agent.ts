import { spawn } from "node:child_process";
import { renderTemplate } from "../lib/template.ts";
import { stderr, stdout, lineStream } from "../lib/web-stream.ts";
import type { EventClient } from "../sdk.ts";
import type { ShellAgentDef } from "./file-agent-loader.ts";

export type ShellAgentHandlerConfig = ShellAgentDef & {
  env?: Record<string, string | undefined>;
  pollInterval?: number;
  signal?: AbortSignal;
};

export const shellAgentHandler = async (
  client: EventClient,
  config: ShellAgentHandlerConfig,
): Promise<void> => {
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
    const rendered = renderTemplate(body, { event });

    const proc = spawn("/bin/sh", ["-c", rendered], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    const exitPromise = new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      proc.once("exit", (code, signal) => resolve({ code, signal }));
    });

    client.publish(`agent.${id}.start`, { event_type: event.type }, event);

    // Pipe stderr to events (fire-and-forget)
    stderr(proc)
      .pipeThrough(lineStream())
      .pipeTo(
        new WritableStream({
          write(line) {
            client.publish(`agent.${id}.stderr`, { line }, event);
          },
        }),
      )
      .catch(() => {});

    const lines = stdout(proc).pipeThrough(lineStream());
    const reader = lines.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const { code, signal } = await exitPromise;
          if (code !== 0 && code !== null) {
            client.publish(
              `agent.${id}.error`,
              {
                error: `Process exited unexpectedly (code ${code})`,
                code,
                signal,
              },
              event,
            );
          } else {
            client.publish(`agent.${id}.end`, {}, event);
          }
          break;
        }
        client.publish(`agent.${id}.stdout`, { line: value }, event);
      }
    } catch (e) {
      client.publish(`agent.${id}.error`, { error: `${e}` }, event);
    } finally {
      reader.releaseLock();
    }
  }
};
