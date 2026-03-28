import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { lineStream, mapStream, writeText } from "../lib/web-stream.ts";
import { mapPiEvent, type PiAgentSessionEvent } from "./events.ts";
import { ExitError } from "./error.ts";
import type { AgentProcess, RequestEvent, ResponseEvent } from "./types.ts";

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

  /** Send a request to the agent */
  const send = async (data: RequestEvent): Promise<void> => {
    processAbortController.signal.throwIfAborted();
    return await writeText(stdinWriter, JSON.stringify(data) + "\n");
  };

  const errors: ReadableStream<string> = (
    Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>
  )
    .pipeThrough(lineStream())

  // Convert stdout to a web ReadableStream of JSONL lines
  const output: ReadableStream<ResponseEvent> = (
    Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
  )
    .pipeThrough(lineStream())
    .pipeThrough(mapStream(parseJsonLine))
    .pipeThrough(mapStream((json) => mapPiEvent(json as PiAgentSessionEvent)));

  // Handle process death
  proc.once("exit", (code) => {
    processAbortController.abort(new ExitError(`Pi process exited unexpectedly`, code ?? undefined));
  });

  const kill = async (): Promise<void> => {
    await send({ type: "abort" });
    return new Promise<void>((resolve) => {
      proc.once("exit", resolve);
      proc.kill("SIGTERM");
    });
  };

  return {
    isAlive,
    send,
    output,
    errors,
    kill,
  };
};
