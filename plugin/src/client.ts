import {requestUrl} from "obsidian"
import type {Fetcher} from "@lightningkite/lightning-server-simplified"
import {LiveApi} from "@notebarn/shared/api"
import {HttpError} from "@notebarn/shared/errors"
import type {ByteTransfer} from "@notebarn/shared/sync/SyncEngine"

/**
 * Calls the server with Obsidian's requestUrl (no CORS limits, works on mobile). Error statuses throw HttpError;
 * a request that never got an answer throws a TypeError, which the sync engine reads as "offline".
 */
function obsidianFetcher(baseUrl: string, token: () => Promise<string | null>): Fetcher {
  return async function <Body, T>(path: string, method: string, body: Body): Promise<T> {
    const t = await token()
    let response
    try {
      response = await requestUrl({
        url: baseUrl.replace(/\/+$/, "") + path,
        method,
        contentType: "application/json",
        headers: {Accept: "application/json", ...(t ? {Authorization: `Bearer ${t}`} : {})},
        body: body === undefined ? undefined : JSON.stringify(body),
        throw: false
      })
    } catch (e) {
      throw new TypeError(`Couldn't reach the server: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (response.status >= 400) {
      let message = `The server answered ${response.status}`
      try {
        if (response.json?.message) message = String(response.json.message)
      } catch {
        // Not JSON.
      }
      throw new HttpError(response.status, message)
    }
    if (!response.text) return undefined as T
    return response.json as T
  }
}

/** An API client with no session, for signing in. */
export const anonymousApi = (serverUrl: string) => new LiveApi(obsidianFetcher(serverUrl, async () => null))

/**
 * An API client for a signed-in session. The long-lived session token is traded for a short-lived access token,
 * refreshed every few minutes. `onSignedOut` runs if the server no longer accepts the session.
 */
export function sessionApi(serverUrl: string, sessionToken: string, onSignedOut: () => void) {
  const anon = anonymousApi(serverUrl)
  let token = ""
  let fetchedAt = 0
  let pending: Promise<string> | null = null
  const getToken = () => {
    if (token && Date.now() - fetchedAt < 3 * 60 * 1000) return Promise.resolve(token)
    pending ??= anon.userAuth
      .getTokenSimple(sessionToken)
      .then((t) => {
        token = t
        fetchedAt = Date.now()
        return t
      })
      .catch((e) => {
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) onSignedOut()
        throw e
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
  return new LiveApi(obsidianFetcher(serverUrl, getToken))
}

/**
 * Moves attachments' bytes to and from the links the server hands out, with requestUrl (no CORS limits). Like the
 * API calls, no answer at all throws a TypeError ("offline") and an error status throws HttpError.
 */
export const obsidianTransfer: ByteTransfer = {
  async put(url, data, contentType) {
    const response = await request(() =>
      requestUrl({url, method: "PUT", contentType, body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, throw: false})
    )
    if (response.status >= 400) throw new HttpError(response.status, `Uploading an attachment failed (${response.status})`)
  },
  async get(url) {
    const response = await request(() => requestUrl({url, method: "GET", throw: false}))
    if (response.status >= 400) throw new HttpError(response.status, `Downloading an attachment failed (${response.status})`)
    return new Uint8Array(response.arrayBuffer)
  }
}

async function request<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send()
  } catch (e) {
    throw new TypeError(`Couldn't reach the server: ${e instanceof Error ? e.message : String(e)}`)
  }
}
