import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncate } from "./truncate.ts";

describe("truncate", () => {
  it("returns text unchanged when under limit", () => {
    const result = truncate("hello", 10);
    assert.equal(result.text, "hello");
    assert.equal(result.truncated, false);
  });

  it("returns text unchanged when exactly at limit", () => {
    const result = truncate("12345", 5);
    assert.equal(result.text, "12345");
    assert.equal(result.truncated, false);
  });

  it("truncates with ellipsis when over limit", () => {
    const result = truncate("hello world", 6);
    assert.equal(result.text, "hello…");
    assert.equal(result.truncated, true);
  });

  it("trims trailing whitespace before ellipsis", () => {
    const result = truncate("hello world", 7);
    assert.equal(result.text, "hello…");
    assert.equal(result.truncated, true);
  });

  it("supports custom ellipsis string", () => {
    const result = truncate("hello world", 8, "...");
    assert.equal(result.text, "hello...");
    assert.equal(result.truncated, true);
  });

  it("returns empty string when maxLength is too small for ellipsis", () => {
    const result = truncate("hello", 1);
    assert.equal(result.text, "");
    assert.equal(result.truncated, true);
  });

  it("returns empty string when maxLength is 0", () => {
    const result = truncate("hello", 0);
    assert.equal(result.text, "");
    assert.equal(result.truncated, true);
  });

  it("handles empty input string", () => {
    const result = truncate("", 5);
    assert.equal(result.text, "");
    assert.equal(result.truncated, false);
  });

  it("handles maxLength of 2 with default ellipsis", () => {
    const result = truncate("hello", 2);
    assert.equal(result.text, "h…");
    assert.equal(result.truncated, true);
  });
});
