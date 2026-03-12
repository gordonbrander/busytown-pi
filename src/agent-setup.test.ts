import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentSystemPrompt, resolveAgentModel } from "./agent-setup.ts";
import type { AgentDef } from "./agent.ts";

describe("buildAgentSystemPrompt", () => {
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

  it("combines base prompt, agent identity, body, and memory", () => {
    const agent = makeAgent({
      memoryBlocks: {
        notes: {
          description: "Agent notes",
          value: "some notes",
          charLimit: 500,
        },
      },
    });
    const result = buildAgentSystemPrompt("Base system prompt.", agent);
    assert.ok(result.includes("Base system prompt."));
    assert.ok(result.includes('You are the "test-agent" agent.'));
    assert.ok(result.includes("A test agent"));
    assert.ok(result.includes("You do test things."));
    assert.ok(result.includes("some notes"));
    assert.ok(result.includes("<memory_blocks>"));
  });

  it("omits memory section when no memory blocks", () => {
    const agent = makeAgent();
    const result = buildAgentSystemPrompt("Base.", agent);
    assert.ok(result.includes("Base."));
    assert.ok(result.includes("You do test things."));
    assert.ok(!result.includes("<memory_blocks>"));
  });
});

describe("resolveAgentModel", () => {
  // Create a minimal mock ModelRegistry
  const makeRegistry = (
    models: Array<{ id: string; name?: string; provider: string }>,
  ) => ({
    getAvailable: () => models,
  });

  it("returns exact match by id (case-insensitive)", () => {
    const registry = makeRegistry([
      { id: "claude-sonnet-4-20250514", provider: "anthropic" },
      { id: "gpt-4o", provider: "openai" },
    ]);
    const result = resolveAgentModel(
      "claude-sonnet-4-20250514",
      registry as any,
    );
    assert.equal(result?.id, "claude-sonnet-4-20250514");
  });

  it("returns partial match on id", () => {
    const registry = makeRegistry([
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude 4 Sonnet",
        provider: "anthropic",
      },
      {
        id: "claude-opus-4-20250514",
        name: "Claude 4 Opus",
        provider: "anthropic",
      },
    ]);
    const result = resolveAgentModel("sonnet", registry as any);
    assert.equal(result?.id, "claude-sonnet-4-20250514");
  });

  it("prefers alias over dated version", () => {
    const registry = makeRegistry([
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude 4 Sonnet (dated)",
        provider: "anthropic",
      },
      { id: "claude-sonnet-4", name: "Claude 4 Sonnet", provider: "anthropic" },
    ]);
    const result = resolveAgentModel("sonnet", registry as any);
    assert.equal(result?.id, "claude-sonnet-4");
  });

  it("returns undefined when no match", () => {
    const registry = makeRegistry([{ id: "gpt-4o", provider: "openai" }]);
    const result = resolveAgentModel("sonnet", registry as any);
    assert.equal(result, undefined);
  });

  it("matches on name field", () => {
    const registry = makeRegistry([
      {
        id: "some-model-id",
        name: "Claude Sonnet Special",
        provider: "anthropic",
      },
    ]);
    const result = resolveAgentModel("sonnet", registry as any);
    assert.equal(result?.id, "some-model-id");
  });
});
