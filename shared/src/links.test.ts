import {describe, expect, it} from "vitest"
import {findLinks, linkingLines, linksTo, rewriteLinks} from "./links"

const paths = ["Welcome.md", "Projects/Garden plan.md", "Projects/Work/Standup.md", "Images/photo.png", "Other/Standup.md"]

describe("findLinks", () => {
  it("finds wikilinks, embeds and markdown links, but not in code or to the web", () => {
    const text = "[[A]] ![[b.png|300]] [x](Folder/C.md) [web](https://x.y) `[[D]]`\n```\n[[E]]\n```\n[[F#h|alias]]"
    expect(findLinks(text).map((l) => l.target)).toEqual(["A", "b.png", "Folder/C.md", "F"])
  })

  it("decodes markdown link paths", () => {
    expect(findLinks("[g](Projects/Garden%20plan.md)")[0].target).toBe("Projects/Garden plan.md")
  })
})

describe("linksTo", () => {
  it("resolves links the way Obsidian does", () => {
    expect(linksTo("See [[Garden plan]].", "Welcome.md", "Projects/Garden plan.md", paths)).toBe(true)
    expect(linksTo("See [[Garden plans]].", "Welcome.md", "Projects/Garden plan.md", paths)).toBe(false)
    expect(linksTo("![[photo.png]]", "Welcome.md", "Images/photo.png", paths)).toBe(true)
  })

  it("gives the lines with the link", () => {
    expect(linkingLines("a\n  b [[Welcome]] c  \nd", "Projects/Garden plan.md", "Welcome.md", paths)).toEqual(["b [[Welcome]] c"])
  })
})

describe("rewriteLinks", () => {
  const rename = (text: string, from: string, to: string, notePath = "Welcome.md") => {
    const after = paths.map((p) => (p === from ? to : p))
    return rewriteLinks(text, notePath, new Map([[from, to]]), paths, after)
  }

  it("renames links, keeping headings and aliases", () => {
    expect(rename("[[Garden plan#Beds|my garden]] and [[Garden plan]]", "Projects/Garden plan.md", "Projects/Yard.md")).toBe(
      "[[Yard#Beds|my garden]] and [[Yard]]"
    )
  })

  it("uses the full path when the new name is ambiguous", () => {
    expect(rename("[[Projects/Work/Standup]]", "Projects/Work/Standup.md", "Projects/Work/Sync.md")).toBe("[[Sync]]")
    expect(rename("[[Welcome]]", "Welcome.md", "Projects/Work/Standup.md", "Projects/Garden plan.md")).toBe(
      "[[Projects/Work/Standup]]"
    )
  })

  it("leaves links that still reach the file alone", () => {
    const text = "[[Garden plan]]"
    expect(rename(text, "Projects/Garden plan.md", "Archive/Garden plan.md")).toBe(text)
  })

  it("updates markdown links and embeds", () => {
    expect(rename("[g](Projects/Garden%20plan.md) ![[photo.png|200]]", "Projects/Garden plan.md", "Garden.md")).toBe(
      "[g](Garden.md) ![[photo.png|200]]"
    )
    expect(rename("![[photo.png|200]]", "Images/photo.png", "Images/sunset.png")).toBe("![[sunset.png|200]]")
  })

  it("doesn't touch other links or code", () => {
    const text = "[[Welcome]] `[[Garden plan]]`"
    expect(rename(text, "Projects/Garden plan.md", "Yard.md")).toBe(text)
  })
})
