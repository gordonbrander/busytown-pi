import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  killWithTimeout,
  processSystemOf,
  type ProcessFactory,
  type ProcessSystem,
} from "./process-system.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
};

/** Run body with a fresh system, guaranteeing dispose even on failure. */
const withSystem = async (
  body: (system: ProcessSystem) => Promise<void>,
): Promise<void> => {
  const system = processSystemOf();
  try {
    await body(system);
  } finally {
    await system.dispose();
  }
};

/** Factory for a long-running sleep process. */
const sleepFactory: ProcessFactory = () =>
  spawn("sleep", ["30"], { stdio: "ignore" });

/** Factory for a process that exits immediately with the given code. */
const exitFactory =
  (code: number): ProcessFactory =>
  () =>
    spawn("/bin/sh", ["-c", `exit ${code}`], { stdio: "ignore" });

describe("processSystemOf", () => {
  it("registers spawned processes in stats", () =>
    withSystem(async (system) => {
      system.spawn("a", sleepFactory);
      const stats = system.stats();
      assert.equal(stats.processes.length, 1);
      assert.equal(stats.processes[0]?.id, "a");
      assert.equal(stats.processes[0]?.state, "running");
      assert.equal(typeof stats.processes[0]?.pid, "number");
    }));

  it("throws on duplicate spawn id", () =>
    withSystem(async (system) => {
      system.spawn("dup", sleepFactory);
      assert.throws(() => system.spawn("dup", sleepFactory), /already exists/);
    }));

  it("kill terminates the process and removes it from stats", () =>
    withSystem(async (system) => {
      system.spawn("k", sleepFactory);
      await system.kill("k");
      assert.equal(system.stats().processes.length, 0);
    }));

  it("kill on unknown id is a no-op", () =>
    withSystem(async (system) => {
      await system.kill("nope");
    }));

  it("kill does not trigger a restart", () =>
    // Regression: without setting state="stopped" before SIGTERM, the
    // attach exit handler saw a non-zero signal exit and respawned.
    withSystem(async (system) => {
      let spawnCount = 0;
      const factory: ProcessFactory = () => {
        spawnCount++;
        return spawn("sleep", ["30"], { stdio: "ignore" });
      };
      system.spawn("once", factory);
      await system.kill("once");
      // First restart backoff is 1s — wait past it and confirm no respawn.
      await sleep(1500);
      assert.equal(spawnCount, 1);
    }));

  it("cleanly-exited process moves to state 'stopped'", () =>
    withSystem(async (system) => {
      system.spawn("clean", exitFactory(0));
      await waitFor(() => system.stats().processes[0]?.state === "stopped");
    }));

  it("non-zero exit triggers a restart", () =>
    withSystem(async (system) => {
      let spawnCount = 0;
      const factory: ProcessFactory = () => {
        spawnCount++;
        if (spawnCount === 1) {
          return spawn("/bin/sh", ["-c", "exit 1"], { stdio: "ignore" });
        }
        return spawn("sleep", ["30"], { stdio: "ignore" });
      };
      system.spawn("restart", factory);
      // First restart backoff is 1s.
      await waitFor(() => spawnCount === 2);
      const entry = system.stats().processes[0];
      assert.equal(entry?.restartCount, 1);
      assert.equal(entry?.state, "running");
    }));

  it("dispose terminates all running processes", async () => {
    const system = processSystemOf();
    system.spawn("a", sleepFactory);
    system.spawn("b", sleepFactory);
    await system.dispose();
    assert.equal(system.stats().processes.length, 0);
  });

  it("dispose does not hang on already-exited processes", async () => {
    // Regression: dispose used to call killWithTimeout on every managed
    // process without filtering out already-exited ones, and the timeout
    // branch of killWithTimeout could resolve never.
    const system = processSystemOf();
    system.spawn("gone", exitFactory(0));
    await waitFor(() => system.stats().processes[0]?.state === "stopped");
    await system.dispose();
    assert.equal(system.stats().processes.length, 0);
  });
});

describe("killWithTimeout", () => {
  // Short SIGKILL-escalation timeout so tests don't wait for the 5s default.
  const KILL_TIMEOUT_MS = 200;

  it("kills a running process with SIGTERM", async () => {
    const proc = spawn("sleep", ["30"], { stdio: "ignore" });
    const receipt = await killWithTimeout(proc, KILL_TIMEOUT_MS);
    assert.equal(receipt.signal, "SIGTERM");
    assert.equal(receipt.exitCode, undefined);
  });

  it("returns the exit code for an already-exited clean process", async () => {
    const proc = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    await new Promise<void>((r) => proc.once("exit", () => r()));
    const receipt = await killWithTimeout(proc, KILL_TIMEOUT_MS);
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.signal, undefined);
  });

  it("returns the exit code for an already-exited failing process", async () => {
    const proc = spawn("/bin/sh", ["-c", "exit 7"], { stdio: "ignore" });
    await new Promise<void>((r) => proc.once("exit", () => r()));
    const receipt = await killWithTimeout(proc, KILL_TIMEOUT_MS);
    assert.equal(receipt.exitCode, 7);
    assert.equal(receipt.signal, undefined);
  });

  it("escalates to SIGKILL after timeout if SIGTERM is ignored", async () => {
    // Node child that installs a no-op SIGTERM handler, so SIGTERM won't
    // terminate it — only SIGKILL (uncatchable) will.
    const proc = spawn(
      "node",
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: "ignore" },
    );
    // Give the child time to install its signal handler.
    await sleep(500);
    const receipt = await killWithTimeout(proc, KILL_TIMEOUT_MS);
    assert.equal(receipt.signal, "SIGKILL");
    assert.equal(receipt.exitCode, undefined);
  });
});
