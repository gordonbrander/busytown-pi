import { spawn } from "node:child_process"
import type { AgentProcess, AgentRunEvent } from "./types.ts"

export type PiRpcAgentOptions = {
  /** Model pattern or ID (e.g. "anthropic/claude-sonnet-4-20250514") */
  model?: string
  /** Tool names to enable */
  tools?: string[]
  /** Disable session persistence */
  noSession?: boolean
  /** Custom session storage directory */
  sessionDir?: string
  /** Working directory for the Pi process */
  cwd?: string
  /** Extension file paths to load */
  extensions?: string[]
  /** Additional environment variables */
  env?: Record<string, string>
}

/**
 * Map a raw Pi RPC event object to an AgentRunEvent, or null if not in our
 * event vocabulary.
 *
 * Pi's `message_update` events carry an `assistantMessageEvent` sub-object
 * that contains streaming deltas. We extract those and map them to our delta
 * and end events. All other Pi-internal events (responses, compaction,
 * retries, extension UI, etc.) are dropped.
 */
const mapPiEvent = (raw: Record<string, unknown>): AgentRunEvent | null => {
  switch (raw.type) {
    case "agent_start":
      return { type: "agent_start" }

    case "turn_start":
      return { type: "turn_start" }

    case "turn_end":
      return { type: "turn_end" }

    case "agent_end":
      return { type: "agent_end" }

    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: raw.toolCallId as string,
        toolName: raw.toolName as string,
        args: raw.args,
      }

    case "tool_execution_update":
      // toolName and args are omitted — known from the preceding
      // tool_execution_start and correlatable via toolCallId.
      return {
        type: "tool_execution_update",
        toolCallId: raw.toolCallId as string,
        partialResult: raw.partialResult,
      }

    case "tool_execution_end":
      // toolName is omitted — redundant per spec.
      return {
        type: "tool_execution_end",
        toolCallId: raw.toolCallId as string,
        isError: raw.isError as boolean,
        result: raw.result,
      }

    case "message_update": {
      // Pi wraps all streaming deltas inside a message_update event.
      // We extract only the sub-event types that we care about.
      const ae = raw.assistantMessageEvent as
        | Record<string, unknown>
        | undefined
      if (!ae) return null
      switch (ae.type) {
        case "text_delta":
          return { type: "text_delta", delta: ae.delta as string }
        case "text_end":
          return { type: "text_end", content: ae.content as string }
        case "thinking_delta":
          return { type: "thinking_delta", delta: ae.delta as string }
        case "thinking_end":
          return { type: "thinking_end", content: ae.content as string }
        default:
          return null
      }
    }

    default:
      return null
  }
}

/**
 * Attach a JSONL line reader to a Node.js readable stream.
 *
 * Splits only on LF (`\n`), per the Pi RPC framing specification. This
 * intentionally avoids Node's `readline` module, which also splits on
 * U+2028 / U+2029 — Unicode characters that are valid inside JSON strings.
 * Trailing CR (`\r`) is stripped from each line.
 */
const attachJsonlReader = (
  readable: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void => {
  let buffer = ""

  readable.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")

    let idx: number
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      if (line.length > 0) onLine(line)
    }
  })

  readable.on("end", () => {
    // Flush any remaining partial line (no trailing newline)
    const remaining = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer
    if (remaining.length > 0) onLine(remaining)
    buffer = ""
  })
}

/**
 * Create an `AgentProcess` backed by a long-lived Pi process in RPC mode.
 *
 * The Pi process is spawned immediately and kept alive for the lifetime of
 * the handle. Each `send()` submits one prompt via the Pi RPC `prompt`
 * command and resolves when `agent_end` is received on stdout. `dispose()`
 * sends SIGTERM and closes the output stream.
 *
 * Backpressure: callers must `await send()` before calling again. Concurrent
 * sends are rejected.
 *
 * Abort: passing an `AbortSignal` to `send()` sends `{"type":"abort"}` to
 * Pi when the signal fires. Pi cancels the current run, still emits
 * `agent_end`, and leaves the session intact for the next `send()`.
 */
export const piRpcAgent = (
  id: string,
  options: PiRpcAgentOptions = {},
): AgentProcess => {
  // --- Build Pi spawn args ---
  const args: string[] = ["--mode", "rpc"]
  if (options.noSession) args.push("--no-session")
  if (options.model) args.push("--model", options.model)
  if (options.tools?.length) args.push("--tools", options.tools.join(","))
  if (options.sessionDir) args.push("--session-dir", options.sessionDir)
  for (const ext of options.extensions ?? []) args.push("-e", ext)

  const child = spawn("pi", args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
  })

  // --- Output stream ---
  // A single persistent ReadableStream spanning all agent runs.
  let outputController!: ReadableStreamDefaultController<AgentRunEvent>
  const output = new ReadableStream<AgentRunEvent>({
    start(controller) {
      outputController = controller
    },
  })

  // --- Mutable state ---
  let disposed = false
  let sending = false
  // Holds the resolve function for the currently active send() promise.
  // Set by send(), cleared by resolveCurrentRun().
  let runResolve: (() => void) | null = null

  // --- Internal helpers ---

  /** Write a JSON command as a JSONL line to Pi's stdin. Swallows errors. */
  const writeCommand = (cmd: unknown): void => {
    try {
      child.stdin?.write(JSON.stringify(cmd) + "\n")
    } catch {
      // Pi may have exited; ignore write errors.
    }
  }

  /**
   * Close the output stream if not already closed.
   * Safe to call multiple times.
   */
  const closeOutput = (): void => {
    if (!disposed) {
      disposed = true
      try {
        outputController.close()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Resolve and clear the current in-flight send() promise.
   * Safe to call multiple times (second call is a no-op).
   */
  const resolveCurrentRun = (): void => {
    const fn = runResolve
    runResolve = null
    sending = false
    fn?.()
  }

  // --- Stdout JSONL event reader ---
  if (child.stdout) {
    attachJsonlReader(child.stdout, (line) => {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(line) as Record<string, unknown>
      } catch {
        return // skip malformed lines
      }

      const event = mapPiEvent(raw)
      if (event === null) return

      // Push the mapped event to the output stream.
      if (!disposed) {
        try {
          outputController.enqueue(event)
        } catch {
          /* stream closed */
        }
      }

      // agent_end marks the end of one agent run — resolve the send() promise.
      if (event.type === "agent_end") {
        resolveCurrentRun()
      }
    })
  }

  // --- Process lifecycle ---

  child.on("error", () => {
    // Process failed to spawn or encountered a fatal error.
    closeOutput()
    resolveCurrentRun()
  })

  child.on("close", () => {
    // Process exited (covers normal exit, SIGTERM, crash).
    closeOutput()
    resolveCurrentRun()
  })

  // --- AgentProcess API ---

  const send = (message: string, abort?: AbortSignal): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error(`Agent "${id}" has been disposed`))
    }
    if (sending) {
      return Promise.reject(
        new Error(`Agent "${id}" already has an active send in progress`),
      )
    }
    sending = true

    return new Promise<void>((resolve) => {
      // Default: resolve when agent_end arrives.
      runResolve = resolve

      writeCommand({ type: "prompt", message })

      if (!abort) return

      if (abort.aborted) {
        // Signal already fired — send abort immediately after the prompt.
        // Pi will cancel and still emit agent_end.
        writeCommand({ type: "abort" })
      } else {
        // Wire up abort signal: when fired, send abort to Pi.
        const onAbort = (): void => writeCommand({ type: "abort" })
        abort.addEventListener("abort", onAbort, { once: true })

        // Wrap resolve so we remove the abort listener when the run ends,
        // regardless of whether abort fired or the run completed normally.
        const baseResolve = resolve
        runResolve = () => {
          abort.removeEventListener("abort", onAbort)
          baseResolve()
        }
      }
    })
  }

  const dispose = (): Promise<void> => {
    if (disposed) return Promise.resolve()

    // Unblock any in-flight send() immediately (before tearing down).
    resolveCurrentRun()
    closeOutput()

    return new Promise<void>((resolve) => {
      // Wait for the actual OS process to exit.
      child.once("close", resolve)
      child.kill("SIGTERM")
    })
  }

  return { id, output, send, dispose }
}
