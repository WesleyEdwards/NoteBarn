import type {Note} from "@notebarn/shared/api"
import {storage} from "../lib/storage"

/** The most recently opened notes, kept on the device so they open offline (on a plane, in a basement). */
const LIMIT = 40

const indexKey = (vault: string) => `note-cache-index:${vault}`
const noteKey = (vault: string, path: string) => `note-cache:${vault}:${path}`

export const noteCache = {
  get(vault: string, path: string): Note | null {
    return storage.get<Note | null>(noteKey(vault, path), null)
  },
  put(note: Note) {
    const vault = note.vault as string
    if (note.deleted) return noteCache.remove(vault, note.path)
    storage.set(noteKey(vault, note.path), note)
    const index = storage.get<string[]>(indexKey(vault), []).filter((p) => p !== note.path)
    index.unshift(note.path)
    for (const old of index.splice(LIMIT)) storage.remove(noteKey(vault, old))
    storage.set(indexKey(vault), index)
  },
  remove(vault: string, path: string) {
    storage.remove(noteKey(vault, path))
    storage.set(
      indexKey(vault),
      storage.get<string[]>(indexKey(vault), []).filter((p) => p !== path)
    )
  }
}
