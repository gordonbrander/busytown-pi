import path from "node:path"

export const toSlug = (value: string): string | undefined => {
  const slug = value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .toLowerCase()
  return slug || undefined
}

export const pathToSlug = (filePath: string): string | undefined => {
  const name = path.basename(filePath, path.extname(filePath))
  return toSlug(name)
}
