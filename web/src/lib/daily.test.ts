import {describe, expect, it} from "vitest"
import {dailyPath} from "./daily"

describe("dailyPath", () => {
  const at = new Date(2026, 10, 5, 9, 30)
  it("goes at the top level with no daily notes yet", () => {
    expect(dailyPath(at, ["Welcome.md"])).toBe("2026-11-05.md")
  })
  it("goes where the daily notes already are", () => {
    expect(dailyPath(at, ["Journal/2026-11-03.md", "Journal/2026-11-04.md", "2026-01-01.md"])).toBe("Journal/2026-11-05.md")
  })
})
