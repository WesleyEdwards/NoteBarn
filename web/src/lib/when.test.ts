import {describe, expect, it} from "vitest"
import {bytes, when} from "./when"

describe("when", () => {
  const now = new Date(2026, 10, 5, 15, 0)
  it("names today and yesterday", () => {
    expect(when(new Date(2026, 10, 5, 9, 5).toISOString(), now)).toMatch(/^Today, /)
    expect(when(new Date(2026, 10, 4, 23, 59).toISOString(), now)).toMatch(/^Yesterday, /)
  })
  it("gives the date otherwise, with the year only when it's not this one", () => {
    expect(when(new Date(2026, 10, 1, 9, 5).toISOString(), now)).not.toMatch(/2026/)
    expect(when(new Date(2025, 10, 1, 9, 5).toISOString(), now)).toMatch(/2025/)
  })
})

describe("bytes", () => {
  it("rounds to a readable unit", () => {
    expect(bytes(820)).toBe("820 B")
    expect(bytes(12_400)).toBe("12 KB")
    expect(bytes(3_420_000)).toBe("3.4 MB")
  })
})
