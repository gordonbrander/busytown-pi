import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyMemoryUpdate,
  hydrateMemoryBlocks,
  memoryBlockPath,
  parseMemoryBlockEntries,
  readMemoryBlockValue,
  writeMemoryBlockValue,
  renderMemoryBlockEntry,
  renderMemoryBlocksPrompt,
} from "./memory.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busytown-memory-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseMemoryBlockEntries", () => {
  it("applies defaults for missing fields", () => {
    const entries = parseMemoryBlockEntries({ notes: {} });
    assert.deepEqual(entries.notes, {
      description: "",
      char_limit: 2000,
    });
  });

  it("returns empty record for non-object input", () => {
    assert.deepEqual(parseMemoryBlockEntries(undefined), {});
    assert.deepEqual(parseMemoryBlockEntries(null), {});
  });

  it("parses provided values", () => {
    const entries = parseMemoryBlockEntries({
      agent: { description: "Agent notes", char_limit: 1000 },
    });
    assert.deepEqual(entries.agent, {
      description: "Agent notes",
      char_limit: 1000,
    });
  });
});

describe("memoryBlockPath", () => {
  it("returns the expected path", () => {
    const result = memoryBlockPath("/project", "my-agent", "notes");
    assert.equal(
      result,
      path.join(
        "/project",
        ".pi",
        "busytown",
        "memory_blocks",
        "my-agent",
        "notes.md",
      ),
    );
  });
});

describe("readMemoryBlockValue / writeMemoryBlockValue", () => {
  it("returns empty string when file does not exist", () => {
    assert.equal(readMemoryBlockValue(tmpDir, "agent", "notes"), "");
  });

  it("writes and reads back a value", () => {
    writeMemoryBlockValue(tmpDir, "agent", "notes", "hello world");
    assert.equal(readMemoryBlockValue(tmpDir, "agent", "notes"), "hello world");
  });

  it("overwrites existing value", () => {
    writeMemoryBlockValue(tmpDir, "agent", "notes", "first");
    writeMemoryBlockValue(tmpDir, "agent", "notes", "second");
    assert.equal(readMemoryBlockValue(tmpDir, "agent", "notes"), "second");
  });
});

describe("hydrateMemoryBlocks", () => {
  it("reads values from disk into blocks", () => {
    writeMemoryBlockValue(tmpDir, "agent", "notes", "some data");
    const blocks = hydrateMemoryBlocks(tmpDir, "agent", {
      notes: { description: "Agent notes", char_limit: 1000 },
    });
    assert.equal(blocks.notes.value, "some data");
    assert.equal(blocks.notes.description, "Agent notes");
    assert.equal(blocks.notes.charLimit, 1000);
  });

  it("returns empty value when no file exists", () => {
    const blocks = hydrateMemoryBlocks(tmpDir, "agent", {
      notes: { description: "Agent notes", char_limit: 1000 },
    });
    assert.equal(blocks.notes.value, "");
  });
});

describe("applyMemoryUpdate", () => {
  it("replaces old text with new text", () => {
    const result = applyMemoryUpdate("hello world", 2000, "universe", "world");
    assert.equal(result.text, "hello universe");
    assert.equal(result.truncated, false);
  });

  it("throws when old text is not found", () => {
    assert.throws(
      () => applyMemoryUpdate("hello world", 2000, "universe", "missing"),
      /oldText not found/,
    );
  });

  it("appends when oldText is undefined", () => {
    const result = applyMemoryUpdate("line one", 2000, "line two");
    assert.equal(result.text, "line one\nline two");
    assert.equal(result.truncated, false);
  });

  it("appends to empty string without leading newline", () => {
    const result = applyMemoryUpdate("", 2000, "first entry");
    assert.equal(result.text, "first entry");
    assert.equal(result.truncated, false);
  });

  it("truncates when exceeding char limit", () => {
    const result = applyMemoryUpdate("", 10, "this is way too long");
    assert.equal(result.text, "this is w…");
    assert.equal(result.truncated, true);
  });

  it("truncates after replace", () => {
    const result = applyMemoryUpdate("ab", 5, "xyz123", "ab");
    assert.equal(result.text, "xyz1…");
    assert.equal(result.truncated, true);
  });

  it("does not truncate at exactly the limit", () => {
    const result = applyMemoryUpdate("", 5, "12345");
    assert.equal(result.text, "12345");
    assert.equal(result.truncated, false);
  });
});

describe("renderMemoryBlockEntry", () => {
  it("renders a memory block with description and value", () => {
    const output = renderMemoryBlockEntry("agent", {
      description: "Agent notes",
      value: "some data",
      charLimit: 2000,
    });
    assert.ok(output.includes("<agent>"));
    assert.ok(output.includes("</agent>"));
    assert.ok(output.includes("<description>Agent notes</description>"));
    assert.ok(output.includes("char_count: 9"));
    assert.ok(output.includes("char_limit: 2000"));
    assert.ok(output.includes("<value>some data</value>"));
  });

  it("renders description tag even when description is empty", () => {
    const output = renderMemoryBlockEntry("notes", {
      description: "",
      value: "",
      charLimit: 1000,
    });
    assert.ok(output.includes("<description></description>"));
    assert.ok(output.includes("char_count: 0"));
  });
});

describe("renderMemoryBlocksPrompt", () => {
  it("returns empty string when no blocks", () => {
    assert.equal(renderMemoryBlocksPrompt({}), "");
  });

  it("renders full memory blocks section", () => {
    const output = renderMemoryBlocksPrompt({
      agent: {
        description: "Agent memory",
        value: "hello",
        charLimit: 2000,
      },
      project: {
        description: "Project facts",
        value: "",
        charLimit: 1000,
      },
    });
    assert.ok(output.includes("## Memory"));
    assert.ok(output.includes("<memory_blocks>"));
    assert.ok(output.includes("</memory_blocks>"));
    assert.ok(output.includes("<agent>"));
    assert.ok(output.includes("</agent>"));
    assert.ok(output.includes("<project>"));
    assert.ok(output.includes("</project>"));
    assert.ok(output.includes("updateMemory"));
  });

  it("uses custom updateInstruction when provided", () => {
    const customInstruction =
      "Use busytown update-memory --agent foo --block bar --new-text '<text>'";
    const output = renderMemoryBlocksPrompt(
      {
        agent: {
          description: "Agent memory",
          value: "hello",
          charLimit: 2000,
        },
      },
      customInstruction,
    );
    assert.ok(output.includes(customInstruction));
    assert.ok(!output.includes("updateMemory tool"));
  });
});
