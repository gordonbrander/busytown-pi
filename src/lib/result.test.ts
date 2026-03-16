import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { perform, performAsync } from "./result.ts";

describe("perform", () => {
  it("returns Ok with value when function succeeds", () => {
    const result = perform(() => 42);
    assert.deepEqual(result, { ok: true, value: 42 });
  });

  it("returns Ok with undefined when function returns undefined", () => {
    const result = perform(() => undefined);
    assert.deepEqual(result, { ok: true, value: undefined });
  });

  it("returns Ok with a complex value", () => {
    const result = perform(() => ({ name: "alice", age: 30 }));
    assert.deepEqual(result, { ok: true, value: { name: "alice", age: 30 } });
  });

  it("returns Err with the thrown error when function throws", () => {
    const err = new Error("boom");
    const result = perform(() => {
      throw err;
    });
    assert.deepEqual(result, { ok: false, error: err });
  });

  it("returns Err with a thrown string", () => {
    const result = perform(() => {
      throw "something went wrong";
    });
    assert.deepEqual(result, { ok: false, error: "something went wrong" });
  });

  it("returns Err with a thrown object", () => {
    const thrown = { code: 404, message: "not found" };
    const result = perform(() => {
      throw thrown;
    });
    assert.deepEqual(result, { ok: false, error: thrown });
  });
});

describe("performAsync", () => {
  it("returns Ok with value when promise resolves", async () => {
    const result = await performAsync(async () => 42);
    assert.deepEqual(result, { ok: true, value: 42 });
  });

  it("returns Ok with undefined when promise resolves to undefined", async () => {
    const result = await performAsync(async () => undefined);
    assert.deepEqual(result, { ok: true, value: undefined });
  });

  it("returns Ok with a complex resolved value", async () => {
    const result = await performAsync(async () => ({ name: "bob", score: 99 }));
    assert.deepEqual(result, { ok: true, value: { name: "bob", score: 99 } });
  });

  it("returns Err with the rejection reason when promise rejects", async () => {
    const err = new Error("async boom");
    const result = await performAsync(async () => {
      throw err;
    });
    assert.deepEqual(result, { ok: false, error: err });
  });

  it("returns Err with a rejected string", async () => {
    const result = await performAsync(async () => {
      throw "async failure";
    });
    assert.deepEqual(result, { ok: false, error: "async failure" });
  });

  it("wraps a real async operation that resolves", async () => {
    const result = await performAsync(
      () => new Promise<number>((resolve) => setTimeout(() => resolve(7), 0))
    );
    assert.deepEqual(result, { ok: true, value: 7 });
  });

  it("wraps a real async operation that rejects", async () => {
    const err = new Error("rejected");
    const result = await performAsync(
      () => new Promise<number>((_, reject) => setTimeout(() => reject(err), 0))
    );
    assert.deepEqual(result, { ok: false, error: err });
  });
});
