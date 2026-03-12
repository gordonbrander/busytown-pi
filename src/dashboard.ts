import type { DatabaseSync } from "node:sqlite";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import type { AgentDef } from "./agent.ts";
import type { Event } from "./lib/event.ts";
import { getEventsSince } from "./event-queue.ts";
import { getDaemonStatus } from "./pidfile.ts";
import { pushBuffer } from "./lib/buffer.ts";
import { storeOf } from "./lib/store.ts";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { formatTime } from "./lib/time.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentState = {
  id: string;
  status: "idle" | "running" | "error";
  eventType?: string;
};

type DashboardState = {
  agents: Map<string, AgentState>;
  daemonRunning: boolean;
  lastSeenId: number;
};

type DashboardAction =
  | { type: "events"; events: Event[] }
  | { type: "daemon_status"; running: boolean };

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

const AGENT_EVENT_RE = /^sys\.agent\.(.+)\.(start|finish|error)$/;

const applyAgentEvent = (
  agent: AgentState,
  action: string,
  payload: unknown,
): AgentState => {
  if (action === "start") {
    return {
      ...agent,
      status: "running",
      eventType: (payload as Record<string, unknown>)?.event_type as
        | string
        | undefined,
    };
  }
  if (action === "finish") {
    return { ...agent, status: "idle", eventType: undefined };
  }
  if (action === "error") {
    return { ...agent, status: "error" };
  }
  return agent;
};

const dashboardReducer = (
  state: DashboardState,
  action: DashboardAction,
): DashboardState => {
  if (action.type === "daemon_status") {
    return action.running === state.daemonRunning
      ? state
      : { ...state, daemonRunning: action.running };
  }

  let agents = state.agents;

  for (const event of action.events) {
    const match = event.type.match(AGENT_EVENT_RE);
    if (match) {
      const [, agentId, agentAction] = match;
      const existing = agents.get(agentId!);
      if (existing) {
        const updated = applyAgentEvent(existing, agentAction!, event.payload);
        if (updated !== existing) {
          // Copy-on-first-write
          if (agents === state.agents) agents = new Map(state.agents);
          agents.set(agentId!, updated);
        }
      }
    }
  }

  const lastSeenId = action.events[action.events.length - 1]!.id;

  return agents === state.agents && lastSeenId === state.lastSeenId
    ? state
    : { ...state, agents, lastSeenId };
};

// ---------------------------------------------------------------------------
// Widget (below editor)
// ---------------------------------------------------------------------------

const buildWidgetLines = (state: DashboardState, theme: Theme): string[] => {
  const parts: string[] = [];

  // Daemon status indicator
  if (state.daemonRunning) {
    parts.push(
      `${theme.fg("success", "▲")} ${theme.fg("success", "busytown")}`,
    );
  } else {
    parts.push(`${theme.fg("error", "▼")} ${theme.fg("error", "busytown")}`);
  }

  // Agent status indicators
  for (const agent of state.agents.values()) {
    const name = theme.fg("text", agent.id);
    if (agent.status === "running") {
      const icon = theme.fg("accent", "●");
      const detail = agent.eventType
        ? theme.fg("muted", `(${agent.eventType})`)
        : theme.fg("muted", "(running)");
      parts.push(`${icon} ${name} ${detail}`);
    } else if (agent.status === "error") {
      parts.push(
        `${theme.fg("error", "●")} ${name} ${theme.fg("error", "(error)")}`,
      );
    } else {
      parts.push(
        `${theme.fg("dim", "○")} ${name} ${theme.fg("dim", "(idle)")}`,
      );
    }
  }

  return [parts.join(theme.fg("border", " / "))];
};

/**
 * Start the busytown widget that shows daemon + agent states below the editor.
 * Polls the DB every 500ms and re-renders on change.
 * Returns a cleanup function.
 */
export const startWidget = (
  db: DatabaseSync,
  agents: AgentDef[],
  ctx: ExtensionContext,
  projectRoot: string,
): (() => void) => {
  const tip = getEventsSince(db, { tail: 1 });
  const initialLastSeenId = tip.length > 0 ? tip[0]!.id : 0;

  const store = storeOf(dashboardReducer, {
    agents: new Map(
      agents
        .filter((a) => a.listen.length > 0)
        .map((a) => [a.id, { id: a.id, status: "idle" as const }]),
    ),
    daemonRunning: getDaemonStatus(projectRoot).running,
    lastSeenId: initialLastSeenId,
  });

  const apply = (): void => {
    ctx.ui.setWidget(
      "busytown",
      (_tui: unknown, theme: Theme) => {
        const lines = buildWidgetLines(store.value, theme);
        return { render: () => lines, invalidate: () => {} };
      },
      { placement: "aboveEditor" },
    );
  };

  apply();

  const interval = setInterval(() => {
    let changed = false;

    // Check daemon status
    const daemonRunning = getDaemonStatus(projectRoot).running;
    if (daemonRunning !== store.value.daemonRunning) {
      store.send({ type: "daemon_status", running: daemonRunning });
      changed = true;
    }

    // Check for new events
    const events = getEventsSince(db, {
      sinceId: store.value.lastSeenId,
      limit: 200,
    });
    if (events.length > 0) {
      const prev = store.value;
      store.send({ type: "events", events });
      if (store.value !== prev) changed = true;
    }

    if (changed) apply();
  }, 500);

  return () => clearInterval(interval);
};

// ---------------------------------------------------------------------------
// Event notifier (fire-and-forget TUI notifications via DB polling)
// ---------------------------------------------------------------------------

export const startNotifier = (
  db: DatabaseSync,
  ctx: ExtensionContext,
): (() => void) => {
  const tip = getEventsSince(db, { tail: 1 });
  let lastSeenId = tip.length > 0 ? tip[0]!.id : 0;

  const interval = setInterval(() => {
    const events = getEventsSince(db, {
      sinceId: lastSeenId,
      limit: 200,
    });
    if (events.length === 0) return;

    lastSeenId = events[events.length - 1]!.id;

    for (const event of events) {
      const payload = JSON.stringify(event.payload);
      ctx.ui.notify(`> ${event.type}\t@${event.agent_id}\t${payload}`, "info");
    }
  }, 500);

  return () => clearInterval(interval);
};

// ---------------------------------------------------------------------------
// Event log overlay (/busytown command)
// ---------------------------------------------------------------------------

const COL_TIME = 10;
const COL_AGENT = 14;
const OVERHEAD = 6; // top border, header, blank, blank, help, bottom border

export const registerEventLogCommand = (
  pi: ExtensionAPI,
  db: DatabaseSync,
): void => {
  pi.registerCommand("busytown-console", {
    description: "Show live Busytown event log",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.ui.custom<null>(
        (tui, theme, _kb, done) => {
          const events: Event[] = [];
          const visibleRows = Math.max(
            8,
            Math.floor((process.stdout.rows ?? 30) * 0.6) - OVERHEAD,
          );
          let scrollOffset = 0;

          const maxScroll = (): number =>
            Math.max(0, events.length - visibleRows);

          // Seed with recent events
          const recent = getEventsSince(db, { tail: visibleRows });
          for (const ev of recent) {
            pushBuffer(events, ev, 500);
          }
          scrollOffset = maxScroll();

          // Poll DB for new events
          let lastSeenId =
            events.length > 0 ? events[events.length - 1]!.id : 0;

          const pollInterval = setInterval(() => {
            const newEvents = getEventsSince(db, {
              sinceId: lastSeenId,
              limit: 200,
            });
            if (newEvents.length === 0) return;
            lastSeenId = newEvents[newEvents.length - 1]!.id;

            const wasBottom = scrollOffset >= maxScroll();
            for (const ev of newEvents) {
              pushBuffer(events, ev, 500);
            }
            if (wasBottom) scrollOffset = maxScroll();
            tui.requestRender();
          }, 500);

          return {
            render(width: number): string[] {
              const innerW = width - 2;
              const lines: string[] = [];

              const pad = (s: string, len: number): string => {
                const vis = visibleWidth(s);
                return vis >= len ? s : s + " ".repeat(len - vis);
              };

              const row = (content: string): string => {
                const vis = visibleWidth(content);
                const fill = Math.max(0, innerW - vis);
                return (
                  theme.fg("border", "│") +
                  content +
                  " ".repeat(fill) +
                  theme.fg("border", "│")
                );
              };

              // --- top border ---
              const title = " Busytown Events ";
              const lDash = Math.max(
                1,
                Math.floor((innerW - title.length) / 2),
              );
              const rDash = Math.max(1, innerW - lDash - title.length);
              lines.push(
                theme.fg("border", "╭" + "─".repeat(lDash)) +
                  theme.fg("accent", theme.bold(title)) +
                  theme.fg("border", "─".repeat(rDash) + "╮"),
              );

              // --- column sizing ---
              const availForType = innerW - COL_TIME - COL_AGENT - 4;
              const colType = Math.min(
                36,
                Math.max(20, Math.floor(availForType * 0.6)),
              );
              const colPayload = Math.max(
                8,
                innerW - COL_TIME - colType - COL_AGENT - 2,
              );

              // --- header ---
              lines.push(
                row(
                  theme.fg("muted", pad("TIME", COL_TIME)) +
                    theme.fg("muted", pad("TYPE", colType)) +
                    theme.fg("muted", pad("AGENT", COL_AGENT)) +
                    theme.fg("muted", "PAYLOAD"),
                ),
              );

              // --- event rows ---
              const start = scrollOffset;
              const end = Math.min(start + visibleRows, events.length);

              for (let i = start; i < end; i++) {
                const ev = events[i]!;
                const time = theme.fg(
                  "dim",
                  pad(formatTime(ev.timestamp), COL_TIME),
                );
                const type = theme.fg(
                  typeColor(ev.type),
                  pad(truncateToWidth(ev.type, colType - 1), colType),
                );
                const wkr = theme.fg("muted", pad(ev.agent_id, COL_AGENT));
                const pStr = JSON.stringify(ev.payload);
                const payload =
                  pStr === "{}"
                    ? ""
                    : theme.fg("dim", truncateToWidth(pStr, colPayload));
                lines.push(row(`${time}${type}${wkr}${payload}`));
              }
              for (let i = end - start; i < visibleRows; i++) {
                lines.push(row(""));
              }

              // --- footer ---
              const helpText = "↑↓ scroll  g/G top/bottom  esc close";
              const pos =
                events.length > 0
                  ? `${start + 1}–${end} of ${events.length}`
                  : "empty";
              lines.push(row(""));
              lines.push(
                row(
                  theme.fg(
                    "dim",
                    helpText +
                      " ".repeat(
                        Math.max(
                          1,
                          innerW -
                            visibleWidth(helpText) -
                            visibleWidth(pos) -
                            2,
                        ),
                      ) +
                      pos,
                  ),
                ),
              );

              // --- bottom border ---
              lines.push(theme.fg("border", "╰" + "─".repeat(innerW) + "╯"));

              return lines;
            },

            handleInput(data: string): void {
              if (matchesKey(data, "escape")) {
                clearInterval(pollInterval);
                done(null);
                return;
              }
              if (matchesKey(data, "up")) {
                scrollOffset = Math.max(0, scrollOffset - 1);
              } else if (matchesKey(data, "down")) {
                scrollOffset = Math.min(maxScroll(), scrollOffset + 1);
              } else if (matchesKey(data, "pageUp")) {
                scrollOffset = Math.max(0, scrollOffset - visibleRows);
              } else if (matchesKey(data, "pageDown")) {
                scrollOffset = Math.min(
                  maxScroll(),
                  scrollOffset + visibleRows,
                );
              } else if (data === "g") {
                scrollOffset = 0;
              } else if (data === "G") {
                scrollOffset = maxScroll();
              }
              tui.requestRender();
            },

            invalidate(): void {},
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "95%",
            maxHeight: "85%",
            anchor: "center",
          },
        },
      );
    },
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FgColor = Parameters<Theme["fg"]>[0];

const typeColor = (type: string): FgColor => {
  if (type.startsWith("sys.agent.")) {
    if (type.endsWith(".error")) return "error";
    if (type.endsWith(".start")) return "accent";
    if (type.endsWith(".finish")) return "success";
    return "muted";
  }
  if (type.startsWith("sys.")) return "dim";
  return "text";
};
