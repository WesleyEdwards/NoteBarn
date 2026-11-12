import type {Api, Note, NoteSummary, Vault} from "@notebarn/shared/api"
import {storage} from "../lib/storage"
import {LiveConnection} from "@notebarn/shared/sync/LiveConnection"

export type ConnectionState = "loading" | "online" | "offline"

const summaryOf = (n: Note): NoteSummary => ({
  path: n.path,
  version: n.version,
  hash: n.hash,
  size: n.size,
  modifiedAt: n.modifiedAt,
  deleted: n.deleted,
  attachment: n.attachment
})

/** While the live connection is up, ask for changes this often anyway, in case a nudge went missing. */
const LIVE_POLL_MS = 60_000

/**
 * Everything the app knows about one vault's files: the list of notes (from the manifest, then kept current by
 * asking for changes whenever the live connection says something changed, or by polling while it's down) and who
 * wants to hear when a particular note changes. The list is cached on the device so the
 * app opens straight away, even offline.
 */
export class VaultStore {
  private notes = new Map<string, NoteSummary>()
  private cursor = 0
  private listeners = new Set<() => void>()
  private noteListeners = new Map<string, Set<(note: Note, movedTo?: string) => void>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling: Promise<void> | null = null
  private pollAgain = false
  private lastPoll = 0
  private live: LiveConnection | null = null
  private snapshot: {paths: string[]; connection: ConnectionState; loaded: boolean} = {
    paths: [],
    connection: "loading",
    loaded: false
  }

  constructor(
    private readonly api: Api,
    readonly vault: Vault.ID,
    private readonly pollMs = 5000,
    /** The Live Changes websocket's address for this vault, with a fresh token. Without it, only polls. */
    liveUrl?: () => Promise<string>
  ) {
    if (liveUrl) {
      this.live = new LiveConnection(liveUrl, {
        opened: () => void this.poll(),
        changed: (latestVersion) => {
          if (latestVersion > this.cursor) void this.poll()
        },
        // Polling takes over until it's back.
        closed: () => {}
      })
    }
    const cached = storage.get<{notes: NoteSummary[]; cursor: number} | null>(this.cacheKey, null)
    if (cached) {
      for (const n of cached.notes) this.notes.set(n.path, n)
      this.cursor = cached.cursor
      this.snapshot = {...this.snapshot, loaded: true}
      this.rebuild()
    }
  }

  private get cacheKey() {
    return `vault-cache:${this.vault}`
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  /**
   * Hear about newer copies of one note, as changes come in. When another device renamed it, the note is its
   * tombstone and `movedTo` is where it went.
   */
  watchNote(path: string, listener: (note: Note, movedTo?: string) => void) {
    let set = this.noteListeners.get(path)
    if (!set) this.noteListeners.set(path, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.noteListeners.delete(path)
    }
  }

  summary(path: string): NoteSummary | undefined {
    const n = this.notes.get(path)
    return n && !n.deleted ? n : undefined
  }

  has(path: string) {
    return !!this.summary(path)
  }

  private rebuild() {
    const paths = [...this.notes.values()].filter((n) => !n.deleted).map((n) => n.path)
    this.snapshot = {...this.snapshot, paths}
    this.emit()
  }

  private setConnection(connection: ConnectionState) {
    if (this.snapshot.connection === connection) return
    this.snapshot = {...this.snapshot, connection}
    this.emit()
  }

  private emit() {
    this.listeners.forEach((l) => l())
  }

  private persist() {
    storage.set(this.cacheKey, {notes: [...this.notes.values()], cursor: this.cursor})
  }

  /** Records a note this device just saved, so the file list updates without waiting to hear about it. */
  noteSaved(note: Note) {
    const known = this.notes.get(note.path)
    if (known && known.version >= note.version) return
    this.notes.set(note.path, summaryOf(note))
    this.rebuild()
    this.persist()
  }

  start() {
    void this.loadManifest()
    this.live?.start()
    this.timer = setInterval(() => {
      if (document.visibilityState !== "visible") return
      if (this.live?.isOpen && Date.now() - this.lastPoll < LIVE_POLL_MS) return
      void this.poll()
    }, this.pollMs)
    document.addEventListener("visibilitychange", this.onVisible)
    window.addEventListener("focus", this.onVisible)
    window.addEventListener("online", this.onVisible)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.live?.stop()
    document.removeEventListener("visibilitychange", this.onVisible)
    window.removeEventListener("focus", this.onVisible)
    window.removeEventListener("online", this.onVisible)
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") void this.poll()
  }

  /** The full list, which also catches anything asking for changes could have missed. */
  async loadManifest() {
    try {
      const manifest = await this.api.note.vaultManifest(this.vault)
      this.notes = new Map(manifest.notes.map((n) => [n.path, n]))
      this.cursor = manifest.latestVersion
      this.snapshot = {...this.snapshot, loaded: true}
      this.rebuild()
      this.persist()
      this.setConnection("online")
    } catch (e) {
      this.setConnection("offline")
      if (!(e instanceof TypeError)) console.error(e)
    }
  }

  /** Asks for anything changed since last time and passes it on. */
  poll(): Promise<void> {
    if (this.polling) {
      // The one under way may have asked before this change landed, so ask once more after it.
      this.pollAgain = true
      return this.polling
    }
    this.polling = (async () => {
      do {
        this.pollAgain = false
        await this.doPoll()
      } while (this.pollAgain)
    })().finally(() => {
      this.polling = null
    })
    return this.polling
  }

  private async doPoll() {
    this.lastPoll = Date.now()
    if (!this.snapshot.loaded) return this.loadManifest()
    try {
      let more = true
      let changed = false
      while (more) {
        const page = await this.api.note.noteChanges({vault: this.vault, since: this.cursor, limit: 200})
        for (const note of page.notes) {
          const before = this.notes.get(note.path)
          this.notes.set(note.path, summaryOf(note))
          // Claude: the server saves a renamed note at its new path, then tombstones the old one with the next version.
          const movedTo =
            note.deleted && before && !before.deleted
              ? page.notes.find((n) => !n.deleted && n.version === note.version - 1 && n.hash === before.hash)?.path
              : undefined
          this.noteListeners.get(note.path)?.forEach((l) => l(note, movedTo))
          changed = true
        }
        this.cursor = page.cursor
        more = page.hasMore
      }
      if (changed) {
        this.rebuild()
        this.persist()
      }
      this.setConnection("online")
    } catch (e) {
      this.setConnection("offline")
      if (!(e instanceof TypeError)) console.error(e)
    }
  }
}
