import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { memoize } from "./lib/memoize.ts";
import type { Event, RawEventRow } from "./event.ts";

export type DatabaseHandle = { db: DatabaseSync; path: string };

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    type      TEXT    NOT NULL,
    worker_id TEXT    NOT NULL,
    payload   TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS worker_cursors (
    worker_id TEXT    PRIMARY KEY,
    since     INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS claims (
    event_id   INTEGER PRIMARY KEY,
    worker_id  TEXT    NOT NULL,
    claimed_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

/**
 * Open a database connection and create the schema if it doesn't exist.
 * Creates intermediate directories as needed.
 */
export const openDb = (dbPath: string): DatabaseHandle => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return { db, path: dbPath };
};

/** Returns a cached DatabaseHandle for the given path, opening it on first access. */
export const getOrOpenDb = memoize(openDb, (dbPath) => dbPath);

const parseEvent = (row: RawEventRow): Event => ({
  ...row,
  payload: JSON.parse(row.payload),
});

export const pushEvent = (
  db: DatabaseSync,
  workerId: string,
  type: string,
  payload: unknown = {},
): Event => {
  const row = db
    .prepare(
      `INSERT INTO events (type, worker_id, payload)
       VALUES (?, ?, ?)
       RETURNING id, timestamp`,
    )
    .get(type, workerId, JSON.stringify(payload)) as {
      id: number;
      timestamp: number;
    };

  return {
    id: row.id,
    timestamp: row.timestamp,
    type,
    worker_id: workerId,
    payload,
  };
};

export const getCursor = (db: DatabaseSync, workerId: string): number => {
  const row = db
    .prepare(`SELECT since FROM worker_cursors WHERE worker_id = ?`)
    .get(workerId) as { since: number } | undefined;
  return row?.since ?? 0;
};

export const updateCursor = (
  db: DatabaseSync,
  workerId: string,
  sinceId: number,
): void => {
  db.prepare(
    `INSERT INTO worker_cursors (worker_id, since)
     VALUES (?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET since = excluded.since, timestamp = unixepoch()`,
  ).run(workerId, sinceId);
};

export const getOrCreateCursor = (
  db: DatabaseSync,
  workerId: string,
): number => {
  db.exec("BEGIN");
  try {
    const existing = getCursor(db, workerId);
    if (existing > 0) {
      db.exec("COMMIT");
      return existing;
    }

    // Check if cursor row exists with since=0
    const row = db
      .prepare(`SELECT since FROM worker_cursors WHERE worker_id = ?`)
      .get(workerId) as { since: number } | undefined;
    if (row) {
      db.exec("COMMIT");
      return row.since;
    }

    // New worker: push cursor creation event, set cursor to that ID
    const event = pushEvent(db, workerId, "sys.cursor.create", {
      worker_id: workerId,
    });
    updateCursor(db, workerId, event.id);
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
  omitWorkerId?: string;
  filterWorkerId?: string;
  filterType?: string;
  tail?: number;
};

export const getEventsSince = (
  db: DatabaseSync,
  opts: GetEventsSinceOpts = {},
): Event[] => {
  const {
    sinceId = 0,
    limit = 100,
    omitWorkerId,
    filterWorkerId,
    filterType,
    tail,
  } = opts;

  const conditions: string[] = ["id > ?"];
  const params: SQLInputValue[] = [sinceId];

  if (omitWorkerId) {
    conditions.push("worker_id != ?");
    params.push(omitWorkerId);
  }
  if (filterWorkerId) {
    conditions.push("worker_id = ?");
    params.push(filterWorkerId);
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

export const pollEvents = (
  db: DatabaseSync,
  workerId: string,
  limit?: number,
  omitWorkerId?: string,
): Event[] => {
  const sinceId = getOrCreateCursor(db, workerId);
  const events = getEventsSince(db, { sinceId, limit, omitWorkerId });
  if (events.length > 0) {
    updateCursor(db, workerId, events[events.length - 1].id);
  }
  return events;
};

export const claimEvent = (
  db: DatabaseSync,
  workerId: string,
  eventId: number,
): boolean => {
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT OR IGNORE INTO claims (event_id, worker_id) VALUES (?, ?)`,
    ).run(eventId, workerId);

    const row = db
      .prepare(`SELECT worker_id FROM claims WHERE event_id = ?`)
      .get(eventId) as { worker_id: string } | undefined;

    if (row?.worker_id === workerId) {
      pushEvent(db, workerId, "sys.claim.create", { event_id: eventId });
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

export const getClaimant = (
  db: DatabaseSync,
  eventId: number,
): { worker_id: string; claimed_at: number } | undefined => {
  return db
    .prepare(`SELECT worker_id, claimed_at FROM claims WHERE event_id = ?`)
    .get(eventId) as { worker_id: string; claimed_at: number } | undefined;
};
