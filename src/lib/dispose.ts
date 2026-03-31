export type AsyncDisposable = {
  [Symbol.asyncDispose](): Promise<void>;
}

export const dispose = (disposable: AsyncDisposable): Promise<void> => {
  return disposable[Symbol.asyncDispose]();
};
