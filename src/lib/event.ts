export type Event = {
  id: number;
  timestamp: number;
  type: string;
  agent_id: string;
  correlation_id?: number;
  causation_id?: number;
  depth: number;
  payload: unknown;
};

export type EventDraft = {
  type: string;
  payload: unknown;
};

export type RawEventRow = {
  id: number;
  timestamp: number;
  type: string;
  agent_id: string;
  correlation_id: number | null;
  causation_id: number | null;
  depth: number;
  payload: string;
};

/** Does event match listen pattern? */
export const eventMatches = (event: Event, listen: string[]): boolean => {
  for (const pattern of listen) {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1); // keep the dot: "task."
      if (event.type.startsWith(prefix)) return true;
    } else if (event.type === pattern) {
      return true;
    }
  }
  return false;
};

/** Create a predicate function that checks if agent should handle event. */
export const shouldHandleEventOf =
  (id: string, ignoreSelf: boolean, listen: string[]) =>
  (event: Event): boolean => {
    if (ignoreSelf && event.agent_id === id) {
      return false;
    }
    return eventMatches(event, listen);
  };
