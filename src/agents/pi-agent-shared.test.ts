import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentAppendPrompt, guessProvider } from "./pi-agent-shared.ts";
import type { AgentDef } from "./file-agent-loader.ts";

describe("buildAgentAppendPrompt", () => {
  const makeAgent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
    id: "test-agent",
    filePath: "/tmp/test-agent.md",
    type: "pi",
    description: "A test agent",
    listen: [],
    ignoreSelf: true,
    emits: [],
    tools: [],
    body: "You do test things.",
    memoryBlocks: {},
    hooks: {},
    ...overrides,
  });

  it("includes agent identity, body, and memory", () => {
    const agent = makeAgent({
      memoryBlocks: {
        notes: {
          description: "Agent notes",
          value: "some notes",
          charLimit: 500,
        },
      },
    });
    const result = buildAgentAppendPrompt(agent);
    assert.ok(result.includes('You are the "test-agent" agent.'));
    assert.ok(result.includes("A test agent"));
    assert.ok(result.includes("You do test things."));
    assert.ok(result.includes("some notes"));
    assert.ok(result.includes("<memory_blocks>"));
  });

  it("omits memory section when no memory blocks", () => {
    const agent = makeAgent();
    const result = buildAgentAppendPrompt(agent);
    assert.ok(result.includes("You do test things."));
    assert.ok(!result.includes("<memory_blocks>"));
  });
});

describe("guessProvider", () => {
  it("returns anthropic for claude models", () => {
    assert.equal(guessProvider("claude-sonnet-4"), "anthropic");
    assert.equal(guessProvider("claude-opus-4"), "anthropic");
    assert.equal(guessProvider("claude-haiku-3-20240307"), "anthropic");
  });

  it("returns openai for gpt models", () => {
    assert.equal(guessProvider("gpt-4o"), "openai");
    assert.equal(guessProvider("gpt-4-turbo"), "openai");
  });

  it("returns openai for o-series models", () => {
    assert.equal(guessProvider("o1-preview"), "openai");
    assert.equal(guessProvider("o3-mini"), "openai");
  });

  it("returns undefined for unknown models", () => {
    assert.equal(guessProvider("gemini-pro"), undefined);
    assert.equal(guessProvider("mistral-large"), undefined);
  });
});
