#!/usr/bin/env -S node --experimental-strip-types
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientOf } from "../sdk.ts";
import { loadAgentDef } from "./file-agent-loader.ts";
import { buildAgentAppendPrompt } from "./pi-agent-shared.ts";
import { shellAgentHandler } from "./shell-agent.ts";
import { piAgentHandler } from "./pi-agent.ts";
import { piRpcAgentHandler } from "./pi-rpc-agent.ts";
import { loggerOf } from "../lib/json-logger.ts";
import { pathToSlug } from "../lib/slug.ts";
import { unwrap } from "../lib/option.ts";

const logger = loggerOf({ source: "file-agent.ts" });

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_EXTENSION_PATH = path.join(MODULE_DIR, "pi-agent-extension.ts");

const { values } = parseArgs({
  options: {
    id: { type: "string" },
    agent: { type: "string" },
    db: { type: "string", default: ".pi/busytown/events.db" },
    poll: { type: "string", default: "1000" },
    "parent-pid": { type: "string" },
  },
});

if (!values.agent) {
  console.error(
    "Usage: file-agent --agent <path> [--id <id>] [--db <path>] [--poll <ms>] [--parent-pid <pid>]",
  );
  process.exit(1);
}

const cwd = process.cwd();
const agentDef = loadAgentDef(values.agent, cwd);
// Override derived ID if explicit ID provided
if (values.id) {
  agentDef.id = values.id;
}
const dbPath = values.db!;
const pollInterval = Number(values.poll);
const parentPid = values["parent-pid"]
  ? Number(values["parent-pid"])
  : undefined;

const client = clientOf({
  id: agentDef.id,
  dbPath,
  parentPid,
});

// Build Pi-specific config
const system = buildAgentAppendPrompt(agentDef);
const env: Record<string, string> = {
  BUSYTOWN_DB_PATH: dbPath,
  BUSYTOWN_AGENT_ID: agentDef.id,
  BUSYTOWN_AGENT_FILE: values.agent,
};

try {
  switch (agentDef.type) {
    case "shell":
      await shellAgentHandler(client, {
        ...agentDef,
        env,
        pollInterval,
      });
      break;
    case "pi":
      await piAgentHandler(client, {
        ...agentDef,
        cwd,
        env,
        pollInterval,
        extensions: [AGENT_EXTENSION_PATH],
        system,
      });
      break;
    case "pi-rpc":
      await piRpcAgentHandler(client, {
        ...agentDef,
        cwd,
        env,
        pollInterval,
        extensions: [AGENT_EXTENSION_PATH],
        system,
      });
      break;
    case "claude":
      console.error(`Unsupported agent type: ${agentDef.type}`);
      process.exit(1);
  }
} catch (e) {
  logger.error("Agent exiting due to error", {
    id: agentDef.id,
    error: `${e}`,
  });
  process.exit(1);
}
