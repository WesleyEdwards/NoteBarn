import type {ChangesResponse, Manifest, Note, Vault, WriteResult} from "../api"
import {isServerRejection} from "../errors"
import {sha256Hex, sha256HexBytes} from "../hash"
import {merge3} from "../merge"
import {conflictPath, isTextFile, mimeType} from "../paths"
import {type Base, type Decision, type ServerState, decide} from "./decide"

/**
 * The files on this device. Paths are vault paths like `Folder/Note.md`. Text files (see `isTextFile`) are read and
 * written as text; everything else is an attachment, read and written as bytes.
 */
export interface LocalFiles {
  /** Every file that should sync. */
  list(): Promise<string[]>
  /** A text file's text, or null if there's no such file. */
  read(path: string): Promise<string | null>
  /**
   * Writes a text file (making folders as needed), but only if it still holds `expected` (null: only if there's no
   * file). Returns false, changing nothing, if it doesn't: someone edited it in the meantime.
   */
  write(path: string, content: string, expected: string | null): Promise<boolean>
  /** Deletes the file (to the trash, where possible), but only if its hash is still `expectedHash`. */
  remove(path: string, expectedHash: string): Promise<boolean>
  /** An attachment's bytes, or null if there's no such file. */
  readBytes(path: string): Promise<Uint8Array | null>
  /** The SHA-256 (hex) of an attachment's bytes, or null if there's no such file. May be cached. */
  hashBytes(path: string): Promise<string | null>
  /** Writes an attachment (making folders as needed), but only if its hash is still `expectedHash` (null: no file). */
  writeBytes(path: string, data: Uint8Array, expectedHash: string | null): Promise<boolean>
}

export interface StoredBase extends Base {
  /** The text both sides agreed on, for merging. Empty for attachments, which can't be merged. */
  content: string
  attachment?: boolean
}

/** What this device and the server last agreed on, per path, and how far through the server's changes it's read. */
export interface BaseStore {
  get(path: string): Promise<StoredBase | null>
  set(path: string, base: StoredBase): Promise<void>
  delete(path: string): Promise<void>
  paths(): Promise<string[]>
  getCursor(): Promise<number>
  setCursor(cursor: number): Promise<void>
}

/** The server's side of one vault. */
export interface RemoteVault {
  manifest(): Promise<Manifest>
  changes(since: number): Promise<ChangesResponse>
  read(path: string): Promise<Note | null>
  write(path: string, content: string, baseVersion: number | null): Promise<WriteResult>
  delete(path: string, baseVersion: number | null): Promise<WriteResult>
  /** Uploads an attachment's bytes (unless the server has them already) and saves it at `path`, like `write`. */
  writeAttachment(path: string, data: Uint8Array, hash: string, baseVersion: number | null): Promise<WriteResult>
  /** An attachment's bytes, by hash. */
  downloadAttachment(hash: string): Promise<Uint8Array>
}

/**
 * Moves bytes to and from the links the server hands out for attachments. Separate from the API client since each
 * app does it its own way (Obsidian's requestUrl, the browser's fetch). Like the API client, it throws a TypeError
 * when there's no connection and an HttpError when the other end refuses.
 */
export interface ByteTransfer {
  put(url: string, data: Uint8Array, contentType: string): Promise<void>
  get(url: string): Promise<Uint8Array>
}

/** Wraps the generated API client for one vault. */
export function remoteVault(
  api: {
    note: {
      vaultManifest(v: Vault.ID): Promise<Manifest>
      noteChanges(i: {vault: Vault.ID; since: number; limit: number}): Promise<ChangesResponse>
      readNote(i: {vault: Vault.ID; path: string}): Promise<Note | null | undefined>
      writeNote(i: {vault: Vault.ID; path: string; content: string; baseVersion: number | null}): Promise<WriteResult>
      deleteNote(i: {vault: Vault.ID; path: string; baseVersion: number | null}): Promise<WriteResult>
      attachmentUpload(i: {vault: Vault.ID; hash: string; size: number}): Promise<{uploadUrl: string | null | undefined}>
      writeAttachment(i: {vault: Vault.ID; path: string; hash: string; baseVersion: number | null}): Promise<WriteResult>
      attachmentLinks(i: {vault: Vault.ID; hashes: string[]}): Promise<string[]>
    }
  },
  vault: Vault.ID,
  transfer: ByteTransfer
): RemoteVault {
  return {
    manifest: () => api.note.vaultManifest(vault),
    changes: (since) => api.note.noteChanges({vault, since, limit: 200}),
    read: async (path) => (await api.note.readNote({vault, path})) ?? null,
    write: (path, content, baseVersion) => api.note.writeNote({vault, path, content, baseVersion}),
    delete: (path, baseVersion) => api.note.deleteNote({vault, path, baseVersion}),
    async writeAttachment(path, data, hash, baseVersion) {
      const {uploadUrl} = await api.note.attachmentUpload({vault, hash, size: data.byteLength})
      if (uploadUrl) await transfer.put(uploadUrl, data, mimeType(path))
      return api.note.writeAttachment({vault, path, hash, baseVersion})
    },
    async downloadAttachment(hash) {
      const [url] = await api.note.attachmentLinks({vault, hashes: [hash]})
      const data = await transfer.get(url)
      if ((await sha256HexBytes(data)) !== hash) throw new Error("A downloaded attachment didn't match its hash. It will be tried again.")
      return data
    }
  }
}

export type SyncStatus = "idle" | "syncing" | "offline" | "error"

export interface SyncAction {
  path: string
  decision: Decision["kind"]
  /** For conflicts: where the local copy went. */
  detail?: string
}

export interface SyncEvents {
  onStatus?(status: SyncStatus, message?: string): void
  /** Something happened (or, in a dry run, would happen). */
  onAction?(action: SyncAction): void
  /** Edits couldn't be merged, so the local version was kept as `copyPath`. */
  onConflict?(path: string, copyPath: string): void
}

export interface SyncEngineOptions {
  /** Which paths sync at all. Defaults to everything. */
  isSyncable?: (path: string) => boolean
  now?: () => Date
}

interface Change {
  path: string
  /** What the server has, if known. Content is included when it came with the change. */
  server?: (ServerState & {content?: string}) | null
}

/** Too many decisions in one pass for the same path means something keeps changing under us; leave it for later. */
const MAX_ROUNDS = 4

/**
 * Keeps a folder of files and a server vault in step. All work goes through one queue, so it never handles two
 * things at once. Every write on either side is conditional on that side still holding what the engine last saw,
 * so an edit made mid-sync is never overwritten; the file is simply looked at again.
 */
export class SyncEngine {
  private queue: Promise<unknown> = Promise.resolve()
  private status: SyncStatus = "idle"
  private readonly isSyncable: (path: string) => boolean
  private readonly now: () => Date

  constructor(
    private readonly local: LocalFiles,
    private readonly bases: BaseStore,
    private readonly remote: RemoteVault,
    private readonly events: SyncEvents = {},
    options: SyncEngineOptions = {}
  ) {
    this.isSyncable = options.isSyncable ?? (() => true)
    this.now = options.now ?? (() => new Date())
  }

  get currentStatus() {
    return this.status
  }

  /**
   * Compares everything: every local file, every base, and the server's whole manifest. Run at startup and now and
   * then, since it also catches anything polling missed. With `dryRun`, only reports what it would do.
   */
  fullSync(dryRun = false): Promise<SyncAction[]> {
    return this.run(async () => {
      const manifest = await this.remote.manifest()
      const server = new Map(manifest.notes.filter((n) => this.isSyncable(n.path)).map((n) => [n.path, n]))
      const localPaths = (await this.local.list()).filter(this.isSyncable)
      const paths = new Set([...localPaths, ...(await this.bases.paths()), ...server.keys()])

      const actions: SyncAction[] = []
      const downloads: string[] = []
      const plan: {path: string; local: string | null; server: ServerState | null}[] = []
      for (const path of [...paths].sort()) {
        const {hash: local} = await this.readLocal(path)
        const s = server.get(path) ?? null
        const decision = decide(local, await this.bases.get(path), s)
        if (decision.kind === "none") continue
        actions.push({path, decision: decision.kind})
        const needsText = decision.kind === "download" || decision.kind === "merge" || decision.kind === "conflict"
        if (needsText && isTextFile(path)) downloads.push(path)
        plan.push({path, local, server: s})
      }
      if (dryRun) {
        actions.forEach((a) => this.events.onAction?.(a))
        return actions
      }

      // Many downloads (a first sync, say): fetch contents in pages instead of one request per file.
      const contents = downloads.length > 20 ? await this.fetchAll(new Set(downloads)) : new Map<string, Note>()
      for (const item of plan) {
        const known = contents.get(item.path)
        await this.syncPath({path: item.path, server: known ?? item.server})
      }
      await this.bases.setCursor(Math.max(await this.bases.getCursor(), manifest.latestVersion))
      return actions
    })
  }

  /** Brings in whatever changed on the server since last time. Run every few seconds. */
  pull(): Promise<void> {
    return this.run(async () => {
      let cursor = await this.bases.getCursor()
      for (;;) {
        const page = await this.remote.changes(cursor)
        for (const note of page.notes) {
          if (this.isSyncable(note.path)) await this.syncPath({path: note.path, server: note})
        }
        cursor = page.cursor
        await this.bases.setCursor(cursor)
        if (!page.hasMore) break
      }
    })
  }

  /** A local file was created, edited or deleted: send that to the server. */
  localChanged(path: string): Promise<void> {
    if (!this.isSyncable(path)) return Promise.resolve()
    return this.run(() => this.syncPath({path}))
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      this.setStatus("syncing")
      try {
        const value = await task()
        this.setStatus("idle")
        return value
      } catch (e) {
        if (isServerRejection(e)) this.setStatus("error", e instanceof Error ? e.message : `The server refused (${statusOf(e)})`)
        else this.setStatus("offline", e instanceof Error ? e.message : String(e))
        throw e
      }
    })
    this.queue = result.catch(() => {})
    return result
  }

  private setStatus(status: SyncStatus, message?: string) {
    if (status === this.status && !message) return
    this.status = status
    this.events.onStatus?.(status, message)
  }

  private async fetchAll(wanted: Set<string>): Promise<Map<string, Note>> {
    const found = new Map<string, Note>()
    let since = 0
    for (;;) {
      const page = await this.remote.changes(since)
      for (const n of page.notes) if (wanted.has(n.path)) found.set(n.path, n)
      since = page.cursor
      if (!page.hasMore) break
    }
    return found
  }

  /** The local file's hash, and its text if it's a text file. Both null if there's no file. */
  private async readLocal(path: string): Promise<{hash: string | null; text: string | null}> {
    if (!isTextFile(path)) return {hash: await this.local.hashBytes(path), text: null}
    const text = await this.local.read(path)
    return {hash: text === null ? null : await sha256Hex(text), text}
  }

  /** Decides and acts for one path until both sides agree (or it's clear something else is changing it). */
  private async syncPath(change: Change): Promise<void> {
    let server = change.server
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const {hash: localHash, text: content} = await this.readLocal(change.path)
      const base = await this.bases.get(change.path)

      // A local change with nothing known about the server: assume it's still at base, and let the server say if not.
      const assumed: ServerState | null =
        server !== undefined ? server : base ? {version: base.version, hash: base.hash, deleted: false} : null
      const decision = decide(localHash, base, assumed)
      if (decision.kind === "none") return

      const next = isTextFile(change.path)
        ? await this.act(change.path, decision, content, localHash, base, server ?? null)
        : await this.actOnAttachment(change.path, decision, localHash, server ?? null)
      if (next === "done") {
        this.events.onAction?.({path: change.path, decision: decision.kind})
        return
      }
      // Something changed under us: `next` is what the server has now (or undefined to look again).
      server = next === "again" ? server : next
    }
  }

  /**
   * Carries out one decision. Returns "done", "again" (the local file changed meanwhile), or the server's current
   * state when the server refused because it had moved on.
   */
  private async act(
    path: string,
    decision: Decision,
    content: string | null,
    localHash: string | null,
    base: StoredBase | null,
    server: (ServerState & {content?: string}) | null
  ): Promise<"done" | "again" | (ServerState & {content?: string}) | null> {
    switch (decision.kind) {
      case "none":
        return "done"

      case "adopt":
        await this.bases.set(path, {version: server!.version, hash: server!.hash, content: content!})
        return "done"

      case "forget":
        await this.bases.delete(path)
        return "done"

      case "upload": {
        const result = await this.remote.write(path, content!, decision.baseVersion)
        if (result.success && result.note) {
          await this.remember(result.note)
          return "done"
        }
        return result.note ?? null
      }

      case "download": {
        const note = await this.serverContent(path, server)
        if (!note) return null
        if (!(await this.local.write(path, note.content, content))) return "again"
        await this.bases.set(path, {version: note.version, hash: note.hash, content: note.content})
        return "done"
      }

      case "deleteRemote": {
        const result = await this.remote.delete(path, decision.baseVersion)
        if (result.success) {
          await this.bases.delete(path)
          return "done"
        }
        return result.note ?? null
      }

      case "deleteLocal": {
        if (!(await this.local.remove(path, localHash!))) return "again"
        await this.bases.delete(path)
        return "done"
      }

      case "merge": {
        const note = await this.serverContent(path, server)
        if (!note) return null
        const merged = merge3(base!.content, content!, note.content)
        if (!merged.clean) return this.keepBoth(path, content!, note)
        if (merged.text !== content && !(await this.local.write(path, merged.text, content))) return "again"
        if (merged.text === note.content) {
          await this.bases.set(path, {version: note.version, hash: note.hash, content: note.content})
          return "done"
        }
        const result = await this.remote.write(path, merged.text, note.version)
        if (result.success && result.note) {
          await this.remember(result.note)
          return "done"
        }
        return result.note ?? null
      }

      case "conflict": {
        const note = await this.serverContent(path, server)
        if (!note) return null
        return this.keepBoth(path, content!, note)
      }
    }
  }

  /**
   * Like `act`, for an attachment: its bytes go up and down whole, and since they can't be merged, changes on both
   * sides keep both (the server's at the path, this device's as a conflict copy).
   */
  private async actOnAttachment(
    path: string,
    decision: Decision,
    localHash: string | null,
    known: (ServerState & {content?: string}) | null
  ): Promise<"done" | "again" | (ServerState & {content?: string}) | null> {
    switch (decision.kind) {
      case "none":
        return "done"

      case "adopt":
        await this.bases.set(path, {version: known!.version, hash: known!.hash, content: "", attachment: true})
        return "done"

      case "forget":
        await this.bases.delete(path)
        return "done"

      case "upload": {
        const data = await this.local.readBytes(path)
        if (!data || (await sha256HexBytes(data)) !== localHash) return "again"
        const result = await this.remote.writeAttachment(path, data, localHash, decision.baseVersion)
        if (result.success && result.note) {
          await this.remember(result.note)
          return "done"
        }
        return result.note ?? null
      }

      case "download": {
        const server = await this.serverState(path, known)
        if (!server) return null
        const data = await this.remote.downloadAttachment(server.hash)
        if (!(await this.local.writeBytes(path, data, localHash))) return "again"
        await this.bases.set(path, {version: server.version, hash: server.hash, content: "", attachment: true})
        return "done"
      }

      case "deleteRemote": {
        const result = await this.remote.delete(path, decision.baseVersion)
        if (result.success) {
          await this.bases.delete(path)
          return "done"
        }
        return result.note ?? null
      }

      case "deleteLocal": {
        if (!(await this.local.remove(path, localHash!))) return "again"
        await this.bases.delete(path)
        return "done"
      }

      case "merge":
      case "conflict": {
        const server = await this.serverState(path, known)
        if (!server) return null
        const mine = await this.local.readBytes(path)
        if (!mine || (await sha256HexBytes(mine)) !== localHash) return "again"
        const theirs = await this.remote.downloadAttachment(server.hash)
        const taken = [...(await this.local.list()), ...(await this.bases.paths())]
        const copyPath = conflictPath(path, this.now(), taken)
        if (!(await this.local.writeBytes(copyPath, mine, null))) return "again"
        if (!(await this.local.writeBytes(path, theirs, localHash))) return "again"
        await this.bases.set(path, {version: server.version, hash: server.hash, content: "", attachment: true})
        const copy = await this.remote.writeAttachment(copyPath, mine, localHash!, null)
        if (copy.success && copy.note) await this.remember(copy.note)
        this.events.onConflict?.(path, copyPath)
        return "done"
      }
    }
  }

  /** What the server has at `path`, from what's already known or by asking. Null if it's gone. */
  private async serverState(path: string, known: ServerState | null): Promise<ServerState | null> {
    if (known && !known.deleted) return known
    const note = await this.remote.read(path)
    return note && !note.deleted ? note : null
  }

  /** Puts the server's version at `path` and the local text in a conflict copy next to it, on both sides. */
  private async keepBoth(path: string, mine: string, theirs: Note | (ServerState & {content: string})) {
    const taken = [...(await this.local.list()), ...(await this.bases.paths())]
    const copyPath = conflictPath(path, this.now(), taken)
    if (!(await this.local.write(copyPath, mine, null))) return "again" as const
    if (!(await this.local.write(path, theirs.content, mine))) return "again" as const
    await this.bases.set(path, {version: theirs.version, hash: theirs.hash, content: theirs.content})
    const copy = await this.remote.write(copyPath, mine, null)
    if (copy.success && copy.note) await this.remember(copy.note)
    this.events.onConflict?.(path, copyPath)
    return "done" as const
  }

  private async remember(note: Note) {
    await this.bases.set(note.path, {version: note.version, hash: note.hash, content: note.content, ...(note.attachment ? {attachment: true} : {})})
  }

  /** The server's copy with its content, from what's already known or by asking. Null if it's gone. */
  private async serverContent(path: string, known: (ServerState & {content?: string}) | null) {
    if (known && !known.deleted && known.content !== undefined) return {...known, content: known.content}
    const note = await this.remote.read(path)
    return note && !note.deleted ? note : null
  }
}

function statusOf(e: unknown): string {
  return typeof e === "object" && e && "status" in e ? String((e as {status: unknown}).status) : "?"
}
