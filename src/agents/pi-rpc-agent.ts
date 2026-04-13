import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import {
  lineStream,
  mapStream,
  stderr,
  stdout,
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
  config: PiRpcAgentHandlerConfig,
): Promise<void> => {
  const {
    id,
    listen,
    ignoreSelf,
    pollInterval,
    signal,
    cwd = process.cwd(),
    env = {},
    extensions,
    system,
    model,
    provider,
  } = config;

  const cliArgs = buildCliArgs({ model, provider, extensions, system });

  logger.debug("Creating RPC agent handler", { id });

  const proc = spawn("pi", cliArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, ...env },
  });

  const stdinStream = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
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
    signal,
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
        if (done) break;

        if (!isPiRpcResponse(value)) {
          const sessionEvent = fromPiAgentSessionEvent(value, correlationId);
          if (sessionEvent) {
            client.publish(`agent.${id}.message`, sessionEvent);
          }
        }

        const isDone = isCompact
          ? value.type === "compaction_end"
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
};
