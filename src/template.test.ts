import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { renderTemplate } from "./template.ts"

describe("renderTemplate", () => {
  it("replaces double-brace with shell-escaped value", () => {
    const result = renderTemplate("echo {{name}}", { name: "hello" })
    assert.equal(result, "echo 'hello'")
  })

  it("replaces triple-brace with raw value (no escaping)", () => {
    const result = renderTemplate("echo {{{name}}}", { name: "hello world" })
    assert.equal(result, "echo hello world")
  })

  it("resolves nested dot paths", () => {
    const result = renderTemplate("{{event.type}}", {
      event: { type: "plan.request" },
    })
    assert.equal(result, "'plan.request'")
  })

  it("replaces missing keys with empty string", () => {
    const result = renderTemplate("hello {{missing}}", {})
    assert.equal(result, "hello ")
  })

  it("replaces missing triple-brace keys with empty string", () => {
    const result = renderTemplate("hello {{{missing}}}", {})
    assert.equal(result, "hello ")
  })

  it("shell-escapes values with single quotes in double-brace", () => {
    const result = renderTemplate("echo {{val}}", { val: "it's" })
    assert.equal(result, "echo 'it'\\''s'")
  })

  it("does not escape values in triple-brace", () => {
    const result = renderTemplate("echo {{{val}}}", { val: "it's" })
    assert.equal(result, "echo it's")
  })

  it("handles multiple replacements", () => {
    const result = renderTemplate("{{a}} and {{b}}", { a: "x", b: "y" })
    assert.equal(result, "'x' and 'y'")
  })

  it("handles null/undefined context values", () => {
    const result = renderTemplate("{{a}}", { a: null })
    assert.equal(result, "")
  })

  it("converts numbers to string", () => {
    const result = renderTemplate("{{{num}}}", { num: 42 })
    assert.equal(result, "42")
  })

  it("resolves deeply nested paths", () => {
    const result = renderTemplate("{{{a.b.c}}}", { a: { b: { c: "deep" } } })
    assert.equal(result, "deep")
  })
})
