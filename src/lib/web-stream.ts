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

/** Creates an empty `ReadableStream` */
export const emptyReadableStream = <T>(): ReadableStream<T> => {
  return new ReadableStream<T>({
    pull(controller) {
      controller.close();
    },
  });
};
