import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellAgentHandler } from "./shell-agent.ts";
import { clientOf } from "../sdk.ts";
import type { ShellAgentDef } from "./file-agent-loader.ts";
import type { AgentHandlerExtra } from "./agent-handler.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const createTempDbPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-agent-test-"));
  return path.join(dir, "events.db");
};

const handlerConfig = (
  body: string,
  overrides: Partial<ShellAgentDef & AgentHandlerExtra> = {},
): ShellAgentDef & AgentHandlerExtra => ({
  id: "test-shell",
  filePath: "/tmp/test.md",
  type: "shell",
  description: "test",
  listen: ["test.*"],
  ignoreSelf: true,
  emits: [],
  body,
  memoryBlocks: {},
  pollInterval: 10,
  ...overrides,
});

describe("shellAgentHandler", () => {
  it("sends stdout lines as output events", { timeout: 5000 }, async () => {
    const dbPath = createTempDbPath();
    const ac = new AbortController();
    const trigger = clientOf({ id: "trigger", dbPath });
    const agentClient = clientOf({ id: "test-shell", dbPath });
    const watcher = clientOf({ id: "watcher", dbPath });

    trigger.publish("test.run", {});

    shellAgentHandler(
      agentClient,
      handlerConfig('echo "line one" && echo "line two"', {
        signal: ac.signal,
      }),
    );

    const collected: { type: string; payload: unknown }[] = [];
    for await (const event of watcher.subscribe({
      listen: ["agent.test-shell.*"],
      pollInterval: 10,
      signal: ac.signal,
    })) {
      collected.push({ type: event.type, payload: event.payload });
      if (event.type === "agent.test-shell.end") break;
    }

    ac.abort();

    const types = collected.map((e) => e.type);
    assert.ok(types.includes("agent.test-shell.start"));
    assert.ok(types.includes("agent.test-shell.end"));

    const outputs = collected.filter(
      (e) => e.type === "agent.test-shell.output",
    );
    assert.equal(outputs.length, 2);
    assert.deepEqual(outputs[0].payload, { line: "line one" });
    assert.deepEqual(outputs[1].payload, { line: "line two" });
  });

  it(
    "templates event fields into the shell script",
    { timeout: 5000 },
    async () => {
      const dbPath = createTempDbPath();
      const ac = new AbortController();
      const trigger = clientOf({ id: "trigger", dbPath });
      const agentClient = clientOf({ id: "test-shell", dbPath });
      const watcher = clientOf({ id: "watcher", dbPath });

      trigger.publish("test.hello", {});

      shellAgentHandler(
        agentClient,
        handlerConfig("echo {{event.type}}", { signal: ac.signal }),
      );

      for await (const event of watcher.subscribe({
        listen: ["agent.test-shell.output"],
        pollInterval: 10,
        signal: ac.signal,
      })) {
        assert.deepEqual(event.payload, { line: "test.hello" });
        break;
      }

      ac.abort();
    },
  );

  it(
    "sends an error event on non-zero exit code",
    { timeout: 5000 },
    async () => {
      const dbPath = createTempDbPath();
      const ac = new AbortController();
      const trigger = clientOf({ id: "trigger", dbPath });
      const agentClient = clientOf({ id: "test-shell", dbPath });
      const watcher = clientOf({ id: "watcher", dbPath });

      trigger.publish("test.fail", {});

      shellAgentHandler(
        agentClient,
        handlerConfig("echo before && exit 1", { signal: ac.signal }),
      );

      const collected: { type: string; payload: unknown }[] = [];
      for await (const event of watcher.subscribe({
        listen: ["agent.test-shell.*"],
        pollInterval: 10,
        signal: ac.signal,
      })) {
        collected.push({ type: event.type, payload: event.payload });
        if (
          event.type === "agent.test-shell.error" ||
          event.type === "agent.test-shell.end"
        )
          break;
      }

      ac.abort();

      const errors = collected.filter(
        (e) => e.type === "agent.test-shell.error",
      );
      assert.equal(errors.length, 1);
      assert.equal((errors[0].payload as { code: number }).code, 1);

      const ends = collected.filter((e) => e.type === "agent.test-shell.end");
      assert.equal(ends.length, 0);
    },
  );
});
