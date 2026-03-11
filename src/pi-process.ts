import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Event } from "./lib/event.ts";
import type { AgentDef, PiAgentDef, ShellAgentDef } from "./agent.ts";
import { pushEvent } from "./event-queue.ts";
import { renderTemplate } from "./lib/template.ts";
import { type Worker, worker } from "./worker.ts";
import { logger } from "./lib/json-logger.ts";

const buildSystemPrompt = (
  agent: PiAgentDef,
  dbPath: string,
  cliBin: string,
): string => {
  const lines = [
    `You are the "${agent.id}" agent. ${agent.description}`,
    "",
    "## Pushing events",
    "",
    "To push an event to the Busytown event queue, run:",
    "```",
    `${cliBin} push --db ${dbPath} --worker ${agent.id} --type <event-type> --payload '<json>'`,
    "```",
    "",
    "## Claiming events",
    "",
    "Before doing significant work on an event, claim it to prevent other agents from processing it:",
    "```",
    `${cliBin} claim --db ${dbPath} --worker ${agent.id} --event <event-id>`,
    "```",
    "",
    "If the claim returns `false`, another agent has already claimed it — skip the event.",
    "",
  ];

  if (agent.body) {
    lines.push("## Agent instructions", "", agent.body);
  }

  return lines.join("\n");
};

const writeSystemPromptFile = (
  agent: PiAgentDef,
  dbPath: string,
  cliBin: string,
  projectRoot: string,
): string => {
  const dir = path.join(projectRoot, ".busytown");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `system-prompt-${agent.id}.md`);
  fs.writeFileSync(filePath, buildSystemPrompt(agent, dbPath, cliBin));
  return filePath;
};

const pipeLinesToEvents = (
  child: ChildProcess,
  stream: "stdout" | "stderr",
  db: DatabaseSync,
  workerId: string,
  eventType: string,
): void => {
  const readable = child[stream];
  if (!readable) return;
  const rl = createInterface({ input: readable });
  rl.on("line", (line) => {
    pushEvent(db, workerId, eventType, { line });
  });
};

type RunPiAgentArgs = {
  agent: PiAgentDef;
  event: Event;
  db: DatabaseSync;
  projectRoot: string;
  cliBin: string;
  abortSignal?: AbortSignal;
};

export const runPiAgent = ({
  agent,
  event,
  db,
  projectRoot,
  cliBin,
  abortSignal,
}: RunPiAgentArgs): Promise<number> => {
  const systemPromptFile = writeSystemPromptFile(
    agent,
    db.location()!,
    cliBin,
    projectRoot,
  );

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--append-system-prompt",
    systemPromptFile,
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
      `sys.worker.${agent.id}.stdout`,
    );
    pipeLinesToEvents(
      child,
      "stderr",
      db,
      agent.id,
      `sys.worker.${agent.id}.stderr`,
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
      `sys.worker.${agent.id}.stdout`,
    );
    pipeLinesToEvents(
      child,
      "stderr",
      db,
      agent.id,
      `sys.worker.${agent.id}.stderr`,
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

export const runAgentWorker = async (
  db: DatabaseSync,
  agent: AgentDef,
  event: Event,
  projectRoot: string,
  cliBin: string,
  abortSignal?: AbortSignal,
): Promise<number> => {
  switch (agent.type) {
    case "pi":
      return await runPiAgent({
        agent,
        event,
        db,
        projectRoot,
        cliBin,
        abortSignal,
      });
    case "shell":
      return await runShellAgent({
        agent,
        event,
        db,
        projectRoot,
        abortSignal,
      });
    default:
      throw new Error(`Unsupported agent type`);
  }
};

export const makeAgentWorker = (
  db: DatabaseSync,
  projectRoot: string,
  cliBin: string,
) => {
  return (agent: AgentDef): Worker =>
    worker({
      id: agent.id,
      listen: agent.listen,
      ignoreSelf: agent.ignoreSelf,
      run: async (event, { abortSignal }) => {
        const exitCode = await runAgentWorker(
          db,
          agent,
          event,
          projectRoot,
          cliBin,
          abortSignal,
        );
        if (exitCode !== 0) {
          throw new Error(`Agent "${agent.id}" exited with code ${exitCode}`);
        }
      },
    });
};
