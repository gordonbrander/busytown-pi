import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { memoize } from "./lib/memoize.ts";
import type { Event, RawEventRow } from "./lib/event.ts";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    type      TEXT    NOT NULL,
    agent_id  TEXT    NOT NULL,
    payload   TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS agent_cursors (
    agent_id  TEXT    PRIMARY KEY,
    since     INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS claims (
    event_id   INTEGER PRIMARY KEY,
    agent_id   TEXT    NOT NULL,
    claimed_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

/**
 * Open a database connection and create the schema if it doesn't exist.
 * Creates intermediate directories as needed.
 */
export const openDb = (dbPath: string): DatabaseSync => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
};

/** Returns a cached DatabaseSync for the given path, opening it on first access. */
export const getOrOpenDb = memoize(openDb, (dbPath) => dbPath);

const parseEvent = (row: RawEventRow): Event => ({
  ...row,
  payload: JSON.parse(row.payload),
});

export const pushEvent = (
  db: DatabaseSync,
  agentId: string,
  type: string,
  payload: unknown = {},
): Event => {
  const row = db
    .prepare(
      `INSERT INTO events (type, agent_id, payload)
       VALUES (?, ?, ?)
       RETURNING id, timestamp`,
    )
    .get(type, agentId, JSON.stringify(payload)) as {
      id: number;
      timestamp: number;
    };

  return {
    id: row.id,
    timestamp: row.timestamp,
    type,
    agent_id: agentId,
    payload,
  };
};

export const getCursor = (db: DatabaseSync, agentId: string): number => {
  const row = db
    .prepare(`SELECT since FROM agent_cursors WHERE agent_id = ?`)
    .get(agentId) as { since: number } | undefined;
  return row?.since ?? 0;
};

export const updateCursor = (
  db: DatabaseSync,
  agentId: string,
  sinceId: number,
): void => {
  db.prepare(
    `INSERT INTO agent_cursors (agent_id, since)
     VALUES (?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET since = excluded.since, timestamp = unixepoch()`,
  ).run(agentId, sinceId);
};

export const getOrCreateCursor = (
  db: DatabaseSync,
  agentId: string,
): number => {
  db.exec("BEGIN");
  try {
    const existing = getCursor(db, agentId);
    if (existing > 0) {
      db.exec("COMMIT");
      return existing;
    }

    // Check if cursor row exists with since=0
    const row = db
      .prepare(`SELECT since FROM agent_cursors WHERE agent_id = ?`)
      .get(agentId) as { since: number } | undefined;
    if (row) {
      db.exec("COMMIT");
      return row.since;
    }

    // New agent: push cursor creation event, set cursor to that ID
    const event = pushEvent(db, agentId, "sys.cursor.create", {
      agent_id: agentId,
    });
    updateCursor(db, agentId, event.id);
    db.exec("COMMIT");
    return event.id;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

export type GetEventsSinceOpts = {
  sinceId?: number;
  limit?: number;
  omitAgentId?: string;
  filterAgentId?: string;
  filterType?: string;
  tail?: number;
};

export const getEventsSince = (
  db: DatabaseSync,
  {
    sinceId = 0,
    limit = 100,
    omitAgentId,
    filterAgentId,
    filterType,
    tail,
  }: GetEventsSinceOpts = {},
): Event[] => {
  const conditions: string[] = ["id > ?"];
  const params: SQLInputValue[] = [sinceId];

  if (omitAgentId) {
    conditions.push("agent_id != ?");
    params.push(omitAgentId);
  }
  if (filterAgentId) {
    conditions.push("agent_id = ?");
    params.push(filterAgentId);
  }
  if (filterType && filterType !== "*") {
    conditions.push("type = ?");
    params.push(filterType);
  }

  const where = conditions.join(" AND ");

  if (tail) {
    const sql = `SELECT * FROM events WHERE ${where} ORDER BY id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, tail) as RawEventRow[];
    return rows.reverse().map(parseEvent);
  }

  const sql = `SELECT * FROM events WHERE ${where} ORDER BY id ASC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as RawEventRow[];
  return rows.map(parseEvent);
};

export const getNextEvent = (
  db: DatabaseSync,
  sinceId: number,
): Event | undefined => {
  const row = db
    .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT 1`)
    .get(sinceId) as RawEventRow | undefined;
  return row ? parseEvent(row) : undefined;
};

export const pullNextMatchingEvent = (
  db: DatabaseSync,
  id: string,
  filter: (event: Event) => boolean,
): Event | undefined => {
  while (true) {
    const sinceId = getOrCreateCursor(db, id);
    const event = getNextEvent(db, sinceId);
    if (!event) {
      return undefined;
    }

    // Advance cursor
    updateCursor(db, id, event.id);

    // Events that don't match are skipped
    // Events that have already been claimed cannot be matched and are skipped.
    if (!filter(event) || isClaimed(db, event.id)) {
      continue;
    }

    return event;
  }
};

export const pollEvents = (
  db: DatabaseSync,
  agentId: string,
  limit?: number,
  omitAgentId?: string,
): Event[] => {
  const sinceId = getOrCreateCursor(db, agentId);
  const events = getEventsSince(db, { sinceId, limit, omitAgentId });
  if (events.length > 0) {
    updateCursor(db, agentId, events[events.length - 1].id);
  }
  return events;
};

export const claimEvent = (
  db: DatabaseSync,
  agentId: string,
  eventId: number,
): boolean => {
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT OR IGNORE INTO claims (event_id, agent_id) VALUES (?, ?)`,
    ).run(eventId, agentId);

    const row = db
      .prepare(`SELECT agent_id FROM claims WHERE event_id = ?`)
      .get(eventId) as { agent_id: string } | undefined;

    if (row?.agent_id === agentId) {
      pushEvent(db, agentId, "sys.claim.create", { event_id: eventId });
      db.exec("COMMIT");
      return true;
    }
    db.exec("COMMIT");
    return false;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

/** Check if event has been claimed */
export const isClaimed = (
  db: DatabaseSync,
  eventId: number,
): boolean => {
  return db
    .prepare(`SELECT agent_id FROM claims WHERE event_id = ?`)
    .get(eventId) !== undefined;
};

export const getClaimant = (
  db: DatabaseSync,
  eventId: number,
): { agent_id: string; claimed_at: number } | undefined => {
  return db
    .prepare(`SELECT agent_id, claimed_at FROM claims WHERE event_id = ?`)
    .get(eventId) as { agent_id: string; claimed_at: number } | undefined;
};
