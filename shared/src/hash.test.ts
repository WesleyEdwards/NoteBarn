import {expect, it} from "vitest"
import {sha256Hex} from "./hash"

it("hashes like the server (SHA-256 of UTF-8, hex)", async () => {
  expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  // From the server: sha256Hex("x") in NoteEndpointsTest's world.
  expect(await sha256Hex("x")).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881")
  expect(await sha256Hex("é ✓")).toHaveLength(64)
})
