// In-memory stand-ins for the engine's three sides, following the real server's rules. Used by tests.
import type {ChangesResponse, Manifest, Note, Vault, WriteResult} from "../api"
import {sha256Hex, sha256HexBytes} from "../hash"
import type {BaseStore, LocalFiles, RemoteVault, StoredBase} from "./SyncEngine"

export class FakeServer implements RemoteVault {
  notes = new Map<string, Note>()
  version = 0
  offline = false
  calls: string[] = []

  private check(op: string) {
    if (this.offline) throw new TypeError("Failed to fetch")
    this.calls.push(op)
  }

  /** Attachments' bytes, by hash. */
  blobs = new Map<string, Uint8Array>()

  /** A change made by some other device. */
  async put(path: string, content: string, deleted = false): Promise<Note> {
    return this.save(path, {content: deleted ? "" : content, hash: await sha256Hex(deleted ? "" : content), size: deleted ? 0 : content.length, attachment: false}, deleted)
  }

  /** An attachment saved by some other device. */
  async putAttachment(path: string, data: Uint8Array): Promise<Note> {
    const hash = await sha256HexBytes(data)
    this.blobs.set(hash, data)
    return this.save(path, {content: "", hash, size: data.byteLength, attachment: true})
  }

  private save(path: string, body: Pick<Note, "content" | "hash" | "size" | "attachment">, deleted = false): Note {
    const existing = this.notes.get(path)
    const note: Note = {
      _id: (existing?._id ?? `id:${path}`) as Note.ID,
      owner: "u" as Note["owner"],
      vault: "v" as Vault.ID,
      path,
      ...body,
      version: ++this.version,
      modifiedAt: new Date().toISOString(),
      deleted
    }
    this.notes.set(path, note)
    return note
  }

  async manifest(): Promise<Manifest> {
    this.check("manifest")
    return {
      notes: [...this.notes.values()].map(({path, version, hash, size, modifiedAt, deleted, attachment}) => ({path, version, hash, size, modifiedAt, deleted, attachment})),
      latestVersion: this.version
    }
  }

  async changes(since: number): Promise<ChangesResponse> {
    this.check(`changes ${since}`)
    const notes = [...this.notes.values()].filter((n) => n.version > since).sort((a, b) => a.version - b.version)
    return {notes, cursor: notes.at(-1)?.version ?? since, hasMore: false, latestVersion: this.version}
  }

  async read(path: string): Promise<Note | null> {
    this.check(`read ${path}`)
    const n = this.notes.get(path)
    return n && !n.deleted ? n : null
  }

  async write(path: string, content: string, baseVersion: number | null): Promise<WriteResult> {
    this.check(`write ${path}`)
    const existing = this.notes.get(path)
    if (existing && !existing.deleted) {
      if (existing.hash === (await sha256Hex(content))) return {success: true, note: existing}
      if (existing.version !== baseVersion) return {success: false, note: existing}
    }
    return {success: true, note: await this.put(path, content)}
  }

  async writeAttachment(path: string, data: Uint8Array, hash: string, baseVersion: number | null): Promise<WriteResult> {
    this.check(`write ${path}`)
    if ((await sha256HexBytes(data)) !== hash) throw new Error("hash mismatch")
    const existing = this.notes.get(path)
    if (existing && !existing.deleted) {
      if (existing.hash === hash) return {success: true, note: existing}
      if (existing.version !== baseVersion) return {success: false, note: existing}
    }
    return {success: true, note: await this.putAttachment(path, data)}
  }

  async downloadAttachment(hash: string): Promise<Uint8Array> {
    this.check(`download ${hash.slice(0, 8)}`)
    const data = this.blobs.get(hash)
    if (!data) throw new Error("404")
    return data
  }

  async delete(path: string, baseVersion: number | null): Promise<WriteResult> {
    this.check(`delete ${path}`)
    const existing = this.notes.get(path)
    if (!existing) throw new Error("404")
    if (existing.deleted) return {success: true, note: existing}
    if (baseVersion !== null && existing.version !== baseVersion) return {success: false, note: existing}
    return {success: true, note: this.save(path, {content: "", hash: await sha256Hex(""), size: 0, attachment: existing.attachment}, true)}
  }

  /** Every live file: notes' text, and attachments' bytes. */
  live(): Record<string, string | Uint8Array> {
    return Object.fromEntries(
      [...this.notes.values()].filter((n) => !n.deleted).map((n) => [n.path, n.attachment ? this.blobs.get(n.hash)! : n.content])
    )
  }
}

const hashOf = (f: string | Uint8Array) => (typeof f === "string" ? sha256Hex(f) : sha256HexBytes(f))

/** Files in memory: strings for text files, bytes for attachments. */
export class MemoryFiles implements LocalFiles {
  files = new Map<string, string | Uint8Array>()
  trash: string[] = []
  /** Runs just before a write lands, to simulate someone typing mid-sync. */
  beforeWrite?: (path: string) => void

  constructor(initial: Record<string, string | Uint8Array> = {}) {
    for (const [p, c] of Object.entries(initial)) this.files.set(p, c)
  }
  async list() {
    return [...this.files.keys()]
  }
  async read(path: string) {
    const f = this.files.get(path)
    if (f instanceof Uint8Array) throw new Error(`${path} is an attachment`)
    return f ?? null
  }
  async write(path: string, content: string, expected: string | null) {
    this.beforeWrite?.(path)
    if ((this.files.get(path) ?? null) !== expected) return false
    this.files.set(path, content)
    return true
  }
  async remove(path: string, expectedHash: string) {
    const f = this.files.get(path)
    if (f === undefined || (await hashOf(f)) !== expectedHash) return false
    this.files.delete(path)
    this.trash.push(path)
    return true
  }
  async readBytes(path: string) {
    const f = this.files.get(path)
    if (typeof f === "string") throw new Error(`${path} is text`)
    return f ?? null
  }
  async hashBytes(path: string) {
    const f = await this.readBytes(path)
    return f ? sha256HexBytes(f) : null
  }
  async writeBytes(path: string, data: Uint8Array, expectedHash: string | null) {
    this.beforeWrite?.(path)
    const f = this.files.get(path)
    if ((f === undefined ? null : await hashOf(f)) !== expectedHash) return false
    this.files.set(path, data)
    return true
  }
  snapshot() {
    return Object.fromEntries([...this.files.entries()].sort())
  }
}

export class MemoryBases implements BaseStore {
  bases = new Map<string, StoredBase>()
  cursor = 0
  async get(path: string) {
    return this.bases.get(path) ?? null
  }
  async set(path: string, base: StoredBase) {
    this.bases.set(path, base)
  }
  async delete(path: string) {
    this.bases.delete(path)
  }
  async paths() {
    return [...this.bases.keys()]
  }
  async getCursor() {
    return this.cursor
  }
  async setCursor(c: number) {
    this.cursor = c
  }
}
