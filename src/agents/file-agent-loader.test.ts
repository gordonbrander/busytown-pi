import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadAgentDef, isHookName, parseHooks } from "./file-agent-loader.ts";
import { writeMemoryBlockValue } from "../memory/memory.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busytown-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeAgent = (name: string, content: string): string => {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

describe("loadAgentDef", () => {
  it("loads a pi agent with all frontmatter fields", () => {
    const filePath = writeAgent(
      "planner.md",
      `---
name: planner
type: pi
description: Plans tasks
listen:
  - plan.request
ignore_self: false
emits:
  - plan.complete
tools:
  - read
  - bash
model: claude-sonnet
---
You are a planner agent.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.id, "planner");
    assert.equal(agent.type, "pi");
    assert.equal(agent.description, "Plans tasks");
    assert.deepEqual(agent.listen, ["plan.request"]);
    assert.equal(agent.ignoreSelf, false);
    assert.deepEqual(agent.emits, ["plan.complete"]);
    assert.equal(agent.type === "pi" && agent.model, "claude-sonnet");
    if (agent.type === "pi") {
      assert.deepEqual(agent.tools, ["read", "bash"]);
      assert.equal(agent.body, "You are a planner agent.");
    }
  });

  it("loads a shell agent", () => {
    const filePath = writeAgent(
      "notifier.md",
      `---
type: shell
listen:
  - task.complete
---
echo "Task done: {{event.type}}"
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.type, "shell");
    assert.deepEqual(agent.listen, ["task.complete"]);
  });

  it("derives id from filename when name not specified", () => {
    const filePath = writeAgent(
      "my-cool-agent.md",
      `---
listen:
  - "*"
---
Do stuff.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.id, "my-cool-agent");
  });

  it("defaults to pi type", () => {
    const filePath = writeAgent(
      "default.md",
      `---
listen: []
---
Default agent.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.type, "pi");
  });

  it("defaults ignoreSelf to true", () => {
    const filePath = writeAgent(
      "default.md",
      `---
listen: []
---
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.ignoreSelf, true);
  });

  it("handles tools as array", () => {
    const filePath = writeAgent(
      "tools-array.md",
      `---
tools:
  - read
  - bash
  - edit
listen: []
---
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    if (agent.type === "pi") {
      assert.deepEqual(agent.tools, ["read", "bash", "edit"]);
    }
  });
});

describe("memory_blocks", () => {
  it("hydrates memory blocks with empty values when no files on disk", () => {
    const filePath = writeAgent(
      "with-memory.md",
      `---
listen:
  - "*"
memory_blocks:
  agent:
    description: Agent notes
    char_limit: 1000
---
Hello
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.deepEqual(agent.memoryBlocks, {
      agent: { description: "Agent notes", charLimit: 1000, value: "" },
    });
  });

  it("hydrates memory block values from disk", () => {
    const filePath = writeAgent(
      "with-memory.md",
      `---
listen:
  - "*"
memory_blocks:
  agent:
    description: Agent notes
    char_limit: 1000
  project:
    description: Project facts
---
Hello
`,
    );

    writeMemoryBlockValue(tmpDir, "with-memory", "agent", "some data");

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.deepEqual(agent.memoryBlocks, {
      agent: {
        description: "Agent notes",
        value: "some data",
        charLimit: 1000,
      },
      project: {
        description: "Project facts",
        value: "",
        charLimit: 2000,
      },
    });
  });

  it("defaults to empty memoryBlocks when not specified", () => {
    const filePath = writeAgent(
      "no-memory.md",
      `---
listen: []
---
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.deepEqual(agent.memoryBlocks, {});
  });
});

describe("hooks", () => {
  it("parses hooks frontmatter into hooks on PiAgentDef", () => {
    const filePath = writeAgent(
      "hooked.md",
      `---
listen:
  - "*"
hooks:
  session_start: echo session started
  turn_start: echo turn {{{turnIndex}}}
  tool_call: echo tool {{{toolName}}}
---
Agent with hooks.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.type, "pi");
    if (agent.type === "pi") {
      assert.equal(agent.hooks.session_start, "echo session started");
      assert.equal(agent.hooks.turn_start, "echo turn {{{turnIndex}}}");
      assert.equal(agent.hooks.tool_call, "echo tool {{{toolName}}}");
      assert.equal(agent.hooks.agent_end, undefined);
    }
  });

  it("handles multiline hook values", () => {
    const filePath = writeAgent(
      "multiline-hook.md",
      `---
listen: []
hooks:
  before_agent_start: |
    echo "step 1"
    echo "step 2"
---
Multi-line hooks.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    if (agent.type === "pi") {
      assert.ok(agent.hooks.before_agent_start?.includes("step 1"));
      assert.ok(agent.hooks.before_agent_start?.includes("step 2"));
    }
  });

  it("returns empty hooks for agents without on_* keys", () => {
    const filePath = writeAgent(
      "no-hooks.md",
      `---
listen: []
---
No hooks here.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    if (agent.type === "pi") {
      assert.deepEqual(agent.hooks, {});
    }
  });

  it("skips null/missing hook values", () => {
    const filePath = writeAgent(
      "null-hook.md",
      `---
listen: []
hooks:
  session_start: echo hello
  agent_end:
---
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    if (agent.type === "pi") {
      assert.equal(agent.hooks.session_start, "echo hello");
      // agent_end with no value is parsed as null by yaml, should be skipped
      assert.equal(agent.hooks.agent_end, undefined);
    }
  });

  it("shell agents do not have hooks", () => {
    const filePath = writeAgent(
      "shell-no-hooks.md",
      `---
type: shell
listen: []
hooks:
  session_start: echo nope
---
echo hi
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.type, "shell");
    assert.equal("hooks" in agent, false);
  });
});

describe("parseHooks", () => {
  it("extracts valid hook names from a record", () => {
    const hooks = parseHooks({
      session_start: "echo start",
      turn_end: "echo end",
    });
    assert.deepEqual(hooks, {
      session_start: "echo start",
      turn_end: "echo end",
    });
  });

  it("filters out invalid hook names", () => {
    const hooks = parseHooks({
      session_start: "echo start",
      not_a_hook: "echo nope",
      on_turn_end: "echo prefixed",
    });
    assert.deepEqual(hooks, { session_start: "echo start" });
  });

  it("strips null and non-string values", () => {
    const hooks = parseHooks({
      session_start: "echo start",
      agent_end: null,
      turn_start: 42,
      tool_call: undefined,
    });
    assert.deepEqual(hooks, { session_start: "echo start" });
  });

  it("returns empty hooks for undefined input", () => {
    assert.deepEqual(parseHooks(undefined), {});
  });

  it("returns empty hooks for null input", () => {
    assert.deepEqual(parseHooks(null), {});
  });

  it("returns empty hooks for non-object input", () => {
    assert.deepEqual(parseHooks("not an object"), {});
  });
});

describe("isHookName", () => {
  it("returns true for valid hook names", () => {
    assert.equal(isHookName("session_start"), true);
    assert.equal(isHookName("before_agent_start"), true);
    assert.equal(isHookName("tool_call"), true);
    assert.equal(isHookName("model_select"), true);
  });

  it("returns false for invalid hook names", () => {
    assert.equal(isHookName("not_a_hook"), false);
    assert.equal(isHookName("on_session_start"), false);
    assert.equal(isHookName(""), false);
  });
});

describe("claude agent", () => {
  it("loads a claude agent with all frontmatter fields", () => {
    const filePath = writeAgent(
      "coder.md",
      `---
type: claude
description: Writes code
listen:
  - code.request
emits:
  - code.complete
tools:
  - Bash
  - Read
  - Write
model: claude-opus-4-5
---
You are a coding agent.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.type, "claude");
    assert.equal(agent.id, "coder");
    assert.equal(agent.description, "Writes code");
    assert.deepEqual(agent.listen, ["code.request"]);
    assert.deepEqual(agent.emits, ["code.complete"]);
    if (agent.type === "claude") {
      assert.deepEqual(agent.tools, ["Bash", "Read", "Write"]);
      assert.equal(agent.model, "claude-opus-4-5");
      assert.equal(agent.body, "You are a coding agent.");
    }
  });

  it("defaults tools to empty array for claude agent", () => {
    const filePath = writeAgent(
      "no-tools.md",
      `---
type: claude
listen:
  - "*"
---
No tools agent.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.type, "claude");
    if (agent.type === "claude") {
      assert.deepEqual(agent.tools, []);
    }
  });

  it("claude agent does not have hooks", () => {
    const filePath = writeAgent(
      "claude-no-hooks.md",
      `---
type: claude
listen: []
hooks:
  session_start: echo nope
---
Claude agent.
`,
    );

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.type, "claude");
    assert.equal("hooks" in agent, false);
  });

  it("claude agent loads memory_blocks", () => {
    const filePath = writeAgent(
      "claude-memory.md",
      `---
type: claude
listen:
  - "*"
memory_blocks:
  context:
    description: Project context
    char_limit: 1000
---
Agent with memory.
`,
    );

    writeMemoryBlockValue(tmpDir, "claude-memory", "context", "some context");

    const agent = loadAgentDef(filePath, { cwd: tmpDir });
    assert.equal(agent.type, "claude");
    assert.deepEqual(agent.memoryBlocks, {
      context: {
        description: "Project context",
        value: "some context",
        charLimit: 1000,
      },
    });
  });
});
