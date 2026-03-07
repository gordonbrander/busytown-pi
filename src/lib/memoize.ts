export type Memoized<A extends unknown[], R> = ((...args: A) => R) & {
  cache: Map<string, R>;
};

/** Memoize a function using a key function to generate cache keys. */
export const memoize = <A extends unknown[], R>(
  fn: (...args: A) => R,
  keyFn?: (...args: A) => string,
): Memoized<A, R> => {
  const cache = new Map<string, R>();

  const defaultKeyFn = (...args: A): string => {
    return JSON.stringify(args);
  };

  const getKey = keyFn || defaultKeyFn;

  const memoized = (...args: A): R => {
    const key = getKey(...args);

    if (cache.has(key)) {
      return cache.get(key)!;
    }

    const result = fn(...args);
    cache.set(key, result);
    return result;
  };

  memoized.cache = cache;
  return memoized as Memoized<A, R>;
};
