import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import type {Note, Vault, WriteNote, WriteResult} from "@notebarn/shared/api"
import {type Draft, type DraftStore, NoteSession, type NoteSessionEvents, type SaveState} from "./NoteSession"

const VAULT = "vault-1" as Vault.ID

/** A pretend server with the same write rules as NoteEndpoints.write. */
class FakeServer {
  notes = new Map<string, Note>()
  version = 0
  offline = false
  writes: WriteNote[] = []

  put(path: string, content: string, deleted = false): Note {
    const existing = this.notes.get(path)
    const note = {
      _id: existing?._id ?? (`id-${path}` as Note.ID),
      owner: "u" as Note["owner"],
      vault: VAULT,
      path,
      content: deleted ? "" : content,
      hash: deleted ? "" : `h:${content}`,
      size: content.length,
      version: ++this.version,
      modifiedAt: new Date().toISOString(),
      deleted,
      attachment: false
    } satisfies Note
    this.notes.set(path, note)
    return note
  }

  async writeNote(input: WriteNote): Promise<WriteResult> {
    if (this.offline) throw new TypeError("Failed to fetch")
    this.writes.push(input)
    const existing = this.notes.get(input.path)
    if (existing && !existing.deleted) {
      if (existing.content === input.content) return {success: true, note: existing}
      if (existing.version !== input.baseVersion) return {success: false, note: existing}
    }
    return {success: true, note: this.put(input.path, input.content)}
  }
}

class MemoryDrafts implements DraftStore {
  map = new Map<string, Draft>()
  get = (v: string, p: string) => this.map.get(`${v}:${p}`) ?? null
  set = (v: string, p: string, d: Draft) => void this.map.set(`${v}:${p}`, d)
  clear = (v: string, p: string) => void this.map.delete(`${v}:${p}`)
}

function open(server: FakeServer, path: string, drafts = new MemoryDrafts()) {
  const shown: string[] = []
  const states: SaveState[] = []
  const conflicts: string[] = []
  const events: NoteSessionEvents = {
    onRemoteText: (t) => shown.push(t),
    onState: (s) => states.push(s),
    onSaved: () => {},
    onConflictCopy: (p) => conflicts.push(p)
  }
  const session = new NoteSession(server, drafts, VAULT, path, server.notes.get(path) ?? null, events, {
    debounceMs: 100,
    retryDelaysMs: [1000],
    now: () => new Date(2026, 10, 3, 12, 0)
  })
  return {session, shown, states, conflicts, drafts}
}

describe("NoteSession", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("saves edits after a pause, from the version it started at", async () => {
    const server = new FakeServer()
    server.put("A.md", "hello")
    const {session} = open(server, "A.md")
    session.edit("hello w")
    session.edit("hello world")
    expect(server.writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(150)
    expect(server.writes).toEqual([{vault: VAULT, path: "A.md", content: "hello world", baseVersion: 1}])
    expect(session.saveState).toBe("saved")
    expect(server.notes.get("A.md")!.content).toBe("hello world")
  })

  it("creates a new note with no base version", async () => {
    const server = new FakeServer()
    const {session} = open(server, "New.md")
    session.edit("first line")
    await session.flush()
    expect(server.writes[0].baseVersion).toBeNull()
    expect(server.notes.get("New.md")!.content).toBe("first line")
  })

  it("merges someone else's save on a different line", async () => {
    const server = new FakeServer()
    server.put("A.md", "one\ntwo\nthree")
    const {session, shown} = open(server, "A.md")
    server.put("A.md", "one\ntwo\nTHREE") // saved from another device
    session.edit("ONE\ntwo\nthree")
    await session.flush()
    expect(server.notes.get("A.md")!.content).toBe("ONE\ntwo\nTHREE")
    expect(shown.at(-1)).toBe("ONE\ntwo\nTHREE")
    expect(session.saveState).toBe("saved")
  })

  it("keeps an unmergeable edit as a conflict copy and shows theirs", async () => {
    const server = new FakeServer()
    server.put("A.md", "hello world")
    const {session, shown, conflicts} = open(server, "A.md")
    server.put("A.md", "goodbye world")
    session.edit("hello there")
    await session.flush()
    expect(conflicts).toEqual(["A (conflict 2026-11-03 1200).md"])
    expect(server.notes.get("A (conflict 2026-11-03 1200).md")!.content).toBe("hello there")
    expect(server.notes.get("A.md")!.content).toBe("goodbye world")
    expect(session.text).toBe("goodbye world")
    expect(shown.at(-1)).toBe("goodbye world")
  })

  it("shows remote changes right away when there are no unsaved edits", async () => {
    const server = new FakeServer()
    server.put("A.md", "v1")
    const {session, shown} = open(server, "A.md")
    session.remoteUpdate(server.put("A.md", "v2"))
    await vi.advanceTimersByTimeAsync(0)
    expect(session.text).toBe("v2")
    expect(shown).toEqual(["v2"])
    // An older copy arriving late is ignored.
    session.remoteUpdate({...server.notes.get("A.md")!, version: 1, content: "v1"})
    await vi.advanceTimersByTimeAsync(0)
    expect(session.text).toBe("v2")
  })

  it("keeps retrying while offline and keeps a draft meanwhile", async () => {
    const server = new FakeServer()
    server.put("A.md", "a")
    const {session, drafts} = open(server, "A.md")
    server.offline = true
    session.edit("ab")
    await vi.advanceTimersByTimeAsync(150)
    expect(session.saveState).toBe("offline")
    expect(drafts.get(VAULT, "A.md")).toEqual({baseVersion: 1, baseContent: "a", local: "ab"})
    server.offline = false
    await vi.advanceTimersByTimeAsync(1100)
    expect(session.saveState).toBe("saved")
    expect(server.notes.get("A.md")!.content).toBe("ab")
    expect(drafts.get(VAULT, "A.md")).toBeNull()
  })

  it("picks up a draft left from last time and merges it with newer changes", async () => {
    const server = new FakeServer()
    server.put("A.md", "one\ntwo\nthree")
    const drafts = new MemoryDrafts()
    drafts.set(VAULT, "A.md", {baseVersion: 1, baseContent: "one\ntwo\nthree", local: "ONE\ntwo\nthree"})
    server.put("A.md", "one\ntwo\nTHREE")
    const {session} = open(server, "A.md", drafts)
    expect(session.text).toBe("ONE\ntwo\nthree")
    await vi.advanceTimersByTimeAsync(10)
    await session.flush()
    expect(server.notes.get("A.md")!.content).toBe("ONE\ntwo\nTHREE")
  })

  it("goes quiet when the note is deleted elsewhere, and editing brings it back", async () => {
    const server = new FakeServer()
    server.put("A.md", "text")
    const {session} = open(server, "A.md")
    session.remoteUpdate(server.put("A.md", "", true))
    await vi.advanceTimersByTimeAsync(0)
    expect(session.saveState).toBe("deleted")
    session.edit("text again")
    await session.flush()
    expect(server.notes.get("A.md")).toMatchObject({deleted: false, content: "text again"})
  })

  it("doesn't bring a note deleted elsewhere back just by leaving it", async () => {
    const server = new FakeServer()
    server.put("A.md", "text")
    const {session} = open(server, "A.md")
    session.remoteUpdate(server.put("A.md", "", true))
    await vi.advanceTimersByTimeAsync(0)
    const writes = server.writes.length
    await session.flush()
    expect(server.writes.length).toBe(writes)
    expect(server.notes.get("A.md")!.deleted).toBe(true)
  })

  it("holds a remote change that arrives mid-save until the save answers", async () => {
    const server = new FakeServer()
    server.put("A.md", "a")
    const {session, shown} = open(server, "A.md")
    session.edit("ab")
    await vi.advanceTimersByTimeAsync(150) // saved as version 2
    // Polling reports our own save back: nothing should change.
    session.remoteUpdate(server.notes.get("A.md")!)
    await vi.advanceTimersByTimeAsync(0)
    expect(shown).toEqual([])
    expect(session.saveState).toBe("saved")
  })
})
