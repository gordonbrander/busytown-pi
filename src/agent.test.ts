import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadAgentDef, loadAllAgents, updateAgentFile } from "./agent.ts";

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
tools: read,bash
model: claude-sonnet
---
You are a planner agent.
`,
    );

    const agent = loadAgentDef(filePath);
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

    const agent = loadAgentDef(filePath);
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

    const agent = loadAgentDef(filePath);
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

    const agent = loadAgentDef(filePath);
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

    const agent = loadAgentDef(filePath);
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

    const agent = loadAgentDef(filePath);
    if (agent.type === "pi") {
      assert.deepEqual(agent.tools, ["read", "bash", "edit"]);
    }
  });
});

describe("memory_blocks", () => {
  it("loads an agent with memory_blocks", () => {
    const filePath = writeAgent(
      "with-memory.md",
      `---
listen:
  - "*"
memory_blocks:
  agent:
    description: Agent notes
    value: some data
    char_limit: 1000
  project:
    description: Project facts
---
Hello
`,
    );

    const agent = loadAgentDef(filePath);
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

    const agent = loadAgentDef(filePath);
    assert.deepEqual(agent.memoryBlocks, {});
  });

  it("applies defaults for missing fields", () => {
    const filePath = writeAgent(
      "partial-memory.md",
      `---
listen: []
memory_blocks:
  notes: {}
---
`,
    );

    const agent = loadAgentDef(filePath);
    assert.deepEqual(agent.memoryBlocks.notes, {
      description: "",
      value: "",
      charLimit: 2000,
    });
  });
});

describe("updateAgentFile", () => {
  it("rewrites frontmatter while preserving body", () => {
    const filePath = writeAgent(
      "update-test.md",
      `---
listen:
  - "*"
memory_blocks:
  agent:
    description: Agent notes
    value: old value
    char_limit: 2000
---
Body content here.
`,
    );

    updateAgentFile(filePath, (fm) => {
      const mb = fm.memory_blocks as Record<string, { value?: string }>;
      mb.agent!.value = "new value";
      return { ...fm, memory_blocks: mb };
    });

    const updated = loadAgentDef(filePath);
    assert.equal(updated.memoryBlocks.agent.value, "new value");
    assert.ok(updated.body.includes("Body content here."));
  });
});

describe("loadAllAgents", () => {
  it("loads all .md files from directory", () => {
    writeAgent(
      "agent-a.md",
      `---
listen:
  - a.*
---
Agent A
`,
    );
    writeAgent(
      "agent-b.md",
      `---
listen:
  - b.*
---
Agent B
`,
    );
    // Non-md file should be ignored
    writeAgent("readme.txt", "not an agent");

    const agents = loadAllAgents(tmpDir);
    assert.equal(agents.length, 2);
    const ids = agents.map((a) => a.id).sort();
    assert.deepEqual(ids, ["agent-a", "agent-b"]);
  });

  it("returns empty array for nonexistent directory", () => {
    const agents = loadAllAgents(path.join(tmpDir, "nonexistent"));
    assert.deepEqual(agents, []);
  });

  it("skips agents that fail to load", () => {
    writeAgent(
      "good.md",
      `---
listen:
  - "*"
---
Good agent
`,
    );
    // Create a subdirectory (not a file) — will be skipped
    fs.mkdirSync(path.join(tmpDir, "subdir.md"));

    const agents = loadAllAgents(tmpDir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "good");
  });
});
