import {describe, expect, it} from "vitest"
import {fuzzyFilter, fuzzyScore} from "./fuzzy"

describe("fuzzy", () => {
  it("matches in order, ignoring case and spaces", () => {
    expect(fuzzyScore("nap", "Notes app")).not.toBeNull()
    expect(fuzzyScore("pan", "Notes app")).toBeNull()
    expect(fuzzyScore("notes app", "Notes app")).not.toBeNull()
  })
  it("ranks name matches and word starts first", () => {
    const paths = ["Archive/Old groceries.md", "Groceries.md", "Projects/Grand ocean cruise.md", "Recipes.md"]
    expect(fuzzyFilter("groc", paths)).toEqual(["Groceries.md", "Archive/Old groceries.md", "Projects/Grand ocean cruise.md"])
    expect(fuzzyFilter("proj", paths)).toEqual(["Projects/Grand ocean cruise.md"])
  })
})
