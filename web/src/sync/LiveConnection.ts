import type {VaultChanged} from "@notebarn/shared/api"

/** The smallest subset of the browser's WebSocket this needs, so tests can hand in a fake. */
export interface SocketLike {
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: {data: unknown}) => void) | null
  onclose: ((e: unknown) => void) | null
  onerror: ((e: unknown) => void) | null
  readonly readyState: number
  send(data: string): void
  close(): void
}

export interface LiveEvents {
  /** The connection (re)opened. Anything changed while it was down wasn't sent, so catch up now. */
  opened(): void
  /** A note in the vault changed; the server's newest version is now `latestVersion`. */
  changed(latestVersion: number): void
  /** The connection dropped (it will try again by itself). */
  closed(): void
}

const OPEN = 1
/** API Gateway drops a websocket after 10 minutes without messages, so say something more often than that. */
const KEEPALIVE_MS = 4 * 60 * 1000
const MAX_BACKOFF_MS = 30_000

/**
 * A websocket to the server's Live Changes endpoint that keeps itself open: reconnecting with backoff when it drops,
 * straight away when the page comes back into view or the device comes back online, and sending a keepalive so idle
 * connections aren't closed. It only passes on nudges; VaultStore asks for the actual changes.
 */
export class LiveConnection {
  private socket: SocketLike | null = null
  private stopped = true
  private backoff = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private keepalive: ReturnType<typeof setInterval> | null = null
  private connecting = false

  constructor(
    private readonly url: () => Promise<string>,
    private readonly events: LiveEvents,
    private readonly open: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike
  ) {}

  get isOpen() {
    return this.socket?.readyState === OPEN
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    document.addEventListener("visibilitychange", this.wake)
    window.addEventListener("online", this.wake)
    void this.connect()
  }

  stop() {
    this.stopped = true
    document.removeEventListener("visibilitychange", this.wake)
    window.removeEventListener("online", this.wake)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.drop()
  }

  /** Reconnects now, rather than waiting out the backoff, if the connection is down. */
  private wake = () => {
    if (this.stopped || document.visibilityState !== "visible" || this.socket || this.connecting) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.backoff = 1000
    void this.connect()
  }

  private drop() {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      socket.close()
    }
  }

  private async connect() {
    if (this.stopped || this.socket || this.connecting) return
    this.connecting = true
    let url: string
    try {
      url = await this.url()
    } catch {
      // Offline, or the session can't get a token right now.
      this.connecting = false
      this.retry()
      return
    }
    this.connecting = false
    if (this.stopped || this.socket) return
    let socket: SocketLike
    try {
      socket = this.open(url)
    } catch {
      this.retry()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.backoff = 1000
      this.keepalive = setInterval(() => {
        if (this.isOpen) socket.send(JSON.stringify("ping"))
      }, KEEPALIVE_MS)
      this.events.opened()
    }
    socket.onmessage = (e) => {
      if (typeof e.data !== "string") return
      try {
        const message = JSON.parse(e.data) as Partial<VaultChanged>
        if (typeof message.latestVersion === "number") this.events.changed(message.latestVersion)
      } catch {
        // Not one of ours.
      }
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      const wasOpen = !!this.keepalive
      this.drop()
      if (wasOpen) this.events.closed()
      this.retry()
    }
    // A failed connection also closes, which is where it's retried.
    socket.onerror = () => {}
  }

  private retry() {
    if (this.stopped || this.retryTimer) return
    // A little jitter so a server restart doesn't get every tab back at the same moment.
    const delay = this.backoff * (0.75 + Math.random() * 0.5)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
  }
}
