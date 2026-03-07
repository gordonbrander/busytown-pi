import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { shellEscape } from "./shell.ts"

describe("shellEscape", () => {
  it("wraps simple string in single quotes", () => {
    assert.equal(shellEscape("hello"), "'hello'")
  })

  it("escapes single quotes", () => {
    assert.equal(shellEscape("it's"), "'it'\\''s'")
  })

  it("handles empty string", () => {
    assert.equal(shellEscape(""), "''")
  })

  it("wraps strings with spaces", () => {
    assert.equal(shellEscape("hello world"), "'hello world'")
  })

  it("wraps strings with special shell characters", () => {
    assert.equal(shellEscape("foo;bar"), "'foo;bar'")
    assert.equal(shellEscape("$(cmd)"), "'$(cmd)'")
  })

  it("handles multiple single quotes", () => {
    assert.equal(shellEscape("a'b'c"), "'a'\\''b'\\''c'")
  })
})
