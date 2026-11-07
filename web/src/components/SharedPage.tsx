import {useEffect, useMemo, useState} from "react"
import {LiveApi, type Share, type SharedNote} from "@notebarn/shared/api"
import {createFetcher, errorMessage} from "../api/client"
import {BACKEND_URL} from "../backends"
import {when} from "../lib/when"
import {AttachmentContext, type AttachmentContextValue} from "../sync/attachments"
import {Reader} from "./Reader"

/** A note someone shared, as it is now, for anyone with the link. Needs no login and can't change anything. */
export function SharedPage({id}: {id: Share.ID}) {
  const api = useMemo(() => new LiveApi(createFetcher(BACKEND_URL, () => ({}))), [])
  const [note, setNote] = useState<SharedNote | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = () =>
      api.share.viewSharedNote(id).then(
        (n) => {
          setNote(n)
          setError(null)
        },
        async (e) => {
          // Claude: a 404 means the link was turned off; anything else (offline) keeps showing what's already here.
          if (e instanceof Response && e.status === 404) setNote(null)
          setError(await errorMessage(e))
        }
      )
    void load()
    const onVisible = () => document.visibilityState === "visible" && void load()
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [api, id])

  // Claude: the link is meant for the people it's given to, not search engines.
  useEffect(() => {
    const meta = document.createElement("meta")
    meta.name = "robots"
    meta.content = "noindex"
    document.head.append(meta)
    return () => meta.remove()
  }, [])

  useEffect(() => {
    document.title = note ? `${note.title} · Notebarn` : "Notebarn"
  }, [note])

  // The reader finds each embed by the name it's written with, among exactly the files the server sent.
  const attachments = useMemo<AttachmentContextValue>(() => {
    const byTarget = new Map(note?.attachments.map((a) => [a.target, a]))
    const urls = new Map(note?.attachments.map((a) => [a.hash, a.url]))
    return {
      hashOf: (target) => byTarget.get(target)?.hash ?? null,
      links: {
        cached: (hash) => urls.get(hash) ?? null,
        url: (hash) => (urls.has(hash) ? Promise.resolve(urls.get(hash)!) : Promise.reject(new Error("Not shared")))
      }
    }
  }, [note])
  const targets = useMemo(() => note?.attachments.map((a) => a.target) ?? [], [note])

  if (!note) {
    if (!error) return <div className="splash" aria-busy="true" />
    return (
      <div className="login">
        <div className="login-card">
          <h1>Can't open this note</h1>
          <p>{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="shared-page">
      <article className="note reading">
        <h1 className="note-title">{note.title}</h1>
        <AttachmentContext.Provider value={attachments}>
          <Reader text={note.content} path="" paths={targets} />
        </AttachmentContext.Provider>
        <p className="shared-footer">Changed {when(note.modifiedAt).replace(/^(Today|Yesterday)/, (d) => d.toLowerCase())} · Shared with Notebarn</p>
      </article>
    </div>
  )
}
