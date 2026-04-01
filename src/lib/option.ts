export const toOption = <T>(value: T | undefined | null): T | undefined => {
  return value ?? undefined;
};

export const unwrap = <T>(value: T | undefined, msg = "Value is undefined"): T => {
  if (value === undefined) {
    throw new TypeError(msg);
  }
  return value;
};

export const unwrapOr = <T>(value: T | undefined, defaultValue: T): T => {
  if (value === undefined) {
    return defaultValue;
  }
  return value;
};
