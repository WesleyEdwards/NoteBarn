import {createContext, useContext, useEffect, useState} from "react"
import type {Api, Note, Vault} from "@notebarn/shared/api"
import {sha256HexBytes} from "@notebarn/shared/hash"
import {mimeType} from "@notebarn/shared/paths"

/** The server's links last an hour; get a fresh one well before that. */
const LINK_LIFETIME_MS = 45 * 60 * 1000

/**
 * Download links for attachments, by hash. Asks the server for links in batches (everything asked for in the same
 * moment goes in one request) and remembers them until they're close to expiring.
 */
export class AttachmentLinks {
  private links = new Map<string, {url: string; at: number}>()
  private waiting = new Map<string, {resolve(url: string): void; reject(e: unknown): void}[]>()
  private scheduled = false

  constructor(
    private readonly api: Api,
    private readonly vault: Vault.ID
  ) {}

  /** A link that's fine to use right now, if one is already known. */
  cached(hash: string): string | null {
    const known = this.links.get(hash)
    return known && Date.now() - known.at < LINK_LIFETIME_MS ? known.url : null
  }

  url(hash: string): Promise<string> {
    const known = this.cached(hash)
    if (known) return Promise.resolve(known)
    return new Promise((resolve, reject) => {
      const list = this.waiting.get(hash) ?? []
      list.push({resolve, reject})
      this.waiting.set(hash, list)
      if (!this.scheduled) {
        this.scheduled = true
        queueMicrotask(() => void this.flush())
      }
    })
  }

  private async flush() {
    this.scheduled = false
    const batch = new Map(this.waiting)
    this.waiting.clear()
    const hashes = [...batch.keys()]
    try {
      const urls = await this.api.note.attachmentLinks({vault: this.vault, hashes})
      const at = Date.now()
      hashes.forEach((hash, i) => {
        this.links.set(hash, {url: urls[i], at})
        batch.get(hash)!.forEach((w) => w.resolve(urls[i]))
      })
    } catch (e) {
      batch.forEach((list) => list.forEach((w) => w.reject(e)))
    }
  }
}

/** What the reader needs to show attachments: the vault's file list, and links to their bytes. */
export interface AttachmentContextValue {
  links: Pick<AttachmentLinks, "cached" | "url">
  /** The hash of the attachment at `path`, or null if there's none. */
  hashOf(path: string): string | null
}

export const AttachmentContext = createContext<AttachmentContextValue | null>(null)

export function useAttachments() {
  return useContext(AttachmentContext)
}

/** A link to an attachment's bytes, once known. `failed` if it couldn't be had (offline, say). */
export function useAttachmentUrl(hash: string | null): {url: string | null; failed: boolean} {
  const attachments = useAttachments()
  const [state, setState] = useState<{hash: string | null; url: string | null; failed: boolean}>(() => ({
    hash,
    url: hash ? (attachments?.links.cached(hash) ?? null) : null,
    failed: false
  }))
  useEffect(() => {
    if (!hash || !attachments) return
    let cancelled = false
    attachments.links
      .url(hash)
      .then((url) => !cancelled && setState({hash, url, failed: false}))
      .catch(() => !cancelled && setState({hash, url: null, failed: true}))
    return () => {
      cancelled = true
    }
  }, [hash, attachments])
  return state.hash === hash ? state : {url: null, failed: false}
}

/**
 * Uploads a file's bytes and saves it as an attachment at `path` (which must be free). Throws the Response when the
 * server or the file store refuses, and a TypeError when offline, like the API client.
 */
export async function uploadAttachment(api: Api, vault: Vault.ID, path: string, file: Blob): Promise<Note> {
  const data = new Uint8Array(await file.arrayBuffer())
  const hash = await sha256HexBytes(data)
  const {uploadUrl} = await api.note.attachmentUpload({vault, hash, size: data.byteLength})
  if (uploadUrl) {
    const response = await fetch(uploadUrl, {method: "PUT", headers: {"Content-Type": file.type || mimeType(path)}, body: data})
    if (!response.ok) throw response
  }
  const result = await api.note.writeAttachment({vault, path, hash, baseVersion: null})
  if (!result.success || !result.note) throw new Error(`There's already a file at ${path}.`)
  return result.note
}
