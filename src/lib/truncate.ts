export type TruncationReceipt = {
  text: string;
  truncated: boolean;
};

/**
 * Truncate a string to a maximum length, adding an ellipsis if necessary.
 * Returns a TruncationReceipt object, with information about the truncation.
 */
export const truncate = (
  text: string,
  maxLength: number,
  ellipsis = "…",
): TruncationReceipt => {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }

  // Subtract ellipsis length to make sure we stay under limit
  const end = maxLength - ellipsis.length;

  if (end < 1) {
    return { text: "", truncated: true };
  }

  return { text: text.substring(0, end).trim() + ellipsis, truncated: true };
};
