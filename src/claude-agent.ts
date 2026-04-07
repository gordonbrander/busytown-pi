import { spawn } from "node:child_process";
import {
  lineStream,
  mapStream,
  stderr,
  stdin,
  stdout,
  writeJsonLine,
} from "./lib/web-stream.ts";
import {
  fromClaudeStreamEvent,
  type ClaudeStreamEvent,
} from "./lib/claude-session-event.ts";
import { type EventDraft, type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import type { Agent } from "./agent.ts";
import { parseSlug } from "./lib/slug.ts";

const logger = loggerOf({ source: "claude-agent.ts" });

export type ClaudeAgentConfig = {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
  model?: string;
  tools?: string[];
  system?: string;
  cwd?: string;
  onError?: (error: { type: "error"; message: string }) => void;
  env?: Record<string, string | undefined>;
};

const buildCliArgs = (config: ClaudeAgentConfig): string[] => {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--bare",
  ];
  if (config.system) args.push("--system-prompt", config.system);
  if (config.model) args.push("--model", config.model);
  if (config.tools && config.tools.length > 0) {
    args.push("--allowedTools", ...config.tools);
  }
  return args;
};

const onErrorNoOp = (): void => {};

export const claudeAgentOf = (config: ClaudeAgentConfig): Agent => {
  const {
    listen,
    ignoreSelf = true,
    onError = onErrorNoOp,
    env,
    cwd = process.cwd(),
  } = config;

  const id = parseSlug(config.id);
  const agentAbortController = new AbortController();

  const stream = (event: Event): ReadableStream<EventDraft> => {
    agentAbortController.signal.throwIfAborted();

    const proc = spawn("claude", buildCliArgs(config), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, ...env },
    });

    // Write the event as the prompt to stdin, then close stdin
    const stdinWriter = stdin(proc).getWriter();
    writeJsonLine(stdinWriter, event)
      .then(() => stdinWriter.close())
      .catch(() => {});

    // Pipe stderr to onError (fire-and-forget)
    stderr(proc)
      .pipeThrough(lineStream())
      .pipeTo(
        new WritableStream({
          write(line) {
            onError({ type: "error", message: line });
            logger.error("stderr", { agent: id, line });
          },
        }),
      )
      .catch((e) => {
        logger.error("stderr", { agent: id, error: `${e}` });
      });

    // Parse stdout as JSONL ClaudeStreamEvent
    const output: ReadableStream<ClaudeStreamEvent> = stdout(proc)
      .pipeThrough(lineStream())
      .pipeThrough(mapStream(JSON.parse));

    const reader = output.getReader();

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

    let prevContentLength = 0;

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
                  payload: { correlation_id: correlationId, code, signal },
                });
              }
              cleanup();
              controller.close();
              return;
            }

            const { events, contentLength } = fromClaudeStreamEvent(
              value,
              correlationId,
              prevContentLength,
            );
            prevContentLength = contentLength;

            for (const sessionEvent of events) {
              controller.enqueue({
                type: `agent.${id}.message`,
                payload: sessionEvent,
              });
            }

            // result is the terminal event — cleanup and close
            if (value.type === "result") {
              cleanup();
              controller.close();
              return;
            }
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

  const dispose = async (): Promise<void> => {
    if (agentAbortController.signal.aborted) return;
    agentAbortController.abort(new Error("Claude agent disposed"));
  };

  return {
    id,
    listen,
    ignoreSelf,
    stream,
    disposed: agentAbortController.signal,
    [Symbol.asyncDispose]: dispose,
  };
};
