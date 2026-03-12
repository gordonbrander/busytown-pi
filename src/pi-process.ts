import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Event } from "./lib/event.ts";
import type { AgentDef, PiAgentDef, ShellAgentDef } from "./agent.ts";
import { pushEvent } from "./event-queue.ts";
import { renderTemplate } from "./lib/template.ts";
import { type Agent, agent } from "./agent-system.ts";
import { logger } from "./lib/json-logger.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentExtensionPath = path.join(__dirname, "agent-extension.ts");

const pipeLinesToEvents = (
  child: ChildProcess,
  stream: "stdout" | "stderr",
  db: DatabaseSync,
  agentId: string,
  eventType: string,
): void => {
  const readable = child[stream];
  if (!readable) return;
  const rl = createInterface({ input: readable });
  rl.on("line", (line) => {
    pushEvent(db, agentId, eventType, { line });
  });
};

type RunPiAgentArgs = {
  agent: PiAgentDef;
  event: Event;
  db: DatabaseSync;
  projectRoot: string;
  abortSignal?: AbortSignal;
};

export const runPiAgent = ({
  agent,
  event,
  db,
  projectRoot,
  abortSignal,
}: RunPiAgentArgs): Promise<number> => {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "-e",
    agentExtensionPath,
  ];

  if (agent.model) {
    args.push("--model", agent.model);
  }

  if (agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      resolve(1);
      return;
    }

    const child = spawn("pi", args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BUSYTOWN_DB_PATH: db.location()!,
        BUSYTOWN_AGENT_FILE: agent.filePath,
        BUSYTOWN_AGENT_ID: agent.id,
      },
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    pipeLinesToEvents(
      child,
      "stdout",
      db,
      agent.id,
      `sys.agent.${agent.id}.stdout`,
    );
    pipeLinesToEvents(
      child,
      "stderr",
      db,
      agent.id,
      `sys.agent.${agent.id}.stderr`,
    );

    // Write event JSON as the task prompt on stdin
    child.stdin?.write(JSON.stringify(event));
    child.stdin?.end();

    child.on("error", (err) => {
      logger.error("Pi agent failed to spawn", {
        agent: agent.id,
        event_id: event.id,
        error: err.message,
      });
      reject(err);
    });
    child.on("close", (code) => {
      abortSignal?.removeEventListener("abort", onAbort);
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        logger.warn("Pi agent exited with non-zero code", {
          agent: agent.id,
          event_id: event.id,
          exitCode,
        });
      }
      resolve(exitCode);
    });
  });
};

type RunShellAgentArgs = {
  agent: ShellAgentDef;
  event: Event;
  db: DatabaseSync;
  projectRoot: string;
  abortSignal?: AbortSignal;
};

export const runShellAgent = ({
  agent,
  event,
  db,
  projectRoot,
  abortSignal,
}: RunShellAgentArgs): Promise<number> => {
  const rendered = renderTemplate(agent.body, { event });

  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      resolve(1);
      return;
    }

    const child = spawn("sh", ["-c", rendered], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    pipeLinesToEvents(
      child,
      "stdout",
      db,
      agent.id,
      `sys.agent.${agent.id}.stdout`,
    );
    pipeLinesToEvents(
      child,
      "stderr",
      db,
      agent.id,
      `sys.agent.${agent.id}.stderr`,
    );

    child.on("error", (err) => {
      logger.error("Shell agent failed to spawn", {
        agent: agent.id,
        event_id: event.id,
        error: err.message,
      });
      reject(err);
    });
    child.on("close", (code) => {
      abortSignal?.removeEventListener("abort", onAbort);
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        logger.warn("Shell agent exited with non-zero code", {
          agent: agent.id,
          event_id: event.id,
          exitCode,
        });
      }
      resolve(exitCode);
    });
  });
};

export const runAgent = async (
  db: DatabaseSync,
  agentDef: AgentDef,
  event: Event,
  projectRoot: string,
  abortSignal?: AbortSignal,
): Promise<number> => {
  switch (agentDef.type) {
    case "pi":
      return await runPiAgent({
        agent: agentDef,
        event,
        db,
        projectRoot,
        abortSignal,
      });
    case "shell":
      return await runShellAgent({
        agent: agentDef,
        event,
        db,
        projectRoot,
        abortSignal,
      });
    default:
      throw new Error(`Unsupported agent type`);
  }
};

export const makeAgentRunner = (db: DatabaseSync, projectRoot: string) => {
  return (agentDef: AgentDef): Agent =>
    agent({
      id: agentDef.id,
      listen: agentDef.listen,
      ignoreSelf: agentDef.ignoreSelf,
      run: async (event, { abortSignal }) => {
        const exitCode = await runAgent(
          db,
          agentDef,
          event,
          projectRoot,
          abortSignal,
        );
        if (exitCode !== 0) {
          throw new Error(
            `Agent "${agentDef.id}" exited with code ${exitCode}`,
          );
        }
      },
    });
};
