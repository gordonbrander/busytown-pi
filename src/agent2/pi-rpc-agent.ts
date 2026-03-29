import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { lineStream, mapStream, writeText } from "../lib/web-stream.ts";
import { mapPiEvent, type PiAgentSessionEvent } from "./events.ts";
import { parseJsonLine } from "../lib/jsonl.ts";
import { ExitError } from "./error.ts";
import type {
  AgentProcess,
  RequestEvent,
  ResponseEvent,
  SendOptions,
} from "./types.ts";

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

export const createPiRpcAgent = (config: PiRpcAgentConfig): AgentProcess => {
  const processAbortController = new AbortController();
  const isAlive = () => !processAbortController.signal.aborted;

  const proc = spawn("pi", toCliArgs(config), {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: config.cwd,
  });

  const stdin = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
  const stdinWriter = stdin.getWriter();

  const writeEvent = (event: RequestEvent): Promise<void> =>
    writeText(stdinWriter, JSON.stringify(event) + "\n");

  const writeAbortEventBestEffort = async (): Promise<void> => {
    try {
      await writeEvent({ type: "abort" });
    } catch (e) {
      console.warn("Failed to write abort event", e);
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
      new ExitError(`Pi process exited unexpectedly`, code ?? undefined)
    );
  });

  const stream = (
    event: RequestEvent,
    options?: SendOptions
  ): ReadableStream<ResponseEvent> => {
    processAbortController.signal.throwIfAborted();

    // Acquire exclusive lock on the output stream
    const reader = output.getReader();

    options?.signal?.addEventListener(
      "abort",
      writeAbortEventBestEffort,
      { once: true },
    );

    const cleanup = () => {
      options?.signal?.removeEventListener("abort", writeAbortEventBestEffort);
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
            // Write input event
            await writeEvent(event);
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
            await writeAbortEventBestEffort();
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
    await writeEvent({ type: "abort" }).catch(() => { });
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
