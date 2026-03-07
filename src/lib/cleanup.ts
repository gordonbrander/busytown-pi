export type Cleanup = () => void;

export type CleanupGroup = Cleanup & Disposable & {
  add(cleanup: Cleanup): void;
};

/**
 * Creates a cleanup group that can be used to add and run cleanup functions.
 * @example
 * ```ts
 * const cleanup = cleanupGroup();
 * cleanup.add(() => console.log('cleanup 1'));
 * cleanup.add(() => console.log('cleanup 2'));
 * cleanup();
 * ```
 */
export const cleanupGroup = (): CleanupGroup => {
  const cleanups: Cleanup[] = [];

  const cleanup = () => {
    for (let i = cleanups.length - 1; i >= 0; i--) {
      cleanups[i]();
    }
    cleanups.length = 0;
  };

  cleanup.add = (cleanup: Cleanup) => {
    cleanups.push(cleanup);
  };

  cleanup[Symbol.dispose] = cleanup;

  return cleanup;
};

export type Awaitable<T> = T | Promise<T>;

export type CleanupAsync = () => Awaitable<void>;

export type CleanupGroupAsync = CleanupAsync & AsyncDisposable & {
  add(cleanup: CleanupAsync): void;
};

/**
 * Creates an async cleanup group that can be used to add and run cleanup functions asynchronously.
 * @example
 * ```ts
 * const cleanup = cleanupGroupAsync();
 * cleanup.add(doAsyncCleanup);
 * cleanup.add(() => console.log('cleanup 2'));
 * await cleanup();
 * ```
 */
export const cleanupGroupAsync = (): CleanupGroupAsync => {
  const cleanups: CleanupAsync[] = [];

  const cleanup = async () => {
    // Run cleanup in reverse of insertion order. This helps with cases
    // where cleanup functions depend on each other (e.g. closing resources in reverse order).
    for (let i = cleanups.length - 1; i >= 0; i--) {
      await cleanups[i]();
    }
    cleanups.length = 0;
  };

  cleanup.add = (cleanup: CleanupAsync) => {
    cleanups.push(cleanup);
  };

  cleanup[Symbol.asyncDispose] = cleanup;

  return cleanup;
};
