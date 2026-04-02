import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
import { type EventDraft, type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import type { PiRpcCommand } from "./pi-rpc-commands.ts";
import type { Agent } from "./agent.ts";
import { parseSlug } from "./lib/slug.ts";

const logger = loggerOf({ source: "pi-rpc-agent.ts" });

type AgentConfig = {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
};

type PiRpcCliFlagConfig = {
  /** Pass --model to Pi. */
  model?: string;
  /** Pass --session-dir to Pi. */
  sessionDir?: string;
  /** Pass --provider to Pi. */
  provider?: string;
  /** Extension file paths to load via -e <path>. */
  extensions?: string[];
};

export type PiRpcAgentConfig = AgentConfig &
  PiRpcCliFlagConfig & {
    /** Working directory for the Pi process. Defaults to process.cwd(). */
    cwd?: string;
    /** Called for each line written to stderr by the Pi process. */
    onError?: (error: { type: "error"; message: string }) => void;
    /** Extra environment variables passed to the Pi process. Process.env is merged with this object. */
    env?: Record<string, string | undefined>;
  };

/** This directory */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Extension that installs Busytown Pi tools for agent */
const AGENT_EXTENSION_PATH = path.join(MODULE_DIR, "pi-agent-extension.ts");

const buildCliArgs = (config: PiRpcCliFlagConfig): string[] => {
  const args = ["--mode", "rpc"];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.sessionDir) {
    args.push("--session-dir", config.sessionDir);
  }
  args.push("-e", AGENT_EXTENSION_PATH);
  return args;
};

const onErrorNoOp = (): void => {};

export const piRpcAgentOf = (config: PiRpcAgentConfig): Agent => {
  const {
    listen,
    ignoreSelf = true,
    onError = onErrorNoOp,
    env,
    cwd = process.cwd(),
  } = config;

  // Make sure we have a valid ID. Throws if not.
  const id = parseSlug(config.id);

  const processAbortController = new AbortController();

  const proc = spawn("pi", buildCliArgs(config), {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, ...env },
  });

  const stdin = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
  const stdinWriter = stdin.getWriter();

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

  // Handle process death. Make sure we've aborted if we haven't already.
  proc.once("exit", (code) => {
    processAbortController.abort(
      new Error(`Pi process exited (code: ${code ?? "null"})`),
    );
  });

  const stream = (event: Event): ReadableStream<EventDraft> => {
    processAbortController.signal.throwIfAborted();

    // Acquire exclusive lock on the output stream for the duration of this
    // agent step
    const reader = output.getReader();

    const cleanup = () => {
      reader.releaseLock();
    };

    const drainUntilAgentEnd = async (): Promise<void> => {
      while (true) {
        const { done, value } = await reader.read();
        if (done || value.type === "agent_end") break;
      }
    };

    return new ReadableStream<EventDraft>(
      {
        async start() {
          try {
            // Write the prompt command to Pi's stdin
            await sendEventPromptCommand(event);
          } catch (e) {
            cleanup();
            throw e;
          }
        },
        async pull(controller) {
          try {
            // Get next value
            const { done, value } = await reader.read();
            // If done, it means the pi process exited.
            // Clean up and close this stream.
            if (done) {
              cleanup();
              controller.close();
              return;
            }

            const sessionEvent = fromPiAgentSessionEvent(value, `${event.id}`);
            if (sessionEvent) {
              // Enqueue the value.
              controller.enqueue({
                type: `agent.${id}.message`,
                payload: value,
              });
            }

            // If it's the agent_end, then we clean up (release the lock on upstream)
            // and close this step's stream.
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
        async cancel() {
          try {
            await sendAbortCommandBestEffort();
            await drainUntilAgentEnd();
          } catch (e) {
            logger.error("Error cancelling stream", { error: `${e}` });
            throw e;
          } finally {
            cleanup();
          }
        },
      },
      { highWaterMark: 0 },
    );
  };

  const dispose = async (): Promise<void> => {
    if (processAbortController.signal.aborted) return;
    // Abort immediately
    processAbortController.abort(new Error(`Pi process aborted via kill()`));
    await sendAbortCommandBestEffort();
    // Promise for completion of teardown
    return new Promise<void>((resolve) => {
      proc.once("exit", resolve);
      proc.kill("SIGTERM");
    });
  };

  return {
    id,
    listen,
    ignoreSelf,
    disposed: processAbortController.signal,
    stream,
    [Symbol.asyncDispose]: dispose,
  };
};
