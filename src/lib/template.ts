import { shellEscape } from "./shell.ts"

const resolvePath = (obj: unknown, dotPath: string): unknown => {
  const segments = dotPath.split(".")
  let current: unknown = obj
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[seg]
  }
  return current
}

export const renderTemplate = (template: string, context: Record<string, unknown>): string => {
  // Triple-brace first (raw, no escaping)
  let result = template.replace(/\{\{\{(\w[\w.]*)\}\}\}/g, (_match, key: string) => {
    const value = resolvePath(context, key)
    return value == null ? "" : String(value)
  })

  // Double-brace (shell-escaped)
  result = result.replace(/\{\{(\w[\w.]*)\}\}/g, (_match, key: string) => {
    const value = resolvePath(context, key)
    return value == null ? "" : shellEscape(String(value))
  })

  return result
}
