import {describe, expect, it} from "vitest"
import {decide} from "./decide"

const base = {version: 5, hash: "B"}
const live = (version: number, hash: string) => ({version, hash, deleted: false})
const tomb = (version: number) => ({version, hash: "", deleted: true})

describe("decide", () => {
  it("does nothing when all three agree", () => {
    expect(decide("B", base, live(5, "B"))).toEqual({kind: "none"})
  })
  it("sends one-sided changes to the other side", () => {
    expect(decide("L", base, live(5, "B"))).toEqual({kind: "upload", baseVersion: 5})
    expect(decide("B", base, live(7, "S"))).toEqual({kind: "download"})
  })
  it("merges when both changed, and just records it when both made the same change", () => {
    expect(decide("L", base, live(7, "S"))).toEqual({kind: "merge"})
    expect(decide("X", base, live(7, "X"))).toEqual({kind: "adopt"})
  })
  it("on a first sync, adopts matches and never deletes", () => {
    expect(decide("X", null, live(3, "X"))).toEqual({kind: "adopt"})
    expect(decide("L", null, live(3, "S"))).toEqual({kind: "conflict"})
    expect(decide("L", null, null)).toEqual({kind: "upload", baseVersion: null})
    expect(decide(null, null, live(3, "S"))).toEqual({kind: "download"})
    expect(decide("L", null, tomb(4))).toEqual({kind: "upload", baseVersion: null})
  })
  it("passes deletes along only when the other side is untouched", () => {
    expect(decide(null, base, live(5, "B"))).toEqual({kind: "deleteRemote", baseVersion: 5})
    expect(decide("B", base, tomb(8))).toEqual({kind: "deleteLocal"})
  })
  it("lets edits beat deletes", () => {
    expect(decide(null, base, live(7, "S"))).toEqual({kind: "download"})
    expect(decide("L", base, tomb(8))).toEqual({kind: "upload", baseVersion: null})
  })
  it("forgets a file gone from both sides", () => {
    expect(decide(null, base, tomb(8))).toEqual({kind: "forget"})
    expect(decide(null, base, null)).toEqual({kind: "forget"})
    expect(decide(null, null, tomb(8))).toEqual({kind: "none"})
  })
})
