const neverAbortController = new AbortController();

/** An AbortSignal that never aborts. Useful for defaults. */
export const neverAbortSignal = neverAbortController.signal;
