import type {Condition} from "@lightningkite/lightning-server-simplified"
import type {Api, Note, Vault} from "@notebarn/shared/api"
import {linkingLines, rewriteLinks} from "@notebarn/shared/links"
import {basename, isMarkdown, isTextFile, noteTitle} from "@notebarn/shared/paths"
import {noteCache} from "./noteCache"
import type {VaultStore} from "./VaultStore"

/** Every markdown note in the vault whose text contains any of `needles` (ignoring case), with its content. */
export async function notesContaining(api: Api, vault: Vault.ID, needles: string[]): Promise<Note[]> {
  const unique = [...new Set(needles.map((n) => n.trim()).filter(Boolean))]
  if (unique.length === 0) return []
  const contains: Condition<Note>[] = unique.map((value) => ({content: {StringContains: {value, ignoreCase: true}}}))
  const condition: Condition<Note> = {
    And: [
      {vault: {Equal: vault}},
      {deleted: {Equal: false}},
      {attachment: {Equal: false}},
      contains.length === 1 ? contains[0] : {Or: contains}
    ]
  }
  const notes = await api.note.query({condition, limit: 1000})
  return notes.filter((n) => isMarkdown(n.path))
}

/** What a link to `path` has to contain, whichever way it's written. */
const linkNeedle = (path: string) => (isMarkdown(path) ? noteTitle(path) : basename(path))

export interface Backlink {
  path: string
  lines: string[]
}

/** The notes that link to `path`, with the lines the links are on. */
export async function backlinks(api: Api, vault: Vault.ID, path: string, paths: readonly string[]): Promise<Backlink[]> {
  const notes = await notesContaining(api, vault, [linkNeedle(path)])
  return notes
    .filter((n) => n.path !== path)
    .map((n) => ({path: n.path, lines: linkingLines(n.content, n.path, path, paths)}))
    .filter((b) => b.lines.length > 0)
    .sort((a, b) => noteTitle(a.path).localeCompare(noteTitle(b.path), undefined, {numeric: true}))
}

export interface MoveResult {
  /** Moves that happened, old path to new. */
  moved: Map<string, string>
  failed: string[]
  /** How many other notes had links updated. */
  relinked: number
}

/**
 * Moves files (one, or everything in a folder), then points links in other notes at the new paths, like Obsidian.
 * Each move fails on its own (say, the new path is taken), without stopping the rest.
 */
export async function moveFiles(
  api: Api,
  store: VaultStore,
  vault: Vault.ID,
  moves: ReadonlyArray<readonly [string, string]>,
  /** Called once the files have moved, before links are updated (which can take a moment). */
  onMoved?: (moved: ReadonlyMap<string, string>) => void
): Promise<MoveResult> {
  const pathsBefore = [...store.getSnapshot().paths]
  const moved = new Map<string, string>()
  const failed: string[] = []
  for (const [from, to] of moves) {
    if (from === to) continue
    try {
      const result = await api.note.renameNote({vault, from, to, baseVersion: null})
      if (!result.success || !result.note) throw new Error("Not moved")
      store.noteSaved(result.note)
      const cached = noteCache.get(vault, from)
      noteCache.remove(vault, from)
      if (cached && isTextFile(to)) noteCache.put(result.note)
      moved.set(from, to)
    } catch {
      failed.push(from)
    }
  }
  // Before hearing about the moves, so whatever had a moved file open follows it instead of seeing it deleted.
  onMoved?.(moved)
  if (moved.size > 0) await store.poll()
  let relinked = 0
  if (moved.size > 0) {
    try {
      relinked = await updateLinks(api, vault, moved, pathsBefore, store.getSnapshot().paths)
    } catch {
      // The moves happened; links just weren't updated.
    }
  }
  return {moved, failed, relinked}
}

/** Rewrites links to moved files in every note that has one. Returns how many notes changed. */
async function updateLinks(
  api: Api,
  vault: Vault.ID,
  moved: ReadonlyMap<string, string>,
  pathsBefore: readonly string[],
  pathsAfter: readonly string[]
): Promise<number> {
  const needles = [...moved.keys()].map(linkNeedle)
  // A folder full of moves can ask about a lot of names; ask in groups.
  const candidates = new Map<string, Note>()
  for (let i = 0; i < needles.length; i += 40) {
    for (const n of await notesContaining(api, vault, needles.slice(i, i + 40))) candidates.set(n.path, n)
  }
  const back = new Map([...moved].map(([from, to]) => [to, from]))
  let changed = 0
  for (const note of candidates.values()) {
    let current: Note = note
    // Twice, in case the note changed between reading and writing it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = back.get(current.path) ?? current.path
      const text = rewriteLinks(current.content, before, moved, pathsBefore, pathsAfter)
      if (text === current.content) break
      const result = await api.note.writeNote({vault, path: current.path, content: text, baseVersion: current.version})
      if (result.success) {
        changed++
        break
      }
      if (!result.note || result.note.deleted) break
      current = result.note
    }
  }
  return changed
}

/** Enough to put a deleted file back. */
export interface Deleted {
  path: string
  content: string
  attachment: boolean
  hash: string
}

/** Deletes files, remembering what they held so `restore` can bring them back. */
export async function deleteFiles(api: Api, store: VaultStore, vault: Vault.ID, paths: string[]): Promise<{deleted: Deleted[]; failed: string[]}> {
  const deleted: Deleted[] = []
  const failed: string[] = []
  for (const path of paths) {
    try {
      const note = await api.note.readNote({vault, path})
      if (note) {
        await api.note.deleteNote({vault, path, baseVersion: note.version})
        deleted.push({path, content: note.content, attachment: note.attachment, hash: note.hash})
      }
      noteCache.remove(vault, path)
    } catch {
      failed.push(path)
    }
  }
  await store.poll()
  return {deleted, failed}
}

/** Puts deleted files back where they were (the bytes of attachments are still on the server). */
export async function restoreFiles(api: Api, store: VaultStore, vault: Vault.ID, files: Deleted[]): Promise<number> {
  let restored = 0
  for (const f of files) {
    try {
      const result = f.attachment
        ? await api.note.writeAttachment({vault, path: f.path, hash: f.hash, baseVersion: null})
        : await api.note.writeNote({vault, path: f.path, content: f.content, baseVersion: null})
      if (result.note) store.noteSaved(result.note)
      if (result.success) restored++
    } catch {
      // Keep going with the rest.
    }
  }
  await store.poll()
  return restored
}

/** A copy of a file next to it, as `Name 1.md`. */
export async function duplicateFile(api: Api, store: VaultStore, vault: Vault.ID, path: string, to: string): Promise<Note> {
  const note = await api.note.readNote({vault, path})
  if (!note) throw new Error("It isn't there anymore.")
  const result = note.attachment
    ? await api.note.writeAttachment({vault, path: to, hash: note.hash, baseVersion: null})
    : await api.note.writeNote({vault, path: to, content: note.content, baseVersion: null})
  if (!result.success || !result.note) throw new Error("There's already a file there.")
  store.noteSaved(result.note)
  return result.note
}
