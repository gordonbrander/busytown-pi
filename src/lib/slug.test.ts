import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSlug, parseSlug, toSlug, pathToSlug } from "./slug.ts";

describe("isSlug", () => {
  it("accepts lowercase alphanumeric", () => {
    assert.equal(isSlug("hello"), true);
  });

  it("accepts lowercase with hyphens", () => {
    assert.equal(isSlug("hello-world"), true);
  });

  it("accepts single character", () => {
    assert.equal(isSlug("a"), true);
  });

  it("accepts numbers", () => {
    assert.equal(isSlug("abc123"), true);
  });

  it("rejects uppercase", () => {
    assert.equal(isSlug("Hello"), false);
  });

  it("rejects leading hyphen", () => {
    assert.equal(isSlug("-hello"), false);
  });

  it("rejects trailing hyphen", () => {
    assert.equal(isSlug("hello-"), false);
  });

  it("rejects consecutive hyphens", () => {
    assert.equal(isSlug("hello--world"), false);
  });

  it("rejects spaces", () => {
    assert.equal(isSlug("hello world"), false);
  });

  it("accepts underscores", () => {
    assert.equal(isSlug("hello_world"), true);
  });

  it("rejects empty string", () => {
    assert.equal(isSlug(""), false);
  });

  it("rejects special characters", () => {
    assert.equal(isSlug("hello@world"), false);
  });
});

describe("parseSlug", () => {
  it("returns valid slug unchanged", () => {
    assert.equal(parseSlug("hello-world"), "hello-world");
  });

  it("returns single word slug", () => {
    assert.equal(parseSlug("hello"), "hello");
  });

  it("throws on invalid slug", () => {
    assert.throws(() => parseSlug("Hello World"), TypeError);
  });

  it("throws on empty string", () => {
    assert.throws(() => parseSlug(""), TypeError);
  });

  it("throws on leading hyphen", () => {
    assert.throws(() => parseSlug("-hello"), TypeError);
  });

  it("includes invalid value in error message", () => {
    assert.throws(() => parseSlug("BAD!"), {
      message: /BAD!/,
    });
  });
});

describe("toSlug", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    assert.equal(toSlug("Hello World"), "hello-world");
  });

  it("removes special characters", () => {
    assert.equal(toSlug("foo@bar!baz"), "foobarbaz");
  });

  it("collapses multiple spaces into single hyphen", () => {
    assert.equal(toSlug("a   b"), "a-b");
  });

  it("trims whitespace", () => {
    assert.equal(toSlug("  hello  "), "hello");
  });

  it("returns undefined for empty string", () => {
    assert.equal(toSlug(""), undefined);
  });

  it("returns undefined for whitespace-only string", () => {
    assert.equal(toSlug("   "), undefined);
  });

  it("returns undefined for special-chars-only string", () => {
    assert.equal(toSlug("@#$"), undefined);
  });

  it("preserves hyphens", () => {
    assert.equal(toSlug("my-agent"), "my-agent");
  });

  it("preserves underscores", () => {
    assert.equal(toSlug("my_agent"), "my_agent");
  });
});

describe("pathToSlug", () => {
  it("extracts slug from filename", () => {
    assert.equal(pathToSlug("/foo/bar/My Agent.md"), "my-agent");
  });

  it("strips extension", () => {
    assert.equal(pathToSlug("agent.ts"), "agent");
  });

  it("handles nested paths", () => {
    assert.equal(pathToSlug("/a/b/c/hello-world.md"), "hello-world");
  });
});
