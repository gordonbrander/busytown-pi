import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import {
  lineStream,
  mapStream,
  stderr,
  stdout,
  writeJsonLine,
} from "./lib/web-stream.ts";
import {
  fromPiAgentSessionEvent,
  type PiAgentSessionEvent,
} from "./lib/agent-session-event.ts";
import { type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import type { PiRpcCommand } from "./pi-rpc-commands.ts";
import type { AgentSetup, SpawnAgentConfig } from "./agent.ts";

const logger = loggerOf({ source: "pi-rpc-agent.ts" });

type PiRpcCliFlagConfig = {
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

export type PiRpcAgentConfig = PiRpcCliFlagConfig & {
  /** Working directory for the Pi process. Defaults to process.cwd(). */
  cwd?: string;
  /** Called for each line written to stderr by the Pi process. */
  onError?: (error: { type: "error"; message: string }) => void;
  /** Extra environment variables passed to the Pi process. Process.env is merged with this object. */
  env?: Record<string, string | undefined>;
};

const buildCliArgs = (config: PiRpcCliFlagConfig): string[] => {
  const args = ["--mode", "rpc"];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.sessionDir) {
    args.push("--session-dir", config.sessionDir);
  }
  if (config.system) args.push("--append-system", config.system);
  if (config.extensions) {
    for (const ext of config.extensions) {
      args.push("-e", ext);
    }
  }
  return args;
};

const onErrorNoOp = (): void => {};

export const piRpcAgentSetupOf = (config: PiRpcAgentConfig): AgentSetup => {
  return async (id, send) => {
    logger.debug("Creating RPC agent", { id });

    const { onError = onErrorNoOp, env, cwd = process.cwd() } = config;

    const proc = spawn("pi", buildCliArgs(config), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, ...env },
    });

    const stdinStream = Writable.toWeb(
      proc.stdin,
    ) as WritableStream<Uint8Array>;
    const stdinWriter = stdinStream.getWriter();

    const sendCommand = (command: PiRpcCommand): Promise<void> =>
      writeJsonLine(stdinWriter, command);

    const sendEventPromptCommand = (event: Event): Promise<void> =>
      sendCommand({
        type: "prompt",
        message: JSON.stringify(event),
      });

    const sendAbortCommandBestEffort = async (): Promise<void> => {
      try {
        await sendCommand({ type: "abort" });
      } catch (e) {
        onError({ type: "error", message: "Failed to write abort command" });
        logger.error("Failed to write abort command", { error: `${e}` });
      }
    };

    // Convert stdout to a web ReadableStream of JSONL lines
    const output: ReadableStream<PiAgentSessionEvent> = stdout(proc)
      .pipeThrough(lineStream())
      .pipeThrough(mapStream(JSON.parse));

    // Pipe stderr lines to onError callback
    stderr(proc)
      .pipeThrough(lineStream())
      .pipeTo(
        new WritableStream({
          write(line) {
            onError({ type: "error", message: line });
            logger.error("stderr", { line });
          },
        }),
      )
      .catch(() => {});

    let disposed = false;

    return {
      async handle(event, options) {
        if (disposed) throw new Error("Pi RPC agent disposed");

        const correlationId = `${event.id}`;

        // Acquire exclusive lock on the output stream for this agent step
        const reader = output.getReader();

        options?.signal?.addEventListener("abort", sendAbortCommandBestEffort, {
          once: true,
        });

        await send(`agent.${id}.start`, {
          correlation_id: correlationId,
          event_type: event.type,
        });

        const isCompact = event.type === `agent.${id}.compact`;

        try {
          if (isCompact) {
            await sendCommand({ type: "compact" });
          } else {
            await sendEventPromptCommand(event);
          }

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            const sessionEvent = fromPiAgentSessionEvent(value, correlationId);
            if (sessionEvent) {
              await send(`agent.${id}.message`, sessionEvent);
            }

            const isDone = isCompact
              ? value.type === "compaction_end"
              : value.type === "agent_end";

            if (isDone) {
              await send(`agent.${id}.end`, {
                correlation_id: correlationId,
              });
              break;
            }
          }
        } catch (e) {
          await send(`agent.${id}.error`, {
            error: String(e),
            correlation_id: correlationId,
          });
        } finally {
          options?.signal?.removeEventListener(
            "abort",
            sendAbortCommandBestEffort,
          );
          reader.releaseLock();
        }
      },

      async [Symbol.asyncDispose]() {
        if (disposed) return;
        disposed = true;
        logger.debug("Disposing RPC agent", { id });
        await sendAbortCommandBestEffort();
        return new Promise<void>((resolve) => {
          proc.once("exit", (code) => {
            logger.debug("RPC agent process exited", { id, code });
            resolve();
          });
          proc.kill("SIGTERM");
        });
      },
    };
  };
};

export type PiRpcAgentFactoryConfig = PiRpcAgentConfig & {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
};

export const piRpcAgentOf = (
  config: PiRpcAgentFactoryConfig,
): SpawnAgentConfig => {
  const { id, listen, ignoreSelf, ...setupConfig } = config;
  return {
    id,
    listen: [...listen, `agent.${id}.compact`],
    ignoreSelf,
    setup: piRpcAgentSetupOf(setupConfig),
  };
};
