import {describe, expect, it} from "vitest"
import {
  buildTree,
  availablePath,
  conflictPath,
  pastedImageName,
  linkTextFor,
  normalizeNotePath,
  parseWikilink,
  resolveWikilink,
  untitledPath
} from "./paths"

const vault = ["Home.md", "Projects/Notes app.md", "Projects/Ideas.md", "Archive/Ideas.md", "Daily/2026-11-03.md"]

describe("parseWikilink", () => {
  it("splits target, heading and alias", () => {
    expect(parseWikilink("Note")).toEqual({target: "Note", heading: undefined, alias: undefined})
    expect(parseWikilink("Note#Part 2|see here")).toEqual({target: "Note", heading: "Part 2", alias: "see here"})
    expect(parseWikilink("#Heading")).toEqual({target: "", heading: "Heading", alias: undefined})
  })
})

describe("resolveWikilink", () => {
  it("finds by name anywhere, ignoring case", () => {
    expect(resolveWikilink("notes app", "Home.md", vault)).toBe("Projects/Notes app.md")
    expect(resolveWikilink("Home", "Daily/2026-11-03.md", vault)).toBe("Home.md")
  })
  it("prefers a full path, then the linking note's folder", () => {
    expect(resolveWikilink("Archive/Ideas", "Home.md", vault)).toBe("Archive/Ideas.md")
    expect(resolveWikilink("Ideas", "Archive/Other.md", vault)).toBe("Archive/Ideas.md")
    expect(resolveWikilink("Ideas", "Projects/Notes app.md", vault)).toBe("Projects/Ideas.md")
  })
  it("returns null for a missing note and the note itself for a heading-only link", () => {
    expect(resolveWikilink("Nope", "Home.md", vault)).toBeNull()
    expect(resolveWikilink("", "Home.md", vault)).toBe("Home.md")
  })
})

describe("linkTextFor", () => {
  it("uses the title unless another note shares it", () => {
    expect(linkTextFor("Projects/Notes app.md", vault)).toBe("Notes app")
    expect(linkTextFor("Archive/Ideas.md", vault)).toBe("Archive/Ideas")
  })
})

describe("normalizeNotePath", () => {
  it("cleans up slashes and adds .md", () => {
    expect(normalizeNotePath(" /Folder// My note ")).toBe("Folder/My note.md")
    expect(normalizeNotePath("a\\b.md")).toBe("a/b.md")
    expect(normalizeNotePath("../x")).toBe("x.md")
    expect(normalizeNotePath("  ")).toBe("")
  })
})

describe("conflictPath", () => {
  it("names the copy after the note and the time, avoiding taken names", () => {
    const at = new Date(2026, 10, 3, 9, 5)
    expect(conflictPath("Folder/Note.md", at)).toBe("Folder/Note (conflict 2026-11-03 0905).md")
    expect(conflictPath("Note.md", at, ["Note (conflict 2026-11-03 0905).md"])).toBe("Note (conflict 2026-11-03 0905 2).md")
    expect(conflictPath("img/Photo.png", at)).toBe("img/Photo (conflict 2026-11-03 0905).png")
    expect(conflictPath("Board.canvas", at)).toBe("Board (conflict 2026-11-03 0905).canvas")
    expect(conflictPath("README", at)).toBe("README (conflict 2026-11-03 0905)")
  })
})

describe("availablePath", () => {
  it("adds a number before the extension when taken", () => {
    expect(availablePath("img", "a.png", [])).toBe("img/a.png")
    expect(availablePath("img", "a.png", ["img/A.png", "img/a 1.png"])).toBe("img/a 2.png")
    expect(pastedImageName(new Date(2026, 10, 4, 9, 5, 7), "png")).toBe("Pasted image 20261104090507.png")
  })
})

describe("untitledPath", () => {
  it("finds a free name", () => {
    expect(untitledPath("", [])).toBe("Untitled.md")
    expect(untitledPath("A", ["A/Untitled.md", "A/untitled 1.md"])).toBe("A/Untitled 2.md")
  })
})

describe("buildTree", () => {
  it("nests folders and sorts them first, by name", () => {
    const tree = buildTree(["b.md", "Z/x.md", "a.md", "A/B/c.md", "note 10.md", "note 9.md"])
    expect(tree.folders.map((f) => f.path)).toEqual(["A", "Z"])
    expect(tree.folders[0].folders[0].path).toBe("A/B")
    expect(tree.folders[0].folders[0].files).toEqual(["A/B/c.md"])
    expect(tree.files).toEqual(["a.md", "b.md", "note 9.md", "note 10.md"])
  })
})
