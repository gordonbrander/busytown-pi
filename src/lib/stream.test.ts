import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { lines, filterMap } from "./stream.ts";

describe("lines", () => {
  it("yields complete lines from chunked data", async () => {
    const readable = new Readable({
      read() {
        this.push("hello\nwor");
        this.push("ld\nfoo\n");
        this.push(null);
      },
    });

    const result: string[] = [];
    for await (const line of lines(readable)) {
      result.push(line);
    }

    assert.deepEqual(result, ["hello", "world", "foo"]);
  });

  it("yields a single line without trailing newline", async () => {
    const readable = new Readable({
      read() {
        this.push("only");
        this.push(null);
      },
    });

    const result: string[] = [];
    for await (const line of lines(readable)) {
      result.push(line);
    }

    assert.deepEqual(result, ["only"]);
  });
});

describe("filterMap", () => {
  it("maps and filters items", async () => {
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
      yield 4;
    }

    const result: number[] = [];
    for await (const item of filterMap(source(), (n) =>
      n % 2 === 0 ? n * 10 : undefined,
    )) {
      result.push(item);
    }

    assert.deepEqual(result, [20, 40]);
  });

  it("yields all items when none are filtered", async () => {
    async function* source() {
      yield "a";
      yield "b";
    }

    const result: string[] = [];
    for await (const item of filterMap(source(), (s) => s.toUpperCase())) {
      result.push(item);
    }

    assert.deepEqual(result, ["A", "B"]);
  });
});
