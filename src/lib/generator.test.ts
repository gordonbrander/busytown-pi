import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collect } from "./generator.ts";

describe("collect", () => {
  it("collects items from an async iterable into an array", async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    const result = await collect(gen());
    assert.deepEqual(result, [1, 2, 3]);
  });

  it("returns an empty array for an empty async iterable", async () => {
    async function* gen() {}
    const result = await collect(gen());
    assert.deepEqual(result, []);
  });

  it("collects string items", async () => {
    async function* gen() {
      yield "a";
      yield "b";
    }
    const result = await collect(gen());
    assert.deepEqual(result, ["a", "b"]);
  });

  it("collects a single item", async () => {
    async function* gen() {
      yield 42;
    }
    const result = await collect(gen());
    assert.deepEqual(result, [42]);
  });

  it("preserves order of yielded items", async () => {
    async function* gen() {
      yield 3;
      yield 1;
      yield 2;
    }
    const result = await collect(gen());
    assert.deepEqual(result, [3, 1, 2]);
  });
});
