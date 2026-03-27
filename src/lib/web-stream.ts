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

/* Create a stream that acts a bit like a CSP channel, applying backpressure after high water mark is reached */
export const bufferStream = <T>(highWaterMark: number = 0) =>
  new TransformStream<T, T>(
    undefined,
    new CountQueuingStrategy({ highWaterMark }), // writer side
    new CountQueuingStrategy({ highWaterMark }), // reader side
  );
