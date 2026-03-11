import { watch } from "chokidar";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pushEvent } from "./event-queue.ts";

export type FileWatcherCleanup = () => Promise<void>;

const DEFAULT_IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.busytown/**",
  "**/.DS_Store",
];

/**
 * Watch the project directory for file changes and push file events.
 *
 * Events pushed:
 * - `file.create` — new file added
 * - `file.modify` — existing file changed
 * - `file.delete` — file removed
 *
 * Each event has payload `{ path: "<relative-path>" }`.
 */
export const watchFiles = (
  db: DatabaseSync,
  projectRoot: string,
  ignored: string[] = DEFAULT_IGNORED,
): FileWatcherCleanup => {
  const watcher = watch(projectRoot, {
    ignoreInitial: true,
    ignored,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });

  const rel = (filePath: string): string =>
    path.relative(projectRoot, filePath);

  watcher.on("add", (filePath) => {
    pushEvent(db, "sys", "file.create", { path: rel(filePath) });
  });

  watcher.on("change", (filePath) => {
    pushEvent(db, "sys", "file.modify", { path: rel(filePath) });
  });

  watcher.on("unlink", (filePath) => {
    pushEvent(db, "sys", "file.delete", { path: rel(filePath) });
  });

  return async () => {
    await watcher.close();
  };
};
