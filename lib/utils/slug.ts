/**
 * Slug utilities for marketplace routing
 */

/**
 * Convert GitHub repo path to URL-safe slug
 * Example: "anthropics/claude-code" -> "anthropics-claude-code"
 */
export function repoToSlug(repo: string): string {
  return repo.replace(/\//g, '-').toLowerCase();
}
