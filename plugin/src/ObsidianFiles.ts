import {type App, TFile} from "obsidian"
import type {LocalFiles} from "@notebarn/shared/sync/SyncEngine"
import {sha256Hex, sha256HexBytes} from "@notebarn/shared/hash"
import {dirname, isTextFile} from "@notebarn/shared/paths"
import type {HashCache} from "./PluginBaseStore"

/** Attachments bigger than this aren't synced (the server's limit). */
export const MAX_ATTACHMENT_BYTES = 100_000_000

/**
 * The vault's files, as the sync engine sees them. Text writes are atomic and only land if the file is unchanged;
 * attachment writes check the file's hash just before.
 */
export class ObsidianFiles implements LocalFiles {
  constructor(
    private readonly app: App,
    private readonly isSyncable: (path: string) => boolean,
    /** Attachments' hashes, so a full sync doesn't read every image each time. */
    private readonly hashes: HashCache
  ) {}

  async list() {
    return this.app.vault
      .getFiles()
      .filter((f) => isTextFile(f.path) || f.stat.size <= MAX_ATTACHMENT_BYTES)
      .map((f) => f.path)
      .filter(this.isSyncable)
  }

  async readBytes(path: string) {
    const file = this.app.vault.getFileByPath(path)
    return file ? new Uint8Array(await this.app.vault.readBinary(file)) : null
  }

  async hashBytes(path: string) {
    const file = this.app.vault.getFileByPath(path)
    if (!file) return null
    const {mtime, size} = file.stat
    const cached = this.hashes.get(path, mtime, size)
    if (cached) return cached
    const hash = await sha256HexBytes(new Uint8Array(await this.app.vault.readBinary(file)))
    this.hashes.set(path, mtime, size, hash)
    return hash
  }

  async writeBytes(path: string, data: Uint8Array, expectedHash: string | null) {
    const file = this.app.vault.getFileByPath(path)
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    if (!file) {
      if (expectedHash !== null || this.app.vault.getAbstractFileByPath(path)) return false
      await this.ensureFolder(dirname(path))
      await this.app.vault.createBinary(path, buffer)
      return true
    }
    if (expectedHash === null || (await this.hashBytes(path)) !== expectedHash) return false
    await this.app.vault.modifyBinary(file, buffer)
    return true
  }

  async read(path: string) {
    const file = this.app.vault.getFileByPath(path)
    return file ? this.app.vault.read(file) : null
  }

  async write(path: string, content: string, expected: string | null) {
    const file = this.app.vault.getFileByPath(path)
    if (!file) {
      if (expected !== null || this.app.vault.getAbstractFileByPath(path)) return false
      await this.ensureFolder(dirname(path))
      await this.app.vault.create(path, content)
      return true
    }
    if (expected === null) return false
    let wrote = false
    // Reads and writes in one step, so typing in the note at the same moment can't be lost.
    await this.app.vault.process(file, (current) => {
      if (current !== expected) return current
      wrote = true
      return content
    })
    return wrote
  }

  async remove(path: string, expectedHash: string) {
    const file = this.app.vault.getFileByPath(path)
    if (!file) return false
    const hash = isTextFile(path) ? await sha256Hex(await this.app.vault.read(file)) : await this.hashBytes(path)
    if (hash !== expectedHash) return false
    // Follows the "Deleted files" setting (Obsidian's .trash folder or the system trash), so it can be restored.
    await this.app.fileManager.trashFile(file)
    return true
  }

  private async ensureFolder(folder: string) {
    if (!folder) return
    const parts = folder.split("/")
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/")
      if (!this.app.vault.getAbstractFileByPath(prefix)) await this.app.vault.createFolder(prefix)
    }
  }
}

export const isFile = (f: unknown): f is TFile => f instanceof TFile
