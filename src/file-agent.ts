#!/usr/bin/env -S node --experimental-strip-types
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientOf } from "./sdk.ts";
import { loadAgentDef } from "./file-agent-loader.ts";
import { buildAgentAppendPrompt } from "./pi-agent-shared.ts";
import { shellAgentHandler } from "./shell-agent.ts";
import { piAgentHandler } from "./pi-agent.ts";
import { piRpcAgentHandler } from "./pi-rpc-agent.ts";
import type { AgentHandler } from "./agent-handler.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_EXTENSION_PATH = path.join(MODULE_DIR, "pi-agent-extension.ts");

const handlers: Record<string, AgentHandler> = {
  shell: shellAgentHandler,
  pi: piAgentHandler,
  "pi-rpc": piRpcAgentHandler,
};

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    db: { type: "string", default: ".pi/busytown/events.db" },
    poll: { type: "string", default: "1000" },
  },
});

if (!values.agent) {
  console.error("Usage: file-agent --agent <path> [--db <path>] [--poll <ms>]");
  process.exit(1);
}

const cwd = process.cwd();
const agentDef = loadAgentDef(values.agent, cwd);
const dbPath = values.db!;
const pollInterval = Number(values.poll);

const handler = handlers[agentDef.type];
if (!handler) {
  console.error(`Unknown agent type: ${agentDef.type}`);
  process.exit(1);
}

const client = clientOf({
  id: agentDef.id,
  dbPath,
});

// Build Pi-specific config
const system = buildAgentAppendPrompt(agentDef);
const env: Record<string, string> = {
  BUSYTOWN_DB_PATH: dbPath,
  BUSYTOWN_AGENT_ID: agentDef.id,
  BUSYTOWN_AGENT_FILE: values.agent,
};

await handler(client, {
  ...agentDef,
  pollInterval,
  cwd,
  env,
  extensions: [AGENT_EXTENSION_PATH],
  system,
});
