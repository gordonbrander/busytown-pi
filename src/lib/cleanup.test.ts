import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cleanupGroup, cleanupGroupAsync } from "./cleanup.ts"

describe("cleanupGroup", () => {
  it("runs all added cleanup functions in reverse order", () => {
    const calls: number[] = []
    const cleanup = cleanupGroup()
    cleanup.add(() => calls.push(1))
    cleanup.add(() => calls.push(2))
    cleanup.add(() => calls.push(3))
    cleanup()
    assert.deepEqual(calls, [3, 2, 1])
  })

  it("clears cleanups after running", () => {
    let count = 0
    const cleanup = cleanupGroup()
    cleanup.add(() => count++)
    cleanup()
    cleanup()
    assert.equal(count, 1)
  })

  it("works with no cleanups added", () => {
    const cleanup = cleanupGroup()
    cleanup() // should not throw
  })

  it("runs the same function twice if added twice", () => {
    let count = 0
    const fn = () => count++
    const cleanup = cleanupGroup()
    cleanup.add(fn)
    cleanup.add(fn)
    cleanup()
    assert.equal(count, 2)
  })

  it("runs cleanups via using declaration", () => {
    let count = 0
    {
      using cleanup = cleanupGroup()
      cleanup.add(() => count++)
      cleanup.add(() => count++)
    }
    assert.equal(count, 2)
  })

  it("allows adding new cleanups after running", () => {
    const calls: string[] = []
    const cleanup = cleanupGroup()
    cleanup.add(() => calls.push("first"))
    cleanup()
    cleanup.add(() => calls.push("second"))
    cleanup()
    assert.deepEqual(calls, ["first", "second"])
  })
})

describe("cleanupGroupAsync", () => {
  it("runs all added async cleanup functions in reverse order", async () => {
    const calls: number[] = []
    const cleanup = cleanupGroupAsync()
    cleanup.add(async () => { calls.push(1) })
    cleanup.add(async () => { calls.push(2) })
    cleanup.add(async () => { calls.push(3) })
    await cleanup()
    assert.deepEqual(calls, [3, 2, 1])
  })

  it("runs cleanups sequentially in reverse order", async () => {
    const calls: string[] = []
    const cleanup = cleanupGroupAsync()
    cleanup.add(() => {
      calls.push("first-added")
    })
    cleanup.add(async () => {
      await new Promise((r) => setTimeout(r, 10))
      calls.push("slow")
    })
    cleanup.add(() => {
      calls.push("fast")
    })
    await cleanup()
    assert.deepEqual(calls, ["fast", "slow", "first-added"])
  })

  it("clears cleanups after running", async () => {
    let count = 0
    const cleanup = cleanupGroupAsync()
    cleanup.add(async () => { count++ })
    await cleanup()
    await cleanup()
    assert.equal(count, 1)
  })

  it("works with no cleanups added", async () => {
    const cleanup = cleanupGroupAsync()
    await cleanup() // should not throw
  })

  it("supports mix of sync and async cleanups", async () => {
    const calls: string[] = []
    const cleanup = cleanupGroupAsync()
    cleanup.add(() => {
      calls.push("sync")
    })
    cleanup.add(async () => {
      calls.push("async")
    })
    await cleanup()
    assert.deepEqual(calls, ["async", "sync"])
  })

  it("runs cleanups via await using declaration", async () => {
    let count = 0
    {
      await using cleanup = cleanupGroupAsync()
      cleanup.add(async () => { count++ })
      cleanup.add(() => { count++ })
    }
    assert.equal(count, 2)
  })

  it("runs the same function twice if added twice", async () => {
    let count = 0
    const fn = async () => { count++ }
    const cleanup = cleanupGroupAsync()
    cleanup.add(fn)
    cleanup.add(fn)
    await cleanup()
    assert.equal(count, 2)
  })
})
