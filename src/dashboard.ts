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
import { worker, type WorkerSystem } from "./worker.ts";
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
  lastSeenId: number;
};

type DashboardAction = {
  type: "events";
  events: Event[];
};

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

const WORKER_EVENT_RE = /^sys\.worker\.(.+)\.(start|finish|error)$/;

const applyWorkerEvent = (
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
  let agents = state.agents;

  for (const event of action.events) {
    const match = event.type.match(WORKER_EVENT_RE);
    if (match) {
      const [, agentId, workerAction] = match;
      const existing = agents.get(agentId!);
      if (existing) {
        const updated = applyWorkerEvent(
          existing,
          workerAction!,
          event.payload,
        );
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
    : { agents, lastSeenId };
};

// ---------------------------------------------------------------------------
// Widget (below editor)
// ---------------------------------------------------------------------------

const buildWidgetLines = (state: DashboardState, theme: Theme): string[] => {
  if (state.agents.size === 0) return [];

  const parts: string[] = [];
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

  return [
    parts.join(theme.fg("border", " / ")),
  ];
};

/**
 * Start the busytown widget that shows agent states below the editor.
 * Polls the DB every 500ms and re-renders on change.
 * Returns a cleanup function.
 */
export const startWidget = (
  db: DatabaseSync,
  agents: AgentDef[],
  ctx: ExtensionContext,
): (() => void) => {
  const tip = getEventsSince(db, { tail: 1 });
  const initialLastSeenId = tip.length > 0 ? tip[0]!.id : 0;

  const store = storeOf(dashboardReducer, {
    agents: new Map(
      agents
        .filter((a) => a.listen.length > 0)
        .map((a) => [a.id, { id: a.id, status: "idle" as const }]),
    ),
    lastSeenId: initialLastSeenId,
  });

  const apply = (): void => {
    ctx.ui.setWidget(
      "busytown",
      (_tui: unknown, theme: Theme) => {
        const lines = buildWidgetLines(store.value, theme);
        return { render: () => lines, invalidate: () => { } };
      },
      { placement: "aboveEditor" },
    );
  };

  apply();

  const interval = setInterval(() => {
    const events = getEventsSince(db, {
      sinceId: store.value.lastSeenId,
      limit: 200,
    });
    if (events.length === 0) return;
    const prev = store.value;
    store.send({ type: "events", events });
    if (store.value !== prev) apply();
  }, 500);

  return () => clearInterval(interval);
};

// ---------------------------------------------------------------------------
// Event notifier (fire-and-forget TUI notifications for every event)
// ---------------------------------------------------------------------------

export const startNotifier = (
  system: WorkerSystem,
  ctx: ExtensionContext,
): (() => Promise<void>) => {
  const id = "_notify";

  system.spawn(
    worker({
      id,
      listen: ["*"],
      hidden: true,
      run: async (event) => {
        const payload = JSON.stringify(event.payload);
        ctx.ui.notify(`> ${event.type}\t@${event.worker_id}\t${payload}`, "info");
      },
    }),
  );

  return async () => { await system.kill(id); };
};

// ---------------------------------------------------------------------------
// Event log overlay (/busytown command)
// ---------------------------------------------------------------------------

const COL_TIME = 10;
const COL_WORKER = 14;
const OVERHEAD = 6; // top border, header, blank, blank, help, bottom border

export const registerEventLogCommand = (
  pi: ExtensionAPI,
  system: WorkerSystem,
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

          // Stream events via hidden worker
          const logWorkerId = "_log";

          system.spawn(
            worker({
              id: logWorkerId,
              listen: ["*"],
              hidden: true,
              run: async (event) => {
                const wasBottom = scrollOffset >= maxScroll();
                pushBuffer(events, event, 500);
                if (wasBottom) scrollOffset = maxScroll();
                tui.requestRender();
              },
            }),
          );

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
              const availForType = innerW - COL_TIME - COL_WORKER - 4;
              const colType = Math.min(
                36,
                Math.max(20, Math.floor(availForType * 0.6)),
              );
              const colPayload = Math.max(
                8,
                innerW - COL_TIME - colType - COL_WORKER - 2,
              );

              // --- header ---
              lines.push(
                row(
                  theme.fg("muted", pad("TIME", COL_TIME)) +
                  theme.fg("muted", pad("TYPE", colType)) +
                  theme.fg("muted", pad("WORKER", COL_WORKER)) +
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
                const wkr = theme.fg("muted", pad(ev.worker_id, COL_WORKER));
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
                system.kill(logWorkerId);
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

            invalidate(): void { },
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
  if (type.startsWith("sys.worker.")) {
    if (type.endsWith(".error")) return "error";
    if (type.endsWith(".start")) return "accent";
    if (type.endsWith(".finish")) return "success";
    return "muted";
  }
  if (type.startsWith("sys.")) return "dim";
  return "text";
};
