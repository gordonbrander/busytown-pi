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
import type { Agent, AgentSetup, HandleOptions } from "./agent.ts";

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
  /** Appended to the system prompt via --append-system-prompt. */
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
  if (config.system) args.push("--append-system-prompt", config.system);
  if (config.extensions) {
    for (const ext of config.extensions) {
      args.push("-e", ext);
    }
  }
  return args;
};

const onErrorNoOp = (): void => {};

/** A signal that will never abort */
const neverAbortSignal = new AbortController().signal;

export const piAgentSetupOf = (config: PiAgentConfig): AgentSetup => {
  return async (id, send) => {
    const disposeController = new AbortController();
    const { onError = onErrorNoOp, env, cwd = process.cwd() } = config;

    const handle = async (
      event: Event,
      { signal: handleAbortSignal = neverAbortSignal }: HandleOptions = {},
    ): Promise<void> => {
      if (disposeController.signal.aborted) {
        throw new Error("Pi agent disposed");
      }

      const abortSignal = AbortSignal.any([
        disposeController.signal,
        handleAbortSignal,
      ]);
      const correlationId = event.id;

      const proc = spawn("pi", buildCliArgs(config), {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        env: { ...process.env, ...env },
      });

      const onAbort = (): void => {
        proc.kill("SIGTERM");
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });

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
                error: `Process exited unexpectedly (code ${code})`,
                correlation_id: correlationId,
                code,
                signal,
              });
            }
            break;
          }

          const sessionEvent = fromPiAgentSessionEvent(value, correlationId);
          if (sessionEvent) {
            await send(`agent.${id}.message`, sessionEvent);
          }

          if (value.type === "agent_end") {
            await send(`agent.${id}.end`, { correlation_id: correlationId });
            break;
          }
        }
      } catch (e) {
        await send(`agent.${id}.error`, {
          error: `${e}`,
          correlation_id: correlationId,
        });
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
    };

    const dispose = async (): Promise<void> => {
      disposeController.abort(new Error("Dispose pi-agent"));
    };

    return {
      handle,
      [Symbol.asyncDispose]: dispose,
    };
  };
};

export type PiAgentFactoryConfig = PiAgentConfig & {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
};

export const piAgentOf = (config: PiAgentFactoryConfig): Agent => {
  const { id, listen, ignoreSelf, ...setupConfig } = config;
  return { id, listen, ignoreSelf, setup: piAgentSetupOf(setupConfig) };
};
