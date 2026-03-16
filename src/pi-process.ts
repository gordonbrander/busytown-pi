import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Event } from "./lib/event.ts";
import type {
  AgentDef,
  ClaudeAgentDef,
  PiAgentDef,
  ShellAgentDef,
} from "./agent.ts";
import { pushEvent } from "./event-queue.ts";
import { renderTemplate } from "./lib/template.ts";
import { renderMemoryBlocksPrompt } from "./memory.ts";
import * as Lines from "./lib/lines.ts";
import { type Agent, agent } from "./agent-system.ts";
import { logger } from "./lib/json-logger.ts";
import { lines, filterMap } from "./lib/stream.ts";
import { performAsync } from "./lib/result.ts";
import { parsePiLine } from "./lib/pi-stream.ts";
import { stderr } from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentExtensionPath = path.join(__dirname, "agent-extension.ts");

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

    const stdoutResult = performAsync(async () => {
      const events = filterMap(lines(child.stdout!), parsePiLine);
      for await (const message of events) {
        pushEvent(db, agent.id, `sys.agent.${agent.id}.message`, message);
      }
    });

    const stderrResult = performAsync(async () => {
      const stderrLines = lines(child.stderr!);
      for await (const msg of stderrLines) {
        pushEvent(db, agent.id, `sys.agent.${agent.id}.stderr`, { msg });
      }
    });

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
    child.on("close", async (code) => {
      await Promise.allSettled([stdoutResult, stderrResult]);
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

    const stdoutResult = performAsync(async () => {
      for await (const msg of lines(child.stdout!)) {
        pushEvent(db, agent.id, `sys.agent.${agent.id}.stdout`, { msg });
      }
    });

    const stderrResult = performAsync(async () => {
      for await (const msg of lines(child.stderr!)) {
        pushEvent(db, agent.id, `sys.agent.${agent.id}.stderr`, { msg });
      }
    });

    child.on("error", (err) => {
      logger.error("Shell agent failed to spawn", {
        agent: agent.id,
        event_id: event.id,
        error: err.message,
      });
      reject(err);
    });
    child.on("close", async (code) => {
      await Promise.allSettled([stdoutResult, stderrResult]);
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

const BUSYTOWN_CLI_GUIDE = (agentId: string): string =>
  Lines.join([
    "## Busytown event queue",
    "",
    `Use the Bash tool to interact with the event queue. Your agent ID is \`${agentId}\`.`,
    "",
    "Push an event:",
    `  busytown push --agent ${agentId} --type <event-type> [--payload '<json>']`,
    "",
    "List recent events:",
    "  busytown events [--type <filter>] [--tail <n>]",
    "",
    "Claim an event (prevents other agents from processing it):",
    `  busytown claim --agent ${agentId} --event <event-id>`,
    "",
    "Check who claimed an event:",
    "  busytown check-claim --event <event-id>",
    "",
    "Update a memory block:",
    `  busytown update-memory --agent ${agentId} --block <key> \\`,
    "    --new-text '<text>' [--old-text '<old-text>']",
  ]);

export const buildClaudeSystemPrompt = (agent: ClaudeAgentDef): string => {
  const memoryInstruction = `Use the Bash tool to update memory: busytown update-memory --agent ${agent.id} --block <key> --new-text '<text>' [--old-text '<old-text>']`;
  const memorySection = renderMemoryBlocksPrompt(
    agent.memoryBlocks,
    memoryInstruction,
  );
  return Lines.join(
    [agent.body, memorySection, "", BUSYTOWN_CLI_GUIDE(agent.id)].filter(
      Boolean,
    ),
  );
};

type RunClaudeAgentArgs = {
  agent: ClaudeAgentDef;
  event: Event;
  db: DatabaseSync;
  projectRoot: string;
  abortSignal?: AbortSignal;
};

export const runClaudeAgent = ({
  agent,
  event,
  db,
  projectRoot,
  abortSignal,
}: RunClaudeAgentArgs): Promise<number> => {
  const systemPrompt = buildClaudeSystemPrompt(agent);

  const args = [
    "--print",
    "--system-prompt",
    systemPrompt,
    "--output-format",
    "text",
  ];

  if (agent.tools.length > 0) {
    args.push("--allowedTools", ...agent.tools);
  }

  if (agent.model) {
    args.push("--model", agent.model);
  }

  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      resolve(1);
      return;
    }

    const child = spawn("claude", args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const stdoutResult = performAsync(async () => {
      for await (const msg of lines(child.stdout!)) {
        pushEvent(db, agent.id, `sys.agent.${agent.id}.stdout`, { msg });
      }
    });

    const stderrResult = performAsync(async () => {
      for await (const msg of lines(child.stderr!)) {
        pushEvent(db, agent.id, `sys.agent.${agent.id}.stderr`, { msg });
      }
    });

    // Write event JSON as the user prompt on stdin
    child.stdin?.write(JSON.stringify(event));
    child.stdin?.end();

    child.on("error", (err) => {
      logger.error("Claude agent failed to spawn", {
        agent: agent.id,
        event_id: event.id,
        error: err.message,
      });
      reject(err);
    });
    child.on("close", async (code) => {
      await Promise.allSettled([stdoutResult, stderrResult]);
      abortSignal?.removeEventListener("abort", onAbort);
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        logger.warn("Claude agent exited with non-zero code", {
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
    case "claude":
      return await runClaudeAgent({
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
