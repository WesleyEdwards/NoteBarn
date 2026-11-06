/**
 * How well `query` matches `text` as an in-order subsequence (like "nap" in "Notes app"), or null if it doesn't.
 * Higher is better: matches at word starts, runs of consecutive letters, and shorter texts score higher.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "")
  if (!q) return 0
  const s = text.toLowerCase()
  let score = 0
  let qi = 0
  let prev = -2
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue
    const wordStart = i === 0 || /[\s/_\-.()]/.test(s[i - 1])
    score += 1 + (wordStart ? 3 : 0) + (prev === i - 1 ? 2 : 0)
    prev = i
    qi++
  }
  if (qi < q.length) return null
  // Typing a piece of the name as it's written beats letters scattered across words.
  const at = s.replace(/\s+/g, "").indexOf(q)
  if (at >= 0) score += 10 + (at === 0 ? 5 : 0)
  return score - s.length * 0.01
}

/** The paths matching `query`, best first. Matches in the note's name count for more than in its folder. */
export function fuzzyFilter(query: string, paths: readonly string[], limit = 50): string[] {
  const scored: {path: string; score: number}[] = []
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")
    const nameScore = fuzzyScore(query, name)
    const pathScore = fuzzyScore(query, path)
    const score = nameScore !== null ? nameScore + 10 : pathScore
    if (score !== null) scored.push({path, score})
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((s) => s.path)
}
