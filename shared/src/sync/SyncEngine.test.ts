import {describe, expect, it} from "vitest"
import {SyncEngine, type SyncAction} from "./SyncEngine"
import {FakeServer, MemoryBases, MemoryFiles} from "./testing"

function setUp(local: Record<string, string> = {}) {
  const server = new FakeServer()
  const files = new MemoryFiles(local)
  const bases = new MemoryBases()
  const conflicts: string[] = []
  const engine = new SyncEngine(
    files,
    bases,
    server,
    {onConflict: (_p, copy) => conflicts.push(copy)},
    {isSyncable: (p) => /\.(md|canvas)$/i.test(p) && !p.startsWith(".obsidian/"), now: () => new Date(2026, 10, 3, 12, 0)}
  )
  return {server, files, bases, engine, conflicts}
}

describe("SyncEngine first sync", () => {
  it("uploads local-only notes and downloads server-only ones, skipping non-syncable files", async () => {
    const {server, files, engine} = setUp({"Mine.md": "mine", "Folder/Deep.md": "deep", ".obsidian/app.json": "{}", "pic.png": "x"})
    await server.put("Theirs.md", "theirs")
    await engine.fullSync()
    expect(server.live()).toEqual({"Mine.md": "mine", "Folder/Deep.md": "deep", "Theirs.md": "theirs"})
    expect(files.snapshot()).toEqual({".obsidian/app.json": "{}", "Folder/Deep.md": "deep", "Mine.md": "mine", "Theirs.md": "theirs", "pic.png": "x"})
  })

  it("adopts identical notes without writing anything", async () => {
    const {server, engine} = setUp({"Same.md": "same"})
    await server.put("Same.md", "same")
    server.calls = []
    await engine.fullSync()
    expect(server.calls).toEqual(["manifest"])
  })

  it("keeps both when the same path differs and they never synced", async () => {
    const {server, files, engine, conflicts} = setUp({"Note.md": "local text"})
    await server.put("Note.md", "server text")
    await engine.fullSync()
    const copy = "Note (conflict 2026-11-03 1200).md"
    expect(conflicts).toEqual([copy])
    expect(files.snapshot()).toEqual({"Note.md": "server text", [copy]: "local text"})
    expect(server.live()).toEqual({"Note.md": "server text", [copy]: "local text"})
  })

  it("never deletes on a first sync, even against server tombstones", async () => {
    const {server, files, engine} = setUp({"Old.md": "still here"})
    await server.put("Old.md", "x")
    await server.put("Old.md", "", true)
    await engine.fullSync()
    expect(files.snapshot()).toEqual({"Old.md": "still here"})
    expect(server.live()).toEqual({"Old.md": "still here"})
  })

  it("dry run reports the plan and changes nothing", async () => {
    const {server, files, engine} = setUp({"Mine.md": "mine"})
    await server.put("Theirs.md", "theirs")
    const plan = await engine.fullSync(true)
    expect(plan).toEqual<SyncAction[]>([
      {path: "Mine.md", decision: "upload"},
      {path: "Theirs.md", decision: "download"}
    ])
    expect(files.snapshot()).toEqual({"Mine.md": "mine"})
    expect(server.live()).toEqual({"Theirs.md": "theirs"})
  })
})

describe("SyncEngine after syncing", () => {
  async function synced(content = "one\ntwo\nthree\n") {
    const t = setUp({"N.md": content})
    await t.engine.fullSync()
    return t
  }

  it("sends a local edit", async () => {
    const {server, files, engine} = await synced()
    files.files.set("N.md", "one\ntwo\nthree\nfour\n")
    await engine.localChanged("N.md")
    expect(server.live()["N.md"]).toBe("one\ntwo\nthree\nfour\n")
  })

  it("brings in a server edit by polling", async () => {
    const {server, files, engine, bases} = await synced()
    await server.put("N.md", "ONE\ntwo\nthree\n")
    await server.put("New.md", "new")
    await engine.pull()
    expect(files.snapshot()).toEqual({"N.md": "ONE\ntwo\nthree\n", "New.md": "new"})
    expect(bases.cursor).toBe(server.version)
    // Polling again finds nothing, and our own uploads don't come back as changes to apply.
    server.calls = []
    await engine.pull()
    expect(server.calls).toEqual([`changes ${server.version}`])
  })

  it("merges edits to different lines from both sides", async () => {
    const {server, files, engine} = await synced()
    await server.put("N.md", "one\ntwo\nTHREE\n")
    files.files.set("N.md", "ONE\ntwo\nthree\n")
    await engine.localChanged("N.md") // the server refuses (it moved on), so the engine merges
    expect(files.files.get("N.md")).toBe("ONE\ntwo\nTHREE\n")
    expect(server.live()["N.md"]).toBe("ONE\ntwo\nTHREE\n")
  })

  it("keeps a conflict copy when both edited the same line", async () => {
    const {server, files, engine, conflicts} = await synced("hello\n")
    await server.put("N.md", "hello there\n")
    files.files.set("N.md", "hello world\n")
    await engine.pull()
    const copy = "N (conflict 2026-11-03 1200).md"
    expect(conflicts).toEqual([copy])
    expect(files.snapshot()).toEqual({"N.md": "hello there\n", [copy]: "hello world\n"})
    expect(server.live()).toEqual({"N.md": "hello there\n", [copy]: "hello world\n"})
  })

  it("passes deletes both ways", async () => {
    const {server, files, engine} = setUp({"A.md": "a", "B.md": "b"})
    await engine.fullSync()
    files.files.delete("A.md")
    await engine.localChanged("A.md")
    expect(server.live()).toEqual({"B.md": "b"})
    await server.put("B.md", "", true)
    await engine.pull()
    expect(files.snapshot()).toEqual({})
    expect(files.trash).toEqual(["B.md"])
  })

  it("lets an edit beat a delete, both ways", async () => {
    const {server, files, engine} = setUp({"A.md": "a", "B.md": "b"})
    await engine.fullSync()
    // Deleted here, edited there: it comes back.
    files.files.delete("A.md")
    await server.put("A.md", "a edited")
    await engine.fullSync()
    expect(files.files.get("A.md")).toBe("a edited")
    // Edited here, deleted there: it goes back up.
    files.files.set("B.md", "b edited")
    await server.put("B.md", "", true)
    await engine.fullSync()
    expect(server.live()["B.md"]).toBe("b edited")
    expect(files.files.get("B.md")).toBe("b edited")
  })

  it("never overwrites a file edited while a download is landing", async () => {
    const {server, files, engine} = await synced("v1\n")
    await server.put("N.md", "v1\nfrom server\n")
    let typed = false
    files.beforeWrite = (p) => {
      if (p === "N.md" && !typed) {
        typed = true
        files.files.set("N.md", "typed here\nv1\n")
      }
    }
    await engine.pull()
    // The download noticed the edit, and the engine merged instead of clobbering it.
    expect(files.files.get("N.md")).toBe("typed here\nv1\nfrom server\n")
    expect(server.live()["N.md"]).toBe("typed here\nv1\nfrom server\n")
  })

  it("reports offline and catches up afterwards", async () => {
    const statuses: string[] = []
    const server = new FakeServer()
    const files = new MemoryFiles({"N.md": "a"})
    const engine = new SyncEngine(files, new MemoryBases(), server, {onStatus: (s) => statuses.push(s)})
    server.offline = true
    await expect(engine.fullSync()).rejects.toThrow()
    expect(statuses.at(-1)).toBe("offline")
    server.offline = false
    await engine.fullSync()
    expect(statuses.at(-1)).toBe("idle")
    expect(server.live()).toEqual({"N.md": "a"})
  })

  it("fetches many downloads in pages instead of one request each", async () => {
    const {server, files, engine} = setUp()
    for (let i = 0; i < 30; i++) await server.put(`n${i}.md`, `note ${i}`)
    server.calls = []
    await engine.fullSync()
    expect(Object.keys(files.snapshot())).toHaveLength(30)
    expect(server.calls.filter((c) => c.startsWith("read"))).toEqual([])
  })
})

describe("SyncEngine attachments", () => {
  const bytes = (...b: number[]) => new Uint8Array(b)
  function attachments(local: Record<string, string | Uint8Array> = {}) {
    const server = new FakeServer()
    const files = new MemoryFiles(local)
    const bases = new MemoryBases()
    const conflicts: string[] = []
    const engine = new SyncEngine(files, bases, server, {onConflict: (_p, copy) => conflicts.push(copy)}, {
      isSyncable: (p) => !p.startsWith("."),
      now: () => new Date(2026, 10, 3, 12, 0)
    })
    return {server, files, bases, engine, conflicts}
  }

  it("sends and fetches attachments as bytes alongside notes", async () => {
    const {server, files, engine} = attachments({"Note.md": "![[a.png]]", "a.png": bytes(1, 2, 3)})
    await server.putAttachment("docs/b.pdf", bytes(9, 8))
    await engine.fullSync()
    expect(server.live()).toEqual({"Note.md": "![[a.png]]", "a.png": bytes(1, 2, 3), "docs/b.pdf": bytes(9, 8)})
    expect(files.snapshot()).toEqual({"Note.md": "![[a.png]]", "a.png": bytes(1, 2, 3), "docs/b.pdf": bytes(9, 8)})
    expect(server.notes.get("a.png")!.attachment).toBe(true)

    // Nothing left to do, and the next full sync downloads nothing.
    server.calls = []
    expect(await engine.fullSync()).toEqual([])
    expect(server.calls).toEqual(["manifest"])
  })

  it("follows edits and deletes from either side", async () => {
    const {server, files, engine} = attachments({"a.png": bytes(1)})
    await engine.fullSync()

    files.files.set("a.png", bytes(2))
    await engine.localChanged("a.png")
    expect(server.live()["a.png"]).toEqual(bytes(2))

    await server.putAttachment("a.png", bytes(3))
    await engine.pull()
    expect(files.files.get("a.png")).toEqual(bytes(3))

    const note = server.notes.get("a.png")!
    await server.delete("a.png", note.version)
    await engine.pull()
    expect(files.files.has("a.png")).toBe(false)
    expect(files.trash).toEqual(["a.png"])
  })

  it("keeps both when an attachment changed on both sides, since bytes can't be merged", async () => {
    const {server, files, engine, conflicts} = attachments({"a.png": bytes(1)})
    await engine.fullSync()
    files.files.set("a.png", bytes(2))
    await server.putAttachment("a.png", bytes(3))
    await engine.localChanged("a.png")

    const copy = "a (conflict 2026-11-03 1200).png"
    expect(conflicts).toEqual([copy])
    expect(files.snapshot()).toEqual({"a.png": bytes(3), [copy]: bytes(2)})
    expect(server.live()).toEqual({"a.png": bytes(3), [copy]: bytes(2)})
  })

  it("on a first sync, keeps both when an attachment differs, and adopts one that matches", async () => {
    const {server, files, engine, conflicts} = attachments({"same.png": bytes(5), "diff.png": bytes(1)})
    await server.putAttachment("same.png", bytes(5))
    await server.putAttachment("diff.png", bytes(2))
    await engine.fullSync()
    expect(conflicts).toEqual(["diff (conflict 2026-11-03 1200).png"])
    expect(files.files.get("diff.png")).toEqual(bytes(2))
    expect(files.files.get("same.png")).toEqual(bytes(5))
  })
})
