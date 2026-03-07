import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { abortableSleep, nextTick } from "./promise.ts"

describe("abortableSleep", () => {
  it("resolves after delay", async () => {
    const controller = new AbortController()
    const start = Date.now()
    await abortableSleep(50, controller.signal)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 40, `Expected at least 40ms, got ${elapsed}ms`)
  })

  it("resolves immediately if already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    await abortableSleep(5000, controller.signal)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 100, `Expected fast resolution, got ${elapsed}ms`)
  })

  it("resolves early when aborted during sleep", async () => {
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 30)
    await abortableSleep(5000, controller.signal)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 200, `Expected early resolution, got ${elapsed}ms`)
  })
})

describe("nextTick", () => {
  it("resolves on next tick", async () => {
    let resolved = false
    const p = nextTick().then(() => {
      resolved = true
    })
    // Should not be resolved synchronously
    assert.equal(resolved, false)
    await p
    assert.equal(resolved, true)
  })
})
