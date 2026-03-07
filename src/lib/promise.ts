export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const abortableSleep = (
  ms: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const nextTick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export const forever = (): Promise<void> => new Promise<void>(() => {});
