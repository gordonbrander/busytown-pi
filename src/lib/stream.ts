import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** Yield complete lines from a readable stream. */
export const lines = (readable: Readable): AsyncIterable<string> =>
  createInterface({ input: readable });

/** Map + filter in one pass — return undefined to skip an item. */
export const filterMap = async function* <A, B>(
  iter: AsyncIterable<A>,
  fn: (item: A) => B | undefined,
): AsyncGenerator<B> {
  for await (const item of iter) {
    const result = fn(item);
    if (result !== undefined) yield result;
  }
};
