export type AsyncDisposable = {
  [Symbol.asyncDispose](): Promise<void>;
};

/** Call the async dispose method of a disposable object. */
export const asyncDispose = (disposable: AsyncDisposable): Promise<void> => {
  return disposable[Symbol.asyncDispose]();
};
