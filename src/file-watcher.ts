import { watch } from "chokidar";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import picomatch from "picomatch";
import { pushEvent } from "./event-queue.ts";

/**
 * Returns a predicate that tests whether a path matches the given glob pattern.
 */
export const glob = (glob: string) => picomatch(glob);

/** Combines predicate functions */
export const any =
  (predicates: Array<(path: string) => boolean>) =>
  (path: string): boolean =>
    predicates.some((predicate) => predicate(path));

export const DEFAULT_IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.busytown/**",
  "**/.DS_Store",
];

export type FileWatcherCleanup = () => Promise<void>;

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
  ignored = DEFAULT_IGNORED,
): FileWatcherCleanup => {
  // Compile the ignored patterns into a predicate function
  const isIgnored = any(ignored.map(glob));

  const watcher = watch(projectRoot, {
    ignoreInitial: true,
    ignored: isIgnored,
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
