import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { lineStream, mapStream, writeJsonLine, writeText } from "../lib/web-stream.ts";
import { mapPiEvent, type PiAgentSessionEvent } from "./events.ts";
import { parseJsonLine } from "../lib/jsonl.ts";
import { ExitError } from "./error.ts";
import { loggerOf } from "../lib/json-logger.ts";
import type {
  AgentProcess,
  PiRpcCommand,
  RequestEvent,
  ResponseEvent,
  SendOptions,
} from "./types.ts";

const logger = loggerOf({ source: "pi-rpc-agent.ts" });

export type PiRpcAgentConfig = {
  /** Working directory for the Pi process. */
  cwd: string;
  /** Pass --session-dir to Pi. If absent, pass --no-session instead. */
  sessionDir?: string;
  /** Pass --provider to Pi. */
  provider?: string;
  /** Pass --model to Pi. */
  model?: string;
  /** Called for each line written to stderr by the Pi process. */
  onError?: (error: { type: "error"; message: string }) => void;
};

export const toCliArgs = (config: PiRpcAgentConfig): string[] => {
  const args = ["--mode", "rpc"];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.sessionDir) {
    args.push("--session-dir", config.sessionDir);
  } else {
    args.push("--no-session");
  }
  return args;
};

export const piRpcAgentOf = (config: PiRpcAgentConfig): AgentProcess => {
  const processAbortController = new AbortController();
  const isAlive = () => !processAbortController.signal.aborted;

  const proc = spawn("pi", toCliArgs(config), {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: config.cwd,
  });

  const stdin = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
  const stdinWriter = stdin.getWriter();

  const sendCommand = (command: PiRpcCommand): Promise<void> =>
    writeJsonLine(stdinWriter, command);

  const sendEventPromptCommand = (event: RequestEvent): Promise<void> =>
    sendCommand({
      type: "prompt",
      message: JSON.stringify(event)
    });

  const sendAbortCommandBestEffort = async (): Promise<void> => {
    try {
      await sendCommand({ type: "abort" });
    } catch (e) {
      config.onError?.({ type: "error", message: "Failed to write abort command" });
      logger.error("Failed to write abort command", { error: `${e}` })
    }
  }

  // Convert stdout to a web ReadableStream of JSONL lines
  const output: ReadableStream<ResponseEvent> = (
    Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
  )
    .pipeThrough(lineStream())
    .pipeThrough(mapStream(parseJsonLine))
    .pipeThrough(mapStream((json) => mapPiEvent(json as PiAgentSessionEvent)));

  // Pipe stderr lines to onError callback
  if (config.onError) {
    const stderr = (Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>)
      .pipeThrough(lineStream());
    const onError = config.onError;
    stderr.pipeTo(new WritableStream({
      write(line) {
        onError({ type: "error", message: line });
      },
    })).catch(() => { });
  }

  // Handle process death
  proc.once("exit", (code) => {
    processAbortController.abort(
      new ExitError(`Pi process exited`, code ?? undefined)
    );
  });

  const stream = (
    request: RequestEvent,
    options?: SendOptions
  ): ReadableStream<ResponseEvent> => {
    processAbortController.signal.throwIfAborted();

    // Acquire exclusive lock on the output stream
    const reader = output.getReader();

    options?.signal?.addEventListener(
      "abort",
      sendAbortCommandBestEffort,
      { once: true },
    );

    const cleanup = () => {
      options?.signal?.removeEventListener("abort", sendAbortCommandBestEffort);
      reader.releaseLock();
    };

    const drainUntilEnd = async (): Promise<void> => {
      while (true) {
        const { done, value } = await reader.read();
        if (done || value.type === "agent_end") break;
      }
    };

    return new ReadableStream<ResponseEvent>(
      {
        async start() {
          try {
            // Write the prompt command to Pi's stdin
            await sendEventPromptCommand(request);
          } catch (e) {
            cleanup();
            throw e;
          }
        },
        async pull(controller) {
          try {
            // Get next value
            const { done, value } = await reader.read();
            // If done, it means the pi process exited early due to some error.
            // Clean up and throw an error to signal this stream is done.
            if (done) {
              cleanup();
              controller.error(new ExitError("Pi process exited unexpectedly"));
              return;
            }

            // Enqueue the value.
            controller.enqueue(value);

            // If it's the agent_end, then we clean up (release the lock on upstream)
            // and close this step's stream.
            if (value.type === "agent_end") {
              cleanup();
              controller.close();
            }
          } catch (e) {
            cleanup();
            controller.error(e);
          }
        },
        async cancel() {
          try {
            await sendAbortCommandBestEffort();
            await drainUntilEnd();
          } catch {
            // Process died — nothing left to drain
          }
          cleanup();
        },
      },
      { highWaterMark: 0 },
    );
  };

  const kill = async (): Promise<void> => {
    if (!isAlive()) return;
    await sendAbortCommandBestEffort();
    return new Promise<void>((resolve) => {
      proc.once("exit", resolve);
      proc.kill("SIGTERM");
    });
  };

  return {
    isAlive,
    stream,
    kill,
  };
};
