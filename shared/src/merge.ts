import {diff3Merge, diffComm} from "node-diff3"

export type MergeResult = {clean: true; text: string} | {clean: false}

/**
 * Combines my edits and their edits to the same note, both made from `base`, line by line. Changes to different lines
 * merge cleanly. When both sides only added lines at the same place (say, each appended to a list), both additions are
 * kept, mine first. Any other overlapping change can't be merged.
 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs || theirs === base) return {clean: true, text: mine}
  if (mine === base) return {clean: true, text: theirs}

  const regions = diff3Merge(mine.split("\n"), base.split("\n"), theirs.split("\n"), {excludeFalseConflicts: true})
  const out: string[] = []
  for (const region of regions) {
    if (region.ok) {
      out.push(...region.ok)
    } else if (region.conflict) {
      const {a, o, b} = region.conflict
      if (o.length === 0) out.push(...a, ...b)
      else return {clean: false}
    }
  }
  return {clean: true, text: out.join("\n")}
}

export interface DiffLine {
  kind: "same" | "added" | "removed"
  text: string
}

/** What changed from `before` to `after`, line by line, for showing an old version against the current one. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const part of diffComm(before.split("\n"), after.split("\n"))) {
    if (part.common) for (const text of part.common) out.push({kind: "same", text})
    else {
      for (const text of part.buffer1 ?? []) out.push({kind: "removed", text})
      for (const text of part.buffer2 ?? []) out.push({kind: "added", text})
    }
  }
  return out
}
