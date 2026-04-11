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
import { loggerOf } from "./lib/json-logger.ts";
import type { AgentHandler } from "./agent-handler.ts";

const logger = loggerOf({ source: "pi-agent.ts" });

type PiCliFlagConfig = {
  model?: string;
  provider?: string;
  extensions?: string[];
  system?: string;
};

const buildCliArgs = (config: PiCliFlagConfig): string[] => {
  const args = ["--mode", "json", "-p", "--no-session"];
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

export const piAgentHandler: AgentHandler = async (client, config) => {
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
  } = config;

  const model =
    "model" in config ? (config.model as string | undefined) : undefined;
  const provider =
    "provider" in config ? (config.provider as string | undefined) : undefined;

  const cliArgs = buildCliArgs({ model, provider, extensions, system });

  for await (const event of client.subscribe({
    listen,
    ignoreSelf,
    pollInterval,
    signal,
  })) {
    const correlationId = event.id;

    const proc = spawn("pi", cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, ...env },
    });

    // Write the event as the prompt to stdin, then close stdin
    const stdinWriter = stdin(proc).getWriter();
    writeJsonLine(stdinWriter, event)
      .then(() => stdinWriter.close())
      .catch(() => {});

    // Pipe stderr to logger (fire-and-forget)
    stderr(proc)
      .pipeThrough(lineStream())
      .pipeTo(
        new WritableStream({
          write(line) {
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

    client.publish(`agent.${id}.start`, {
      correlation_id: correlationId,
      event_type: event.type,
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const { code, signal } = await exitPromise;
          if (code !== 0 && code !== null) {
            client.publish(`agent.${id}.error`, {
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
          client.publish(`agent.${id}.message`, sessionEvent);
        }

        if (value.type === "agent_end") {
          client.publish(`agent.${id}.end`, {
            correlation_id: correlationId,
          });
          break;
        }
      }
    } catch (e) {
      client.publish(`agent.${id}.error`, {
        error: `${e}`,
        correlation_id: correlationId,
      });
    } finally {
      reader.releaseLock();
    }
  }
};
