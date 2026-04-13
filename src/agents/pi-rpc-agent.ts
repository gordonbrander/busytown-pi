import { spawn } from "node:child_process";
import {
  lineStream,
  mapStream,
  stderr,
  stdout,
  stdin,
  writeJsonLine,
} from "../lib/web-stream.ts";
import { fromPiAgentSessionEvent } from "../lib/agent-session-event.ts";
import { loggerOf } from "../lib/json-logger.ts";
import {
  isPiRpcResponse,
  type PiRpcCommand,
  type PiRpcStdoutLine,
} from "../lib/pi-rpc-commands.ts";
import type { EventClient } from "../sdk.ts";
import type { PiRpcAgentDef } from "./file-agent-loader.ts";
import { neverAbortSignal } from "../lib/abort-controller.ts";

const logger = loggerOf({ source: "pi-rpc-agent.ts" });

type PiRpcCliFlagConfig = {
  model?: string;
  provider?: string;
  extensions?: string[];
  system?: string;
};

const buildCliArgs = (config: PiRpcCliFlagConfig): string[] => {
  const args = ["--mode", "rpc"];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.system) args.push("--append-system-prompt", config.system);
  if (config.extensions) {
    for (const ext of config.extensions) {
      args.push("-e", ext);
    }
  }
  return args;
};

export type PiRpcAgentHandlerConfig = PiRpcAgentDef & {
  cwd?: string;
  env?: Record<string, string | undefined>;
  pollInterval?: number;
  signal?: AbortSignal;
  extensions?: string[];
  system?: string;
};

export const piRpcAgentHandler = async (
  client: EventClient,
  {
    id,
    listen,
    ignoreSelf,
    pollInterval,
    signal = neverAbortSignal,
    cwd = process.cwd(),
    env = {},
    extensions,
    system,
    model,
    provider,
  }: PiRpcAgentHandlerConfig,
): Promise<void> => {
  const cliArgs = buildCliArgs({ model, provider, extensions, system });

  logger.debug("Creating RPC agent handler", { id });

  const proc = spawn("pi", cliArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, ...env },
  });

  const procAbortController = new AbortController();
  const loopAbortSignal = AbortSignal.any([signal, procAbortController.signal]);

  proc.once("exit", () => {
    procAbortController.abort(
      new Error(`pi subprocess exited for agent ${id}`),
    );
  });

  const stdinStream = stdin(proc);
  const stdinWriter = stdinStream.getWriter();

  const sendCommand = (command: PiRpcCommand): Promise<void> =>
    writeJsonLine(stdinWriter, command);

  // Convert stdout to JSONL stream
  const output: ReadableStream<PiRpcStdoutLine> = stdout(proc)
    .pipeThrough(lineStream())
    .pipeThrough(mapStream(JSON.parse));

  // Pipe stderr to logger
  stderr(proc)
    .pipeThrough(lineStream())
    .pipeTo(
      new WritableStream({
        write(line) {
          logger.error("stderr", { agent: id, line });
        },
      }),
    )
    .catch(() => {});

  const fullListen = [
    ...listen,
    `agent.${id}.compact`,
    `agent.${id}.new_session`,
  ];

  for await (const event of client.subscribe({
    listen: fullListen,
    ignoreSelf,
    pollInterval,
    signal: loopAbortSignal,
  })) {
    const correlationId = event.id;
    const reader = output.getReader();

    client.publish(`agent.${id}.start`, {
      correlation_id: correlationId,
      event_type: event.type,
    });

    const isCompact = event.type === `agent.${id}.compact`;
    const isNewSession = event.type === `agent.${id}.new_session`;

    try {
      if (isCompact) {
        await sendCommand({ type: "compact" });
      } else if (isNewSession) {
        await sendCommand({ type: "new_session" });
      } else {
        await sendCommand({
          type: "prompt",
          message: JSON.stringify(event),
        });
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (!isPiRpcResponse(value)) {
          const sessionEvent = fromPiAgentSessionEvent(value, correlationId);
          if (sessionEvent) {
            client.publish(`agent.${id}.message`, sessionEvent);
          }
        }

        // Per-command stream boundary:
        //   - prompt:      response line comes first (filtered), then
        //                  events; final event is agent_end.
        //   - compact:     events first (compaction_start … compaction_end),
        //                  then the RPC response. Break on the response so
        //                  the stream is fully drained before the next
        //                  iteration.
        //   - new_session: events (if any) then the RPC response. Break on
        //                  response.
        // Matches pi's rpc-mode.js: session.prompt is fire-and-forget so its
        // response is emitted synchronously before events stream;
        // session.compact and session.newSession are awaited so their
        // responses come after events.
        const isDone = isCompact
          ? isPiRpcResponse(value) && value.command === "compact"
          : isNewSession
            ? isPiRpcResponse(value) && value.command === "new_session"
            : value.type === "agent_end";

        if (isDone) {
          client.publish(`agent.${id}.end`, {
            correlation_id: correlationId,
          });
          break;
        }
      }
    } catch (e) {
      client.publish(`agent.${id}.error`, {
        error: String(e),
        correlation_id: correlationId,
      });
    } finally {
      reader.releaseLock();
    }
  }

  // Cleanup
  try {
    await sendCommand({ type: "abort" });
  } catch {
    // Best effort
  }
  proc.kill("SIGTERM");

  // If the loop exited because the pi subprocess died (not because the
  // caller's signal aborted), propagate so the supervisor restarts us.
  procAbortController.signal.throwIfAborted();
};
