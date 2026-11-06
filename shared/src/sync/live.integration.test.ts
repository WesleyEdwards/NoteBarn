// Two "devices" (real folders) syncing one vault through a real running server.
// Runs only with NOTEBARN_SERVER (e.g. http://localhost:8085) and NOTEBARN_SERVER_LOG (the server's output, for the
// sign-in code; the server must use console email and allow any email). Otherwise skipped.
import fs from "node:fs/promises"
import {readFileSync} from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import {describe, expect, it} from "vitest"
import type {Fetcher} from "@lightningkite/lightning-server-simplified"
import {LiveApi, type Vault} from "../api"
import {HttpError} from "../errors"
import {sha256Hex, sha256HexBytes} from "../hash"
import {MemoryBases} from "./testing"
import {SyncEngine, remoteVault, type ByteTransfer, type LocalFiles} from "./SyncEngine"

const SERVER = process.env.NOTEBARN_SERVER
const LOG = process.env.NOTEBARN_SERVER_LOG

class FolderFiles implements LocalFiles {
  constructor(readonly root: string) {}
  async list() {
    const out: string[] = []
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(nodePath.join(this.root, dir), {withFileTypes: true})) {
        const rel = dir ? `${dir}/${e.name}` : e.name
        if (e.isDirectory()) await walk(rel)
        else out.push(rel)
      }
    }
    await walk("")
    return out
  }
  async read(path: string) {
    return fs.readFile(nodePath.join(this.root, path), "utf8").catch(() => null)
  }
  async write(path: string, content: string, expected: string | null) {
    if ((await this.read(path)) !== expected) return false
    await fs.mkdir(nodePath.dirname(nodePath.join(this.root, path)), {recursive: true})
    await fs.writeFile(nodePath.join(this.root, path), content)
    return true
  }
  async remove(path: string, expectedHash: string) {
    const bytes = await this.readBytes(path)
    if (!bytes || (await sha256HexBytes(bytes)) !== expectedHash) return false
    await fs.rm(nodePath.join(this.root, path))
    return true
  }
  async readBytes(path: string) {
    return fs.readFile(nodePath.join(this.root, path)).then((b: Uint8Array) => new Uint8Array(b)).catch(() => null)
  }
  async hashBytes(path: string) {
    const bytes = await this.readBytes(path)
    return bytes ? sha256HexBytes(bytes) : null
  }
  async writeBytes(path: string, data: Uint8Array, expectedHash: string | null) {
    if ((await this.hashBytes(path)) !== expectedHash) return false
    await fs.mkdir(nodePath.dirname(nodePath.join(this.root, path)), {recursive: true})
    await fs.writeFile(nodePath.join(this.root, path), data)
    return true
  }
}

const transfer: ByteTransfer = {
  async put(url, data, contentType) {
    const r = await fetch(url, {method: "PUT", headers: {"Content-Type": contentType}, body: data as Uint8Array<ArrayBuffer>})
    if (!r.ok) throw new HttpError(r.status, await r.text())
  },
  async get(url) {
    const r = await fetch(url)
    if (!r.ok) throw new HttpError(r.status, await r.text())
    return new Uint8Array(await r.arrayBuffer())
  }
}

function fetcher(token: () => Promise<string | null>): Fetcher {
  return async function <B, T>(path: string, method: string, body: B): Promise<T> {
    const t = await token()
    const r = await fetch(SERVER + path, {
      method,
      headers: {"Content-Type": "application/json", ...(t ? {Authorization: `Bearer ${t}`} : {})},
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!r.ok) throw new HttpError(r.status, await r.text())
    const text = await r.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
}

async function signIn(): Promise<LiveApi> {
  const anon = new LiveApi(fetcher(async () => null))
  const before = readFileSync(LOG!, "utf8").length
  const key = await anon.userAuth.beginEmailOwnershipProof("sync-test@example.com")
  let pin: string | undefined
  for (let i = 0; i < 40 && !pin; i++) {
    pin = /Your Notes code is (\d{6})/.exec(readFileSync(LOG!, "utf8").slice(before))?.[1]
    if (!pin) await new Promise((r) => setTimeout(r, 100))
  }
  const proof = await anon.userAuth.proveEmailOwnership({key, password: pin!})
  const session = (await anon.userAuth.logIn([proof])).session!
  const token = await anon.userAuth.getTokenSimple(session)
  return new LiveApi(fetcher(async () => token))
}

describe.skipIf(!SERVER || !LOG)("sync against a real server", () => {
  it("keeps two folders in step through edits, merges, conflicts and deletes", async () => {
    const api = await signIn()
    const vault = await api.vault.insert({
      _id: crypto.randomUUID() as Vault.ID,
      owner: crypto.randomUUID() as Vault["owner"],
      name: "Integration",
      createdAt: new Date().toISOString(),
      latestVersion: 0
    })
    const tmp = await fs.mkdtemp(nodePath.join(process.env.TMPDIR ?? os.tmpdir(), "sync-"))
    const device = async (name: string, initial: Record<string, string>) => {
      const files = new FolderFiles(nodePath.join(tmp, name))
      await fs.mkdir(files.root, {recursive: true})
      for (const [p, c] of Object.entries(initial)) await files.write(p, c, null)
      const conflicts: string[] = []
      const engine = new SyncEngine(files, new MemoryBases(), remoteVault(api, vault._id, transfer), {onConflict: (_p, c) => conflicts.push(c)})
      return {files, engine, conflicts}
    }
    const snapshot = async (f: FolderFiles) =>
      Object.fromEntries(await Promise.all((await f.list()).sort().map(async (p) => [p, await f.read(p)])))

    const a = await device("laptop", {"Shared.md": "one\ntwo\nthree\n", "Folder/Laptop.md": "from laptop", "ünïcode ✓.md": "héllo"})
    const b = await device("phone", {"Phone.md": "from phone"})

    // First sync both ways.
    await a.engine.fullSync()
    await b.engine.fullSync()
    await a.engine.pull()
    expect(await snapshot(a.files)).toEqual(await snapshot(b.files))
    expect(Object.keys(await snapshot(a.files)).sort()).toEqual(["Folder/Laptop.md", "Phone.md", "Shared.md", "ünïcode ✓.md"])

    // Both edit different lines of the same note; both end up with both edits.
    await a.files.write("Shared.md", "ONE\ntwo\nthree\n", "one\ntwo\nthree\n")
    await b.files.write("Shared.md", "one\ntwo\nTHREE\n", "one\ntwo\nthree\n")
    await a.engine.localChanged("Shared.md")
    await b.engine.localChanged("Shared.md")
    await a.engine.pull()
    expect(await a.files.read("Shared.md")).toBe("ONE\ntwo\nTHREE\n")
    expect(await b.files.read("Shared.md")).toBe("ONE\ntwo\nTHREE\n")

    // Both change the same line: one wins at the path, the other is kept as a conflict copy on both devices.
    await a.files.write("Phone.md", "laptop's version", "from phone")
    await b.files.write("Phone.md", "phone's version", "from phone")
    await a.engine.localChanged("Phone.md")
    await b.engine.localChanged("Phone.md")
    await a.engine.pull()
    expect(b.conflicts).toHaveLength(1)
    expect(await snapshot(a.files)).toEqual(await snapshot(b.files))
    expect(await a.files.read("Phone.md")).toBe("laptop's version")
    expect(await a.files.read(b.conflicts[0])).toBe("phone's version")

    // A delete on one device reaches the other.
    await a.files.remove("Folder/Laptop.md", await sha256Hex("from laptop"))
    await a.engine.localChanged("Folder/Laptop.md")
    await b.engine.pull()
    expect(await b.files.read("Folder/Laptop.md")).toBeNull()

    // An image goes up from one device, through the file store, and down to the other, byte for byte.
    const image = new Uint8Array(3000).map((_, i) => (i * 7) % 256)
    await a.files.writeBytes("img/photo.png", image, null)
    await a.engine.localChanged("img/photo.png")
    await b.engine.pull()
    expect(await b.files.readBytes("img/photo.png")).toEqual(image)
    // And deleting it there removes it here.
    await b.files.remove("img/photo.png", await sha256HexBytes(image))
    await b.engine.localChanged("img/photo.png")
    await a.engine.pull()
    expect(await a.files.readBytes("img/photo.png")).toBeNull()

    // A full sync afterwards finds nothing left to do on either device.
    expect(await a.engine.fullSync(true)).toEqual([])
    expect(await b.engine.fullSync(true)).toEqual([])
    await fs.rm(tmp, {recursive: true})
  }, 60_000)
})
