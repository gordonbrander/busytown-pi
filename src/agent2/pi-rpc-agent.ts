import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import type { AgentProcess, AgentRunEvent } from "./types.ts";
import { bufferStream, lineStream, mapStream } from "../lib/web-stream.ts";

export type PiRpcAgentOptions = {
  /** Model pattern or ID (e.g. "anthropic/claude-sonnet-4-20250514") */
  model?: string;
  /** Tool names to enable */
  tools?: string[];
  /** Disable session persistence */
  noSession?: boolean;
  /** Custom session storage directory */
  sessionDir?: string;
  /** Working directory for the Pi process */
  cwd?: string;
  /** Extension file paths to load */
  extensions?: string[];
  /** Additional environment variables */
  env?: Record<string, string>;
};

/**
 * Map a raw Pi RPC event object to an AgentRunEvent, or null if not in our
 * event vocabulary.
 *
 * Pi's `message_update` events carry an `assistantMessageEvent` sub-object
 * that contains streaming deltas. We extract those and map them to our delta
 * and end events. All other Pi-internal events (responses, compaction,
 * retries, extension UI, etc.) are dropped.
 */
const mapPiEvent = (raw: Record<string, unknown>): AgentRunEvent | undefined => {
  switch (raw.type) {
    case "agent_start":
      return { type: "agent_start" };

    case "turn_start":
      return { type: "turn_start" };

    case "turn_end":
      return { type: "turn_end" };

    case "agent_end":
      return { type: "agent_end" };

    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: raw.toolCallId as string,
        toolName: raw.toolName as string,
        args: raw.args,
      };

    case "tool_execution_update":
      // toolName and args are omitted — known from the preceding
      // tool_execution_start and correlatable via toolCallId.
      return {
        type: "tool_execution_update",
        toolCallId: raw.toolCallId as string,
        partialResult: raw.partialResult,
      };

    case "tool_execution_end":
      // toolName is omitted — redundant per spec.
      return {
        type: "tool_execution_end",
        toolCallId: raw.toolCallId as string,
        isError: raw.isError as boolean,
        result: raw.result,
      };

    case "message_update": {
      // Pi wraps all streaming deltas inside a message_update event.
      // We extract only the sub-event types that we care about.
      const ae = raw.assistantMessageEvent as
        | Record<string, unknown>
        | undefined;
      if (!ae) return undefined;
      switch (ae.type) {
        case "text_delta":
          return { type: "text_delta", delta: ae.delta as string };
        case "text_end":
          return { type: "text_end", content: ae.content as string };
        case "thinking_delta":
          return { type: "thinking_delta", delta: ae.delta as string };
        case "thinking_end":
          return { type: "thinking_end", content: ae.content as string };
        default:
          return undefined;
      }
    }

    default:
      return undefined;
  }
};

/**
 * Create an `AgentProcess` backed by a long-lived Pi process in RPC mode.
 *
 * The Pi process is spawned immediately and kept alive for the lifetime of
 * the handle. Messages are queued through an internal channel (highWaterMark
 * 0) and processed one at a time by a persistent main loop. `send()` resolves
 * when the loop dequeues the message — i.e. after the previous run's
 * `agent_end`. Multiple in-flight sends are allowed; they queue and are
 * processed in order. `dispose()` shuts everything down.
 *
 * Abort: passing an `AbortSignal` to `send()` sends `{"type":"abort"}` to
 * Pi when the signal fires. Pi cancels the current run, still emits
 * `agent_end`, and leaves the session intact for the next run.
 */
export const piRpcAgent = (
  id: string,
  options: PiRpcAgentOptions = {},
): AgentProcess => {
  // --- Build Pi spawn args ---
  const args: string[] = ["--mode", "rpc"];
  if (options.noSession) args.push("--no-session");
  if (options.model) args.push("--model", options.model);
  if (options.tools?.length) args.push("--tools", options.tools.join(","));
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  for (const ext of options.extensions ?? []) args.push("-e", ext);

  const child = spawn("pi", args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
  });

  // --- Output stream ---
  // A single persistent ReadableStream spanning all agent runs.
  let outputController!: ReadableStreamDefaultController<AgentRunEvent>;
  const output = new ReadableStream<AgentRunEvent>({
    start(controller) {
      outputController = controller;
    },
  });

  // --- Disposed flag and message channel ---
  const disposed = new AbortController();
  // Messages from send() are queued here and consumed by the main loop.
  // highWaterMark 0 means each write() blocks until the loop reads it,
  // which only happens after the previous run's agent_end.
  const msgStream = bufferStream<{
    message: string;
    abort?: AbortSignal;
  }>(0);
  const msgReader = msgStream.readable.getReader();
  const msgWriter = msgStream.writable.getWriter();

  // --- Internal helpers ---

  /** Write a JSON command as a JSONL line to Pi's stdin. Swallows errors. */
  const writeCommand = (cmd: unknown): void => {
    try {
      child.stdin?.write(JSON.stringify(cmd) + "\n");
    } catch {
      // Pi may have exited; ignore write errors.
    }
  };

  /**
   * Mark disposed, close the output stream, and abort the message channel.
   * Idempotent — safe to call from the loop, process event handlers, and
   * dispose() without risk of double-close.
   */
  const shutdown = (): void => {
    if (disposed.signal.aborted) return;
    disposed.abort();
    try {
      outputController.close();
    } catch {
      /* already closed */
    }
    void msgWriter.abort(new Error(`Agent "${id}" closed`)).catch(() => { });
  };

  // --- Pi stdout → web stream pipeline ---
  const piEvents = (Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)
    .pipeThrough(lineStream())
    .pipeThrough(
      mapStream((line: string): AgentRunEvent | undefined => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return undefined;
        try {
          return mapPiEvent(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          return undefined; // skip malformed lines
        }
      }),
    );

  // A single persistent reader across all runs — using getReader() directly
  // rather than for-await so that breaking the inner loop doesn't cancel the
  // underlying stream.
  const piReader = piEvents.getReader();

  // --- Main loop ---
  // Outer: reads messages from the channel (blocks between runs).
  // Inner: reads Pi stdout events for the current run until agent_end.
  void (async () => {
    try {
      while (true) {
        const { done, value: slot } = await msgReader.read();
        if (done) break;

        const { message, abort } = slot;
        const onAbort = (): void => writeCommand({ type: "abort" });

        if (abort?.aborted) {
          writeCommand({ type: "prompt", message });
          writeCommand({ type: "abort" });
        } else {
          abort?.addEventListener("abort", onAbort, { once: true });
          writeCommand({ type: "prompt", message });
        }

        try {
          while (true) {
            const { done: piDone, value: event } = await piReader.read();
            if (piDone) return; // Pi process died — exit to outer finally
            if (event == null) continue;
            try {
              outputController.enqueue(event);
            } catch {
              /* stream closed */
            }
            if (event.type === "agent_end") break;
          }
        } finally {
          // Always clean up the abort listener, even if Pi died mid-run.
          abort?.removeEventListener("abort", onAbort);
        }
      }
    } catch {
      // Message channel was aborted (dispose() called) — exit cleanly.
    } finally {
      await piReader.cancel();
      shutdown();
    }
  })();

  // --- Process lifecycle ---
  child.on("error", shutdown);
  child.on("close", shutdown);

  // --- AgentProcess API ---

  const send = (message: string, abort?: AbortSignal): Promise<void> => {
    if (disposed.signal.aborted) {
      return Promise.reject(new Error(`Agent "${id}" has been disposed`));
    }
    return msgWriter.write({ message, abort });
  };

  const dispose = (): Promise<void> => {
    if (disposed.signal.aborted) return Promise.resolve();
    shutdown();
    return new Promise<void>((resolve) => {
      child.once("close", resolve);
      child.kill("SIGTERM");
    });
  };

  return { id, output, send, dispose };
};
