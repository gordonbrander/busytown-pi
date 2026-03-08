/** A successful result */
export type Ok<T> = { ok: true; value: T };

/** A failure result */
export type Err<E> = { ok: false; error: E };

/** A Result is either an Ok value or Err value */
export type Result<T, E> = Ok<T> | Err<E>;
