import {dirname, joinPath} from "@notebarn/shared/paths"

const DAILY = /(^|\/)\d{4}-\d{2}-\d{2}\.md$/

/** Today's date the way daily notes are named: `2026-11-05`. */
export function dailyName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * Where today's daily note goes: in the folder that already holds the most daily notes (like Obsidian's "Daily"
 * folder), or at the top level if there aren't any yet.
 */
export function dailyPath(at: Date, paths: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const p of paths) if (DAILY.test(p)) counts.set(dirname(p), (counts.get(dirname(p)) ?? 0) + 1)
  const folder = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
  return joinPath(folder, `${dailyName(at)}.md`)
}
