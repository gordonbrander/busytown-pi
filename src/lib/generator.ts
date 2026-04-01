/**
 * Collects all items from an async iterable into an array.
 * @param iterable The async iterable to collect items from.
 * @returns A promise that resolves to an array of all collected items.
 */
export const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
};
