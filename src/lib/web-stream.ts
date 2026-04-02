import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

/**
 * Create a `ReadableStream<Uint8Array>` from a child process's stdout.
 * The stream closes automatically when the process exits.
 */
export const stdout = (proc: ChildProcess): ReadableStream<Uint8Array> =>
  processStream(proc, proc.stdout!);

/**
 * Create a `ReadableStream<Uint8Array>` from a child process's stderr.
 * The stream closes automatically when the process exits.
 */
export const stderr = (proc: ChildProcess): ReadableStream<Uint8Array> =>
  processStream(proc, proc.stderr!);

/**
 * Create a `WritableStream<Uint8Array>` from a child process's stdin.
 * The stream is aborted when the process exits to prevent hanging writes.
 */
export const stdin = (proc: ChildProcess): WritableStream<Uint8Array> => {
  const webStream = Writable.toWeb(
    proc.stdin! as Writable,
  ) as WritableStream<Uint8Array>;

  proc.once("exit", () => {
    webStream.abort().catch(() => {});
  });

  return webStream;
};

/**
 * Wrap a child process's readable stream as a web `ReadableStream<Uint8Array>`
 * that tears down when the process exits.
 *
 * `Readable.toWeb` doesn't always close the web stream promptly when the
 * underlying Node stream is destroyed by a killed process. This utility
 * listens for the process `exit` event and explicitly cancels the reader.
 */
const processStream = (
  proc: ChildProcess,
  nodeStream: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> => {
  const webStream = Readable.toWeb(
    nodeStream as Readable,
  ) as ReadableStream<Uint8Array>;
  const reader = webStream.getReader();

  let done = false;

  const onExit = () => {
    if (!done) {
      reader.cancel().catch(() => {});
    }
  };
  proc.once("exit", onExit);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          done = true;
          proc.off("exit", onExit);
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch {
        done = true;
        proc.off("exit", onExit);
        controller.close();
      }
    },
    cancel() {
      done = true;
      proc.off("exit", onExit);
      reader.cancel().catch(() => {});
    },
  });
};

/**
 * Create a `TransformStream<Uint8Array, string>` that decodes bytes and emits
 * complete lines.
 *
 * Uses a `TextDecoder` internally to decode chunks, then splits on `\n`.
 * Useful for processing stdout/stderr from child processes.
 *
 * @example
 * ```ts
 * const lines = childProcess.stdout
 *   .pipeThrough(byteLineStream())
 * for await (const line of lines) {
 *   console.log(line)
 * }
 * ```
 */
export const lineStream = (): TransformStream<Uint8Array, string> => {
  const decoder = new TextDecoder();
  let buffer = "";

  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      // `stream: true` keeps partial multi-byte characters buffered in the decoder
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const part of parts) {
        controller.enqueue(part);
      }
    },

    flush(controller) {
      // Flush any remaining bytes from the decoder
      buffer += decoder.decode();
      if (buffer.length > 0) {
        controller.enqueue(buffer);
        buffer = "";
      }
    },
  });
};

const encoder = new TextEncoder();

/** Encode text as bytes and write to writer */
export const writeText = (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  text: string,
): Promise<void> => {
  return writer.write(encoder.encode(text));
};

/** Encode text as bytes and write to writer */
export const writeJsonLine = (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  data: unknown,
): Promise<void> => {
  return writer.write(encoder.encode(JSON.stringify(data) + "\n"));
};

/**
 * Create a `TransformStream` that applies a mapping function to each chunk.
 *
 * @example
 * ```ts
 * const uppercased = readable
 *   .pipeThrough(mapStream((s: string) => s.toUpperCase()))
 * ```
 */
export const mapStream = <I, O>(fn: (chunk: I) => O): TransformStream<I, O> =>
  new TransformStream<I, O>({
    transform(chunk, controller) {
      controller.enqueue(fn(chunk));
    },
  });
