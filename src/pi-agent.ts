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
import { type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import type { AgentSetup, SendFn } from "./agent.ts";

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

const handleEvent = async (
  id: string,
  send: SendFn,
  config: PiAgentConfig,
  event: Event,
): Promise<void> => {
  const { onError = onErrorNoOp, env, cwd = process.cwd() } = config;

  const correlationId = `${event.id}`;

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

      const sessionEvent = fromPiAgentSessionEvent(value, correlationId);
      if (sessionEvent) {
        await send(`agent.${id}.message`, value);
      }

      if (value.type === "agent_end") {
        break;
      }
    }
  } finally {
    reader.releaseLock();
    await send(`agent.${id}.end`, { correlation_id: correlationId });
  }
};

export const piAgentOf =
  (config: PiAgentConfig): AgentSetup =>
  async (id, send) => {
    let disposed = false;
    return {
      async handle(event) {
        if (disposed) throw new Error("Pi agent disposed");
        await handleEvent(id, send, config, event);
      },
      async [Symbol.asyncDispose]() {
        disposed = true;
      },
    };
  };
