import type {Fetcher} from "@lightningkite/lightning-server-simplified"
import {useEffect, useMemo, useState} from "react"
import {type Api, LiveApi, type User} from "@notebarn/shared/api"
import {BACKEND_URL} from "../backends"
import {storage} from "../lib/storage"

const SESSION_KEY = "notebarn-session"

/**
 * Calls the server. A response with an error status is thrown as the Response itself; a request that never got an
 * answer (offline) throws a TypeError. NoteSession tells the two apart.
 */
export function createFetcher(baseUrl: string, headers: () => Promise<Record<string, string>> | Record<string, string>): Fetcher {
  return async function <Body, T>(path: string, method: string, body: Body): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {...(await headers()), "Content-Type": "application/json", Accept: "application/json"},
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!response.ok) throw response
    // Endpoints returning nothing send no Content-Type, and reading their body can hang.
    if (!response.headers.get("Content-Type")) return undefined as T
    return (await response.json()) as T
  }
}

/** A readable message for something an API call threw. */
export async function errorMessage(e: unknown): Promise<string> {
  if (e instanceof Response) {
    try {
      const body = await e.clone().json()
      if (body?.message) return String(body.message)
    } catch {
      // Not JSON.
    }
    return e.status === 403 ? "That isn't allowed." : `The server answered ${e.status}.`
  }
  if (e instanceof TypeError) return "Couldn't reach the server. Check your connection."
  return e instanceof Error ? e.message : String(e)
}

/** The session token is long-lived; the access token it's exchanged for lasts a few minutes. */
function accessTokens(sessionToken: string, onRejected: () => void) {
  const api = new LiveApi(createFetcher(BACKEND_URL, () => ({})))
  let token = ""
  let fetchedAt = 0
  let pending: Promise<string> | null = null
  return () => {
    if (pending) return pending
    if (token && Date.now() - fetchedAt < 3 * 60 * 1000) return Promise.resolve(token)
    pending = api.userAuth
      .getTokenSimple(sessionToken)
      .then((t) => {
        token = t
        fetchedAt = Date.now()
        return t
      })
      .catch((e) => {
        if (e instanceof Response && (e.status === 401 || e.status === 403)) onRejected()
        throw e
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}

export type SessionState =
  | {state: "loading"}
  | {state: "signed-out"; api: Api; signIn: (sessionToken: string) => void}
  | {state: "signed-in"; api: Api; user: User; signOut: () => void; accessToken: () => Promise<string>}

export function useSession(): SessionState {
  const [sessionToken, setSessionToken] = useState<string>(() => storage.get(SESSION_KEY, ""))
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(!!sessionToken)

  const signIn = (token: string) => {
    storage.set(SESSION_KEY, token)
    setLoading(true)
    setSessionToken(token)
  }
  const signOut = () => {
    storage.remove(SESSION_KEY)
    storage.remove("notebarn-user")
    setUser(null)
    setSessionToken("")
  }

  const {api, accessToken} = useMemo(() => {
    if (!sessionToken) {
      const accessToken = () => Promise.reject(new Error("Not signed in."))
      return {api: new LiveApi(createFetcher(BACKEND_URL, () => ({}))) as Api, accessToken}
    }
    const accessToken = accessTokens(sessionToken, signOut)
    return {
      api: new LiveApi(createFetcher(BACKEND_URL, async () => ({Authorization: `Bearer ${await accessToken()}`}))) as Api,
      accessToken
    }
  }, [sessionToken])

  useEffect(() => {
    if (!sessionToken) {
      setLoading(false)
      return
    }
    let cancelled = false
    // Remember who's signed in, so the app opens offline too.
    const cached = storage.get<User | null>("notebarn-user", null)
    if (cached) {
      setUser(cached)
      setLoading(false)
    }
    api.userAuth
      .getSelf()
      .then((u) => {
        if (cancelled) return
        storage.set("notebarn-user", u)
        setUser(u)
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof Response && (e.status === 401 || e.status === 403)) signOut()
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [api])

  if (loading && !user) return {state: "loading"}
  if (sessionToken && user) return {state: "signed-in", api, user, signOut, accessToken}
  return {state: "signed-out", api, signIn}
}
