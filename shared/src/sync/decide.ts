/**
 * What to do with one file, given three views of it:
 * - local: what's on this device now (its hash, or null if there's no file)
 * - base: what this device and the server last agreed on (null if they never have)
 * - server: what the server has now (null if it never had it; `deleted` if it was deleted)
 *
 * "Changed" always means "differs from base". The rules, in short: one-sided changes go to the other side; changes on
 * both sides are merged; an edit beats a delete; and nothing is ever deleted from a side unless that side still has
 * exactly the base (so a first sync, with no bases, never deletes anything).
 */

export interface Base {
  version: number
  hash: string
}

export interface ServerState {
  version: number
  hash: string
  deleted: boolean
}

export type Decision =
  | {kind: "none"}
  /** Remember that both sides agree (they have the same content already). */
  | {kind: "adopt"}
  /** Send the local file. `baseVersion` is what the server must still be at (null: it must have no live note). */
  | {kind: "upload"; baseVersion: number | null}
  /** Bring the server's copy here. */
  | {kind: "download"}
  /** Both changed since base: three-way merge. */
  | {kind: "merge"}
  /** Both have the file but never agreed on it: keep the server's at the path and the local one as a conflict copy. */
  | {kind: "conflict"}
  /** Deleted here and unchanged on the server: delete it there. */
  | {kind: "deleteRemote"; baseVersion: number}
  /** Deleted on the server and unchanged here: delete it here. */
  | {kind: "deleteLocal"}
  /** Gone on both sides: forget the base. */
  | {kind: "forget"}

export function decide(local: string | null, base: Base | null, server: ServerState | null): Decision {
  const live = server && !server.deleted ? server : null

  if (local !== null && live) {
    if (local === live.hash) return base && base.version === live.version && base.hash === local ? {kind: "none"} : {kind: "adopt"}
    if (!base) return {kind: "conflict"}
    const localChanged = local !== base.hash
    const serverChanged = live.version !== base.version
    if (localChanged && serverChanged) return {kind: "merge"}
    if (localChanged) return {kind: "upload", baseVersion: base.version}
    if (serverChanged) return {kind: "download"}
    return {kind: "none"}
  }

  if (local !== null) {
    // The server has no live copy: it never had one, or it was deleted.
    if (server?.deleted && base && local === base.hash && server.version !== base.version) return {kind: "deleteLocal"}
    // New here, edited here after a delete there (edits win), or the server lost it: send it.
    return {kind: "upload", baseVersion: null}
  }

  if (live) {
    if (!base) return {kind: "download"}
    // Deleted here. If the server changed it since, the edit wins and comes back; otherwise delete it there.
    if (live.version !== base.version) return {kind: "download"}
    return {kind: "deleteRemote", baseVersion: base.version}
  }

  return base ? {kind: "forget"} : {kind: "none"}
}
