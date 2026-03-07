import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { memoize } from "./memoize.ts";

describe("memoize", () => {
  it("returns the same result as the original function", () => {
    const double = (x: number): number => x * 2;
    const memoized = memoize(double);
    assert.equal(memoized(5), 10);
    assert.equal(memoized(3), 6);
  });

  it("caches results for repeated calls", () => {
    let callCount = 0;
    const expensive = (x: number): number => {
      callCount++;
      return x * 2;
    };
    const memoized = memoize(expensive);

    assert.equal(memoized(5), 10);
    assert.equal(memoized(5), 10);
    assert.equal(memoized(5), 10);
    assert.equal(callCount, 1);
  });

  it("caches separately for different arguments", () => {
    let callCount = 0;
    const expensive = (x: number): number => {
      callCount++;
      return x * 2;
    };
    const memoized = memoize(expensive);

    assert.equal(memoized(1), 2);
    assert.equal(memoized(2), 4);
    assert.equal(memoized(1), 2);
    assert.equal(callCount, 2);
  });

  it("uses default key function based on all arguments", () => {
    let callCount = 0;
    const fn = (a: number, b: number): number => {
      callCount++;
      return a + b;
    };
    const memoized = memoize(fn);

    assert.equal(memoized(1, 2), 3);
    assert.equal(memoized(1, 99), 100); // different args, no cache hit
    assert.equal(callCount, 2);

    assert.equal(memoized(1, 2), 3); // cache hit
    assert.equal(callCount, 2);
  });

  it("uses custom key function when provided", () => {
    let callCount = 0;
    const fn = (a: number, b: number): number => {
      callCount++;
      return a + b;
    };
    const memoized = memoize(fn, (a, b) => `${a}:${b}`);

    assert.equal(memoized(1, 2), 3);
    assert.equal(memoized(1, 99), 100); // different key, no cache hit
    assert.equal(callCount, 2);

    assert.equal(memoized(1, 2), 3); // cache hit
    assert.equal(callCount, 2);
  });

  it("exposes the cache map", () => {
    const fn = (x: number): number => x * 2;
    const memoized = memoize(fn);

    memoized(5);
    memoized(10);

    assert.equal(memoized.cache.size, 2);
    assert.equal(memoized.cache.get("[5]"), 10);
    assert.equal(memoized.cache.get("[10]"), 20);
  });

  it("allows clearing the cache", () => {
    let callCount = 0;
    const fn = (x: number): number => {
      callCount++;
      return x * 2;
    };
    const memoized = memoize(fn);

    memoized(5);
    assert.equal(callCount, 1);

    memoized.cache.clear();

    memoized(5);
    assert.equal(callCount, 2);
  });

  it("works with string arguments", () => {
    const upper = (s: string): string => s.toUpperCase();
    const memoized = memoize(upper);

    assert.equal(memoized("hello"), "HELLO");
    assert.equal(memoized("hello"), "HELLO");
    assert.equal(memoized.cache.size, 1);
  });

  it("works with functions that return undefined", () => {
    let callCount = 0;
    const fn = (_x: number): undefined => {
      callCount++;
      return undefined;
    };
    const memoized = memoize(fn);

    assert.equal(memoized(1), undefined);
    assert.equal(memoized(1), undefined);
    assert.equal(callCount, 1);
  });
});
