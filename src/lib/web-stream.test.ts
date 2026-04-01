import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collect } from "./generator.ts";
import { lineStream, mapStream } from "./web-stream.ts";

/** Write all string chunks as encoded bytes, then close the stream. */
const writeAllBytes = async (
  writable: WritableStream<Uint8Array>,
  chunks: string[],
): Promise<void> => {
  const encoder = new TextEncoder();
  const writer = writable.getWriter();
  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
};

/** Write all chunks to a writable stream, then close it. */
const writeAll = async <T>(
  writable: WritableStream<T>,
  chunks: T[],
): Promise<void> => {
  const writer = writable.getWriter();
  for (const chunk of chunks) {
    await writer.write(chunk);
  }
  await writer.close();
};

/** Run writes and reads concurrently to avoid backpressure deadlocks. */
const pipe = <I, O>(
  stream: TransformStream<I, O>,
  chunks: I[],
): Promise<O[]> => {
  const writing = writeAll(stream.writable, chunks);
  const reading = collect(stream.readable);
  return Promise.all([writing, reading]).then(([, result]) => result);
};

/** Run writes and reads concurrently to avoid backpressure deadlocks. */
const pipeLines = (
  stream: TransformStream<Uint8Array, string>,
  chunks: string[],
): Promise<string[]> => {
  const writing = writeAllBytes(stream.writable, chunks);
  const reading = collect(stream.readable);
  return Promise.all([writing, reading]).then(([, lines]) => lines);
};

describe("lineStreamOf", () => {
  it("splits a single chunk with multiple lines", async () => {
    const lines = await pipeLines(lineStream(), ["hello\nworld\n"]);
    assert.deepEqual(lines, ["hello", "world"]);
  });

  it("buffers across multiple chunks", async () => {
    const lines = await pipeLines(lineStream(), ["hel", "lo\nwor", "ld\n"]);
    assert.deepEqual(lines, ["hello", "world"]);
  });

  it("flushes trailing content without a final newline", async () => {
    const lines = await pipeLines(lineStream(), ["hello\nworld"]);
    assert.deepEqual(lines, ["hello", "world"]);
  });

  it("handles a chunk that is a single newline", async () => {
    const lines = await pipeLines(lineStream(), ["\n"]);
    assert.deepEqual(lines, [""]);
  });

  it("handles multiple consecutive newlines", async () => {
    const lines = await pipeLines(lineStream(), ["a\n\n\nb"]);
    assert.deepEqual(lines, ["a", "", "", "b"]);
  });

  it("produces no output for an empty stream", async () => {
    const lines = await pipeLines(lineStream(), []);
    assert.deepEqual(lines, []);
  });

  it("produces no output for an empty string chunk", async () => {
    const lines = await pipeLines(lineStream(), [""]);
    assert.deepEqual(lines, []);
  });

  it("handles a single line with no newline", async () => {
    const lines = await pipeLines(lineStream(), ["hello"]);
    assert.deepEqual(lines, ["hello"]);
  });

  it("handles many small single-character chunks", async () => {
    const lines = await pipeLines(lineStream(), [..."abc\ndef\n"]);
    assert.deepEqual(lines, ["abc", "def"]);
  });

  it("handles chunks ending exactly on a newline", async () => {
    const lines = await pipeLines(lineStream(), ["line1\n", "line2\n"]);
    assert.deepEqual(lines, ["line1", "line2"]);
  });
});

describe("mapStream", () => {
  it("transforms each chunk with the mapping function", async () => {
    const result = await pipe(
      mapStream((n: number) => n * 2),
      [1, 2, 3],
    );
    assert.deepEqual(result, [2, 4, 6]);
  });

  it("can change the chunk type", async () => {
    const result = await pipe(
      mapStream((n: number) => String(n)),
      [1, 2, 3],
    );
    assert.deepEqual(result, ["1", "2", "3"]);
  });

  it("produces no output for an empty stream", async () => {
    const result = await pipe(
      mapStream((s: string) => s.toUpperCase()),
      [],
    );
    assert.deepEqual(result, []);
  });

  it("composes with pipeThrough", async () => {
    const source = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });
    const result = await collect(
      source
        .pipeThrough(mapStream((n: number) => n + 10))
        .pipeThrough(mapStream((n: number) => `item-${n}`)),
    );
    assert.deepEqual(result, ["item-11", "item-12", "item-13"]);
  });
});
