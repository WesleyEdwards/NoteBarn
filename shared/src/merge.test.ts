import {describe, expect, it} from "vitest"
import {lineDiff, merge3} from "./merge"

describe("merge3", () => {
  it("takes whichever side changed", () => {
    expect(merge3("a", "a", "b")).toEqual({clean: true, text: "b"})
    expect(merge3("a", "b", "a")).toEqual({clean: true, text: "b"})
    expect(merge3("a", "b", "b")).toEqual({clean: true, text: "b"})
  })

  it("merges edits to different lines", () => {
    const base = "one\ntwo\nthree\nfour\n"
    const mine = "ONE\ntwo\nthree\nfour\n"
    const theirs = "one\ntwo\nthree\nFOUR\n"
    expect(merge3(base, mine, theirs)).toEqual({clean: true, text: "ONE\ntwo\nthree\nFOUR\n"})
  })

  it("keeps both when each side added lines at the same place", () => {
    const base = "# Groceries\n- milk\n"
    const mine = "# Groceries\n- milk\n- eggs\n"
    const theirs = "# Groceries\n- milk\n- bread\n"
    expect(merge3(base, mine, theirs)).toEqual({clean: true, text: "# Groceries\n- milk\n- eggs\n- bread\n"})
  })

  it("refuses overlapping changes to the same line", () => {
    expect(merge3("hello world\n", "hello there\n", "goodbye world\n")).toEqual({clean: false})
  })
})

describe("lineDiff", () => {
  it("marks removed and added lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      {kind: "same", text: "a"},
      {kind: "removed", text: "b"},
      {kind: "added", text: "B"},
      {kind: "same", text: "c"},
      {kind: "added", text: "d"}
    ])
  })
})
