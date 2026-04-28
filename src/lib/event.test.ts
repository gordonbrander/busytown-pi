import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eventMatches, type Event } from "./event.ts";

const makeEvent = (type: string): Event => ({
  id: 1,
  timestamp: 0,
  type,
  agent_id: "test",
  depth: 0,
  payload: {},
});

describe("eventMatches", () => {
  it("matches exact type", () => {
    assert.equal(
      eventMatches(makeEvent("plan.request"), ["plan.request"]),
      true,
    );
  });

  it("does not match different type", () => {
    assert.equal(
      eventMatches(makeEvent("plan.request"), ["code.request"]),
      false,
    );
  });

  it("matches wildcard *", () => {
    assert.equal(eventMatches(makeEvent("anything"), ["*"]), true);
  });

  it("matches prefix wildcard plan.*", () => {
    assert.equal(eventMatches(makeEvent("plan.request"), ["plan.*"]), true);
    assert.equal(eventMatches(makeEvent("plan.complete"), ["plan.*"]), true);
  });

  it("does not match prefix wildcard for different prefix", () => {
    assert.equal(eventMatches(makeEvent("code.request"), ["plan.*"]), false);
  });

  it("matches if any pattern matches", () => {
    assert.equal(
      eventMatches(makeEvent("code.request"), ["plan.*", "code.request"]),
      true,
    );
  });

  it("returns false for empty listen array", () => {
    assert.equal(eventMatches(makeEvent("anything"), []), false);
  });

  it("prefix wildcard requires dot prefix", () => {
    // "plan.*" should match "plan.foo" but not "planning"
    assert.equal(eventMatches(makeEvent("planning"), ["plan.*"]), false);
  });
});
