import type {Api, Note, Vault} from "@notebarn/shared/api"
import {makeZip, type ZipEntry} from "../lib/zip"

/**
 * Every file in a vault, notes and attachments, as a zip with the vault's folders. Reads straight from the server
 * (not this device's cache), so it needs a connection. `progress` is told how many files are done out of how many.
 */
export async function exportVault(api: Api, vault: Vault.ID, progress?: (done: number, total: number) => void): Promise<Blob> {
  // The change feed from the start is the current version of every file, deleted ones included.
  const notes = new Map<string, Note>()
  let since = 0
  for (let more = true; more; ) {
    const page = await api.note.noteChanges({vault, since, limit: 200})
    for (const note of page.notes) notes.set(note.path, note)
    since = page.cursor
    more = page.hasMore
  }
  const live = [...notes.values()].filter((n) => !n.deleted).sort((a, b) => a.path.localeCompare(b.path))
  const attachments = live.filter((n) => n.attachment)

  let done = live.length - attachments.length
  progress?.(done, live.length)

  // The bytes come from the file store, a few at a time.
  const bytes = new Map<string, Uint8Array>()
  const hashes = [...new Set(attachments.map((n) => n.hash))]
  for (let i = 0; i < hashes.length; i += 100) {
    const batch = hashes.slice(i, i + 100)
    const urls = await api.note.attachmentLinks({vault, hashes: batch})
    await Promise.all(
      batch.map(async (hash, j) => {
        const response = await fetch(urls[j])
        if (!response.ok) throw response
        bytes.set(hash, new Uint8Array(await response.arrayBuffer()))
        done += attachments.filter((n) => n.hash === hash).length
        progress?.(done, live.length)
      })
    )
  }

  const entries: ZipEntry[] = live.map((n) => ({
    path: n.path,
    data: n.attachment ? bytes.get(n.hash)! : n.content,
    modified: new Date(n.modifiedAt)
  }))
  return makeZip(entries)
}

/** Has the browser save `blob` as `name`. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
