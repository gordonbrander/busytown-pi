import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { glob, any, DEFAULT_IGNORED } from "./file-watcher.ts";

describe("glob", () => {
  it("matches a glob pattern", () => {
    assert(glob("*.ts")("file-watcher.ts"));
    assert(glob("**/.busytown/**")(".busytown/events.db-wal"));
  });
});

describe("any + glob", () => {
  it("matches any glob pattern", () => {
    assert(any([glob("*.ts"), glob("**/.busytown/**")])("file-watcher.ts"));
  });

  it("matches default ignored", () => {
    assert(any(DEFAULT_IGNORED.map(glob))(".busytown/events.db-wal"));
  });
});
