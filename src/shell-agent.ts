import { spawn } from "node:child_process";
import { type Event } from "./lib/event.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { renderTemplate } from "./lib/template.ts";
import { stderr, stdout, lineStream } from "./lib/web-stream.ts";
import type { Agent, AgentSetup, HandleOptions } from "./agent.ts";

const logger = loggerOf({ source: "shell-agent.ts" });

export type ShellAgentConfig = {
  shellScript: string;
  env?: Record<string, string | undefined>;
};

/** A signal that will never abort */
const neverAbortSignal = new AbortController().signal;

export const shellAgentSetupOf = (config: ShellAgentConfig): AgentSetup => {
  return async (id, send) => {
    const disposeController = new AbortController();
    const { shellScript, env = {} } = config;

    const handle = async (
      event: Event,
      { signal: handleAbortSignal = neverAbortSignal }: HandleOptions = {},
    ): Promise<void> => {
      if (disposeController.signal.aborted) {
        throw new Error("Shell agent disposed");
      }

      const abortSignal = AbortSignal.any([
        disposeController.signal,
        handleAbortSignal,
      ]);
      const correlationId = event.id;

      // Render `{{placeholders}}` in shell script, making event
      // available to the script.
      const rendered = renderTemplate(shellScript, {
        event,
      });

      const proc = spawn("/bin/sh", ["-c", rendered], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });

      const onAbort = (): void => {
        proc.kill("SIGTERM");
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });

      // Pipe stderr to logger (fire-and-forget)
      stderr(proc)
        .pipeThrough(lineStream())
        .pipeTo(
          new WritableStream({
            write(line) {
              logger.warn("stderr", { agent: id, line });
            },
          }),
        )
        .catch(() => {});

      const lines = stdout(proc).pipeThrough(lineStream());
      const reader = lines.getReader();

      const exitPromise = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve) => {
        proc.once("exit", (code, signal) => resolve({ code, signal }));
      });

      await send(`agent.${id}.start`, {
        correlation_id: correlationId,
        event_type: event.type,
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const { code, signal } = await exitPromise;
            if (code !== 0 && code !== null) {
              await send(`agent.${id}.error`, {
                error: `Process exited unexpectedly (code ${code})`,
                correlation_id: correlationId,
                code,
                signal,
              });
            } else {
              await send(`agent.${id}.end`, { correlation_id: correlationId });
            }
            break;
          }
          await send(`agent.${id}.output`, { line: value });
        }
      } catch (e) {
        await send(`agent.${id}.error`, {
          error: `${e}`,
          correlation_id: correlationId,
        });
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
    };

    const dispose = async (): Promise<void> => {
      disposeController.abort(new Error("Dispose shell-agent"));
    };

    return {
      handle,
      [Symbol.asyncDispose]: dispose,
    };
  };
};

export type ShellAgentFactoryConfig = ShellAgentConfig & {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
};

export const shellAgentOf = (config: ShellAgentFactoryConfig): Agent => {
  const { id, listen, ignoreSelf, ...setupConfig } = config;
  return { id, listen, ignoreSelf, setup: shellAgentSetupOf(setupConfig) };
};
