/** A successful result */
export type Ok<T> = { ok: true; value: T };

/** A failure result */
export type Err<E> = { ok: false; error: E };

/** A Result is either an Ok value or Err value */
export type Result<T, E> = Ok<T> | Err<E>;

export const perform = <T, E = unknown>(fn: () => T): Result<T, E> => {
  try {
    return {
      ok: true,
      value: fn(),
    };
  } catch (error) {
    return { ok: false, error: error as E };
  }
};

export const performAsync = async <T, E = unknown>(fn: () => Promise<T>): Promise<Result<T, E>> => {
  try {
    const value = await fn();
    return {
      ok: true,
      value,
    };
  } catch (error) {
    return { ok: false, error: error as E };
  }
};
