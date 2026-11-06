import {describe, expect, it} from "vitest"
import {EMBED_PREFIX, WIKILINK_PREFIX, splitFrontmatter, splitWikilinks, toggleTask} from "./wikilinks"

describe("splitWikilinks", () => {
  it("turns links into link nodes and keeps the text around them", () => {
    expect(splitWikilinks("see [[Other note|this]] and ![[pic.png]].")).toEqual([
      {type: "text", value: "see "},
      {type: "link", url: WIKILINK_PREFIX + "Other%20note", children: [{type: "text", value: "this"}]},
      {type: "text", value: " and "},
      {type: "link", url: EMBED_PREFIX + "pic.png", children: [{type: "text", value: "pic.png"}]},
      {type: "text", value: "."}
    ])
  })
  it("keeps headings in the target", () => {
    expect(splitWikilinks("[[Note#Part]]")[0]).toMatchObject({url: WIKILINK_PREFIX + "Note%23Part", children: [{value: "Note > Part"}]})
  })
})

describe("splitFrontmatter", () => {
  it("separates YAML at the top", () => {
    expect(splitFrontmatter("---\ntags: [a]\n---\n# Title\n")).toEqual({frontmatter: "tags: [a]", body: "# Title\n"})
    expect(splitFrontmatter("# No frontmatter\n---\n")).toEqual({frontmatter: null, body: "# No frontmatter\n---\n"})
  })
})

describe("toggleTask", () => {
  const text = "- [ ] one\n```\n- [ ] in code\n```\n  * [x] two\n1. [ ] three"
  it("toggles the nth task, skipping code blocks", () => {
    expect(toggleTask(text, 0)).toBe(text.replace("- [ ] one", "- [x] one"))
    expect(toggleTask(text, 1)).toBe(text.replace("* [x] two", "* [ ] two"))
    expect(toggleTask(text, 2)).toBe(text.replace("1. [ ] three", "1. [x] three"))
    expect(toggleTask(text, 3)).toBe(text)
  })
})
