import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {LiveConnection, type SocketLike} from "./LiveConnection"

class FakeSocket implements SocketLike {
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: {data: unknown}) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readyState = 0
  sent: string[] = []
  closed = false
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  serverOpens() {
    this.readyState = 1
    this.onopen?.({})
  }
  serverSends(data: unknown) {
    this.onmessage?.({data: JSON.stringify(data)})
  }
  serverDrops() {
    this.readyState = 3
    this.onclose?.({})
  }
}

const listeners = new Map<string, () => void>()
const fakeTarget = {
  addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  removeEventListener: (name: string) => listeners.delete(name)
}

describe("LiveConnection", () => {
  let sockets: FakeSocket[]
  let events: {opened: number; changed: number[]; closed: number}
  let live: LiveConnection
  let token = 0

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("document", {...fakeTarget, visibilityState: "visible"})
    vi.stubGlobal("window", fakeTarget)
    sockets = []
    events = {opened: 0, changed: [], closed: 0}
    live = new LiveConnection(
      async () => `ws://server/?jwt=${++token}`,
      {
        opened: () => events.opened++,
        changed: (v) => events.changed.push(v),
        closed: () => events.closed++
      },
      (url) => {
        const s = new FakeSocket(url)
        sockets.push(s)
        return s
      }
    )
  })

  afterEach(() => {
    live.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("passes on nudges and keeps the connection alive", async () => {
    live.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(1)
    sockets[0].serverOpens()
    expect(events.opened).toBe(1)
    expect(live.isOpen).toBe(true)

    sockets[0].serverSends({vault: "v", latestVersion: 7})
    sockets[0].onmessage?.({data: "not json"})
    expect(events.changed).toEqual([7])

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    expect(sockets[0].sent).toEqual([JSON.stringify("ping")])
  })

  it("reconnects with a fresh token after a drop, backing off while it can't", async () => {
    live.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].serverOpens()
    sockets[0].serverDrops()
    expect(events.closed).toBe(1)
    expect(live.isOpen).toBe(false)

    // Retries about a second later, with a new token.
    await vi.advanceTimersByTimeAsync(1300)
    expect(sockets).toHaveLength(2)
    expect(sockets[1].url).not.toBe(sockets[0].url)

    // Fails to connect: tries again, waiting longer.
    sockets[1].serverDrops()
    expect(events.closed).toBe(1)
    await vi.advanceTimersByTimeAsync(1400)
    expect(sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1200)
    expect(sockets).toHaveLength(3)

    sockets[2].serverOpens()
    expect(events.opened).toBe(2)
  })

  it("reconnects straight away when the device comes back online", async () => {
    live.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 4; i++) {
      sockets.at(-1)!.serverDrops()
      await vi.advanceTimersByTimeAsync(20_000)
    }
    const count = sockets.length
    sockets.at(-1)!.serverDrops()
    listeners.get("online")!()
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(count + 1)
  })

  it("stops for good", async () => {
    live.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].serverOpens()
    live.stop()
    expect(sockets[0].closed).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(1)
  })
})
