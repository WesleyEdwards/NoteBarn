import type {DataAdapter} from "obsidian"
import type {BaseStore, StoredBase} from "@notebarn/shared/sync/SyncEngine"

interface Index {
  vault: string
  cursor: number
  /** path → [version, hash], plus 1 for an attachment (whose bytes aren't kept, since they're never merged) */
  entries: Record<string, [number, string] | [number, string, 1]>
  /** Attachments' hashes, so they aren't read again at every start: path → [mtime, size, hash] */
  fileHashes?: Record<string, [number, number, string]>
}

/** Remembers the hash of a file's bytes while its modified time and size stay the same. */
export interface HashCache {
  get(path: string, mtime: number, size: number): string | null
  set(path: string, mtime: number, size: number, hash: string): void
}

/**
 * Keeps each file's last-synced state in the plugin's folder (inside .obsidian, so it doesn't show up as notes):
 * a small index, plus each base's text stored once under its hash. Everything is held in memory too; the index is
 * written a moment after changes, and on unload.
 */
export class PluginBaseStore implements BaseStore {
  private index: Index
  private saveTimer: number | null = null
  private readonly indexPath: string
  private readonly contentDir: string

  private constructor(
    private readonly adapter: DataAdapter,
    dir: string,
    index: Index
  ) {
    this.indexPath = `${dir}/sync-state.json`
    this.contentDir = `${dir}/bases`
    this.index = index
  }

  /** Loads the saved state, starting fresh if it was for a different server vault. */
  static async load(adapter: DataAdapter, dir: string, vault: string): Promise<PluginBaseStore> {
    let index: Index = {vault, cursor: 0, entries: {}}
    try {
      const saved = JSON.parse(await adapter.read(`${dir}/sync-state.json`)) as Index
      if (saved.vault === vault) index = saved
    } catch {
      // Nothing saved yet.
    }
    if (!(await adapter.exists(`${dir}/bases`))) await adapter.mkdir(`${dir}/bases`)
    return new PluginBaseStore(adapter, dir, index)
  }

  /** Kept with the sync state, and saved with it. */
  readonly hashCache: HashCache = {
    get: (path, mtime, size) => {
      const known = this.index.fileHashes?.[path]
      return known && known[0] === mtime && known[1] === size ? known[2] : null
    },
    set: (path, mtime, size, hash) => {
      this.index.fileHashes ??= {}
      this.index.fileHashes[path] = [mtime, size, hash]
      this.scheduleSave()
    }
  }

  get size() {
    return Object.keys(this.index.entries).length
  }

  async get(path: string): Promise<StoredBase | null> {
    const entry = this.index.entries[path]
    if (!entry) return null
    const [version, hash, attachment] = entry
    if (attachment) return {version, hash, content: "", attachment: true}
    try {
      return {version, hash, content: await this.adapter.read(this.contentPath(hash))}
    } catch {
      // The text is missing (cleaned up by hand?). Without it a merge can't work, so treat this file as never synced.
      return null
    }
  }

  async set(path: string, base: StoredBase) {
    if (base.attachment) {
      this.index.entries[path] = [base.version, base.hash, 1]
      this.scheduleSave()
      return
    }
    const file = this.contentPath(base.hash)
    if (!(await this.adapter.exists(file))) await this.adapter.write(file, base.content)
    this.index.entries[path] = [base.version, base.hash]
    this.scheduleSave()
  }

  async delete(path: string) {
    delete this.index.entries[path]
    this.scheduleSave()
  }

  async paths() {
    return Object.keys(this.index.entries)
  }

  async getCursor() {
    return this.index.cursor
  }

  async setCursor(cursor: number) {
    if (cursor === this.index.cursor) return
    this.index.cursor = cursor
    this.scheduleSave()
  }

  /** Deletes stored texts no file refers to any more, and remembered hashes of files that are gone. */
  async cleanUp(exists: (path: string) => boolean = () => true) {
    for (const path of Object.keys(this.index.fileHashes ?? {})) if (!exists(path)) delete this.index.fileHashes![path]
    const used = new Set(Object.values(this.index.entries).filter((e) => !e[2]).map(([, hash]) => this.contentPath(hash)))
    const {files} = await this.adapter.list(this.contentDir)
    for (const f of files) if (!used.has(f)) await this.adapter.remove(f)
  }

  async save() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
    await this.adapter.write(this.indexPath, JSON.stringify(this.index))
  }

  private scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.save(), 500)
  }

  private contentPath(hash: string) {
    return `${this.contentDir}/${hash}.txt`
  }
}
