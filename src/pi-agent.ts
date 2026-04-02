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
  fromPiAgentSessionEvent,
  type PiAgentSessionEvent,
} from "./lib/agent-session-event.ts";
import { type EventDraft, type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import type { Agent } from "./agent.ts";
import { parseSlug } from "./lib/slug.ts";

const logger = loggerOf({ source: "pi-agent.ts" });

type PiCliFlagConfig = {
  /** Pass --model to Pi. */
  model?: string;
  /** Pass --session-dir to Pi. */
  sessionDir?: string;
  /** Pass --provider to Pi. */
  provider?: string;
  /** Extension file paths to load via -e <path>. */
  extensions?: string[];
  /** Appended to the system prompt via --append-system. */
  system?: string;
};

export type PiAgentConfig = PiCliFlagConfig & {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
  /** Working directory for the Pi process. Defaults to process.cwd(). */
  cwd?: string;
  /** Called for each line written to stderr by the Pi process. */
  onError?: (error: { type: "error"; message: string }) => void;
  /** Extra environment variables passed to the Pi process. */
  env?: Record<string, string | undefined>;
};

const buildCliArgs = (config: PiCliFlagConfig): string[] => {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.sessionDir) args.push("--session-dir", config.sessionDir);
  if (config.system) args.push("--append-system", config.system);
  if (config.extensions) {
    for (const ext of config.extensions) {
      args.push("-e", ext);
    }
  }
  return args;
};

const onErrorNoOp = (): void => {};

export const piAgentOf = (config: PiAgentConfig): Agent => {
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

    const proc = spawn("pi", buildCliArgs(config), {
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

    // Parse stdout as JSONL PiAgentSessionEvent
    const output: ReadableStream<PiAgentSessionEvent> = stdout(proc)
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

            const sessionEvent = fromPiAgentSessionEvent(value, `${event.id}`);
            if (sessionEvent) {
              controller.enqueue({
                type: `agent.${id}.message`,
                payload: value,
              });
            }

            if (value.type === "agent_end") {
              cleanup();
              controller.close();
              return;
            }
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

  const dispose = async (): Promise<void> => {
    if (agentAbortController.signal.aborted) return;
    agentAbortController.abort(new Error("Pi agent disposed"));
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
