import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellSplit } from "./shell-split.ts";

describe("shellSplit", () => {
  it("splits a simple string into tokens", () => {
    assert.deepEqual(shellSplit("foo bar baz"), ["foo", "bar", "baz"]);
  });

  it("returns [] for an empty string", () => {
    assert.deepEqual(shellSplit(""), []);
  });

  it("returns [] for whitespace-only input", () => {
    assert.deepEqual(shellSplit("   "), []);
  });

  it("trims leading and trailing whitespace", () => {
    assert.deepEqual(shellSplit("  hello  "), ["hello"]);
  });

  it("collapses multiple spaces between tokens", () => {
    assert.deepEqual(shellSplit("a   b    c"), ["a", "b", "c"]);
  });

  it("handles tabs and mixed whitespace", () => {
    assert.deepEqual(shellSplit("a\tb\t\tc"), ["a", "b", "c"]);
  });

  it("handles a single token", () => {
    assert.deepEqual(shellSplit("push"), ["push"]);
  });

  it("handles newlines as whitespace", () => {
    assert.deepEqual(shellSplit("a\nb\nc"), ["a", "b", "c"]);
  });
});
