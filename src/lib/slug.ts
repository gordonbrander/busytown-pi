import path from "node:path";

export const slugRegex = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

/** Check if value is a valid slug (lower kebab-case) */
export const isSlug = (value: string): boolean => {
  return slugRegex.test(value);
};

/** Check if value is a valid slug */
export const parseSlug = (slug: string): string => {
  if (!isSlug(slug)) {
    throw new TypeError(
      `Invalid slug: ${slug}. Slugs must be lowercase alphanumeric and dashes.`,
    );
  }
  return slug;
};

/** Converts a string to a slug (URL-friendly string). */
export const toSlug = (value: string): string | undefined => {
  const slug = value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .toLowerCase();
  return isSlug(slug) ? slug : undefined;
};

export const pathToSlug = (filePath: string): string | undefined => {
  const name = path.basename(filePath, path.extname(filePath));
  return toSlug(name);
};
