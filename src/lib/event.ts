export type Event = {
  id: number;
  timestamp: number;
  type: string;
  agent_id: string;
  payload: unknown;
};

export type RawEventRow = {
  id: number;
  timestamp: number;
  type: string;
  agent_id: string;
  payload: string;
};

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
