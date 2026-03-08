/** A very simple ring buffer (inefficient) */
export const pushBuffer = <T>(buffer: T[], item: T, capacity: number): void => {
  if (buffer.length >= capacity) {
    buffer.shift();
  }
  buffer.push(item);
};
