import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { lineStream, mapStream, writeText } from "../lib/web-stream.ts";
import { mapPiEvent, type PiAgentSessionEvent } from "./events.ts";
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

const parseJsonLine = (line: string): unknown => {
  return JSON.parse(line.trim());
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

  // Hold a single reader for the process lifetime
  const reader = output.getReader();

  // Handle process death
  proc.once("exit", (code) => {
    processAbortController.abort(
      new ExitError(`Pi process exited unexpectedly`, code ?? undefined)
    );
  });

  let busy = false;

  const send = async function*(
    event: RequestEvent,
    options?: SendOptions
  ): AsyncGenerator<ResponseEvent> {
    if (busy) throw new Error("Concurrent send. Previous agent response step is not finished.");
    processAbortController.signal.throwIfAborted();
    busy = true;

    options?.signal?.addEventListener("abort", writeAbortEventBestEffort, { once: true });

    try {
      await writeEvent(event);
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          throw new ExitError("Pi process exited unexpectedly");
        }
        yield value;
        if (value.type === "agent_end") return;
      }
    } finally {
      options?.signal?.removeEventListener("abort", writeAbortEventBestEffort);
      busy = false;
    }
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
    send,
    kill,
  };
};
