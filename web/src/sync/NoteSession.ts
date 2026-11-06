import type {Note, Vault, WriteNote, WriteResult} from "@notebarn/shared/api"
import {conflictPath} from "@notebarn/shared/paths"
import {merge3} from "@notebarn/shared/merge"
import {isServerRejection} from "@notebarn/shared/errors"

/**
 * - saved: the server has exactly what's in the editor
 * - dirty: there are edits waiting to be saved
 * - saving: a save is on its way
 * - offline: the server couldn't be reached; it keeps retrying, and the edits are kept on this device meanwhile
 * - error: the server refused the save (see `lastError`); it retries on the next edit
 * - deleted: the note was deleted elsewhere; editing it brings it back
 */
export type SaveState = "saved" | "dirty" | "saving" | "offline" | "error" | "deleted"

export interface NoteWriter {
  writeNote(input: WriteNote): Promise<WriteResult>
}

/** Edits not yet confirmed by the server, kept on the device so closing the tab or losing signal never loses them. */
export interface Draft {
  baseVersion: number | null
  baseContent: string
  local: string
}

export interface DraftStore {
  get(vault: string, path: string): Draft | null
  set(vault: string, path: string, draft: Draft): void
  clear(vault: string, path: string): void
}

export interface NoteSessionEvents {
  /** The text changed for a reason other than typing (a merge or someone else's edit); show it in the editor. */
  onRemoteText(text: string): void
  onState(state: SaveState): void
  /** A note was saved (this one, or a conflict copy), for the file list. */
  onSaved(note: Note): void
  /** My edits couldn't be merged with someone else's, so they were saved separately at `path`. */
  onConflictCopy(path: string): void
}

export interface NoteSessionOptions {
  debounceMs?: number
  retryDelaysMs?: number[]
  now?: () => Date
  /** Paths already in the vault, so a conflict copy doesn't land on top of one. */
  existingPaths?: () => readonly string[]
}


/**
 * Keeps one open note in step with the server. The editor reports every edit with `edit`; the session saves them a
 * moment later, telling the server which version the edits started from. If someone else saved in between, their
 * version comes back instead and the session merges the two (or, when it can't, saves my text as a conflict copy and
 * shows theirs). Changes from other devices come in through `remoteUpdate` and are merged the same way.
 */
export class NoteSession {
  /** The last version known to be on the server, and its content. */
  private base: {version: number | null; content: string}
  private local: string
  private state: SaveState = "saved"
  private timer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> | null = null
  private pendingRemote: Note | null = null
  private failures = 0
  private disposed = false
  lastError: unknown = null

  private readonly debounceMs: number
  private readonly retryDelaysMs: number[]
  private readonly now: () => Date
  private readonly existingPaths: () => readonly string[]

  constructor(
    private readonly api: NoteWriter,
    private readonly drafts: DraftStore,
    readonly vault: Vault.ID,
    readonly path: string,
    /** The note as the server has it now, or null for a note that doesn't exist yet. */
    server: Note | null,
    private readonly events: NoteSessionEvents,
    options: NoteSessionOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 700
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 3000, 10000, 30000]
    this.now = options.now ?? (() => new Date())
    this.existingPaths = options.existingPaths ?? (() => [])

    const live = server && !server.deleted ? server : null
    const draft = drafts.get(vault, path)
    if (draft && draft.local !== draft.baseContent) {
      // Edits from last time that never reached the server: start from them and merge in anything newer.
      this.base = {version: draft.baseVersion, content: draft.baseContent}
      this.local = draft.local
      if (live && live.version !== draft.baseVersion) this.pendingRemote = live
      this.setState("dirty")
      queueMicrotask(() => {
        if (this.disposed) return
        if (this.pendingRemote) {
          const remote = this.pendingRemote
          this.pendingRemote = null
          void this.applyRemote(remote)
        } else {
          this.schedule(0)
        }
      })
    } else {
      if (draft) drafts.clear(vault, path)
      this.base = {version: live?.version ?? null, content: live?.content ?? ""}
      this.local = this.base.content
    }
  }

  /** What the editor should show. */
  get text() {
    return this.local
  }

  get saveState() {
    return this.state
  }

  /** The editor's text changed because someone typed. */
  edit(text: string) {
    if (this.disposed) return
    this.local = text
    if (this.local === this.base.content && this.state !== "deleted") {
      this.cancelTimer()
      this.drafts.clear(this.vault, this.path)
      if (!this.saving) this.setState("saved")
      return
    }
    this.saveDraft()
    if (this.state !== "saving" && this.state !== "offline") this.setState("dirty")
    if (this.state !== "offline") this.schedule(this.debounceMs)
  }

  /** Saves right away, for leaving the note or Ctrl+S. Resolves once the server has everything. */
  async flush(): Promise<void> {
    this.cancelTimer()
    while (!this.disposed) {
      if (this.saving) {
        await this.saving
        continue
      }
      // Deleted elsewhere and not edited since: leave it deleted (editing it is what brings it back).
      if (this.state === "deleted") return
      if (this.local === this.base.content) return
      await this.save()
      if (this.state === "offline" || this.state === "error") return
    }
  }

  /** A newer copy of this note arrived from the server (heard about from the server). */
  remoteUpdate(note: Note) {
    if (this.disposed) return
    if (this.saving) {
      // Might be our own save echoing back; look again once the save answers.
      if (!this.pendingRemote || note.version > this.pendingRemote.version) this.pendingRemote = note
      return
    }
    void this.applyRemote(note)
  }

  dispose() {
    this.disposed = true
    this.cancelTimer()
  }

  private setState(state: SaveState) {
    if (this.state === state) return
    this.state = state
    this.events.onState(state)
  }

  private saveDraft() {
    this.drafts.set(this.vault, this.path, {
      baseVersion: this.base.version,
      baseContent: this.base.content,
      local: this.local,
    })
  }

  private cancelTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay: number) {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.save()
    }, delay)
  }

  private save(): Promise<void> {
    if (this.saving) return this.saving
    this.saving = this.doSave().finally(() => {
      this.saving = null
      if (this.disposed) return
      const remote = this.pendingRemote
      this.pendingRemote = null
      if (remote) void this.applyRemote(remote)
      else if (this.local !== this.base.content && this.state === "dirty") this.schedule(this.debounceMs)
    })
    return this.saving
  }

  private async doSave(): Promise<void> {
    const sending = this.local
    if (sending === this.base.content && this.state !== "deleted") {
      this.setState("saved")
      return
    }
    this.setState("saving")
    let result: WriteResult
    try {
      result = await this.api.writeNote({
        vault: this.vault,
        path: this.path,
        content: sending,
        baseVersion: this.base.version,
      })
    } catch (e) {
      this.lastError = e
      if (isServerRejection(e)) {
        this.setState("error")
      } else {
        this.setState("offline")
        const delay = this.retryDelaysMs[Math.min(this.failures, this.retryDelaysMs.length - 1)]
        this.failures++
        this.schedule(delay)
      }
      return
    }
    this.failures = 0
    this.lastError = null
    const note = result.note
    if (result.success && note) {
      this.base = {version: note.version, content: note.content}
      this.events.onSaved(note)
      if (this.local === this.base.content) {
        this.drafts.clear(this.vault, this.path)
        this.setState("saved")
      } else {
        this.saveDraft()
        this.setState("dirty")
      }
      return
    }
    if (!note) {
      // Nothing there after all; try again as a new note.
      this.base = {version: null, content: ""}
      this.setState("dirty")
      return
    }
    await this.applyRemote(note)
  }

  /** Brings in the server's newer copy, merging it with any unsaved edits. */
  private async applyRemote(note: Note) {
    if (this.disposed) return
    if (this.base.version !== null && note.version <= this.base.version) return

    if (note.deleted) {
      this.base = {version: note.version, content: ""}
      this.cancelTimer()
      this.drafts.clear(this.vault, this.path)
      this.setState("deleted")
      return
    }

    const unsaved = this.local !== this.base.content
    if (!unsaved || this.local === note.content) {
      this.base = {version: note.version, content: note.content}
      if (this.local !== note.content) {
        this.local = note.content
        this.events.onRemoteText(this.local)
      }
      this.drafts.clear(this.vault, this.path)
      this.setState("saved")
      return
    }

    const merged = merge3(this.base.content, this.local, note.content)
    this.base = {version: note.version, content: note.content}
    if (merged.clean) {
      this.local = merged.text
      this.events.onRemoteText(this.local)
      if (this.local === this.base.content) {
        this.drafts.clear(this.vault, this.path)
        this.setState("saved")
      } else {
        this.saveDraft()
        this.setState("dirty")
        this.schedule(0)
      }
      return
    }

    // Can't merge: keep my version next to theirs rather than choosing for me.
    const mine = this.local
    this.local = note.content
    this.events.onRemoteText(this.local)
    this.drafts.clear(this.vault, this.path)
    this.setState("saved")
    const copyPath = conflictPath(this.path, this.now(), this.existingPaths())
    try {
      const copy = await this.api.writeNote({vault: this.vault, path: copyPath, content: mine, baseVersion: null})
      if (copy.note) this.events.onSaved(copy.note)
      this.events.onConflictCopy(copyPath)
    } catch (e) {
      // Couldn't save the copy: put my text back as unsaved edits so it isn't lost.
      this.lastError = e
      this.local = mine
      this.events.onRemoteText(mine)
      this.saveDraft()
      this.setState("error")
    }
  }
}

/** Drafts in localStorage, which can be missing or full; losing a draft only matters if the tab also closes. */
export const localDraftStore: DraftStore = {
  get(vault, path) {
    try {
      const raw = localStorage.getItem(`draft:${vault}:${path}`)
      return raw ? (JSON.parse(raw) as Draft) : null
    } catch {
      return null
    }
  },
  set(vault, path, draft) {
    try {
      localStorage.setItem(`draft:${vault}:${path}`, JSON.stringify(draft))
    } catch {
      // Storage full or blocked.
    }
  },
  clear(vault, path) {
    try {
      localStorage.removeItem(`draft:${vault}:${path}`)
    } catch {
      // Storage blocked.
    }
  },
}

export function listDrafts(vault: string): string[] {
  const prefix = `draft:${vault}:`
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix)) out.push(key.slice(prefix.length))
    }
  } catch {
    // Storage blocked.
  }
  return out
}
