import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { virtualAgentHandler } from "./virtual-agent.ts";
import { clientOf } from "./sdk.ts";
import type { Event } from "./lib/event.ts";
import type { AgentHandlerExtra } from "./agent-handler.ts";
import type { ShellAgentDef } from "./file-agent-loader.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const createTempDbPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "virtual-agent-test-"));
  return path.join(dir, "events.db");
};

const baseConfig = (
  overrides: Partial<ShellAgentDef & AgentHandlerExtra> = {},
): ShellAgentDef & AgentHandlerExtra => ({
  id: "test-virtual",
  filePath: "/tmp/test.md",
  type: "shell" as const,
  description: "test",
  listen: ["test.*"],
  ignoreSelf: true,
  emits: [],
  body: "",
  memoryBlocks: {},
  pollInterval: 10,
  ...overrides,
});

describe("virtualAgentHandler", () => {
  it("calls handler for each matching event", { timeout: 5000 }, async () => {
    const dbPath = createTempDbPath();
    const ac = new AbortController();
    const trigger = clientOf({ id: "trigger", dbPath });
    const agentClient = clientOf({ id: "test-virtual", dbPath });

    const received: Event[] = [];
    const handler = virtualAgentHandler((_client, event) => {
      received.push(event);
    });

    trigger.publish("test.hello", { msg: "hi" });

    handler(agentClient, baseConfig({ signal: ac.signal }));

    // Poll until the handler processes the event
    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.length >= 1) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    ac.abort();

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "test.hello");
    assert.deepEqual(received[0].payload, { msg: "hi" });
  });

  it("handler can publish events via client", { timeout: 5000 }, async () => {
    const dbPath = createTempDbPath();
    const ac = new AbortController();
    const trigger = clientOf({ id: "trigger", dbPath });
    const agentClient = clientOf({ id: "test-virtual", dbPath });
    const watcher = clientOf({ id: "watcher", dbPath });

    const handler = virtualAgentHandler((client, event) => {
      client.publish("test.reply", { original: event.type });
    });

    trigger.publish("test.ping", {});

    handler(agentClient, baseConfig({ signal: ac.signal }));

    for await (const event of watcher.subscribe({
      listen: ["test.reply"],
      pollInterval: 10,
      signal: ac.signal,
    })) {
      assert.equal(event.type, "test.reply");
      assert.deepEqual(event.payload, { original: "test.ping" });
      break;
    }

    ac.abort();
  });
});
