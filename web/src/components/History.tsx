import {useEffect, useMemo, useState} from "react"
import type {Api, NoteVersionContent, NoteVersionSummary, Vault} from "@notebarn/shared/api"
import {lineDiff} from "@notebarn/shared/merge"
import {basename, dirname, isMarkdown, noteTitle} from "@notebarn/shared/paths"
import {errorMessage} from "../api/client"
import {bytes, when} from "../lib/when"
import {useToast} from "./Toast"

const nameOf = (path: string) => (isMarkdown(path) ? noteTitle(path) : basename(path))

/** Esc closes, like the other dialogs. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
}

/**
 * Earlier copies of one note: pick one to see it (or what's different from now) and put it back. Restoring is an
 * edit like any other, so what it replaces is kept in the history too.
 */
export function VersionHistory(props: {
  api: Api
  vault: Vault.ID
  path: string
  /** The note's text right now (including edits not saved yet). */
  current: string
  onRestore(version: NoteVersionSummary): Promise<boolean>
  onClose(): void
}) {
  const {api, vault, path, current, onClose} = props
  const [versions, setVersions] = useState<NoteVersionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<NoteVersionSummary | null>(null)
  const [loaded, setLoaded] = useState<Record<string, NoteVersionContent>>({})
  const [view, setView] = useState<"changes" | "text">("changes")
  const [restoring, setRestoring] = useState(false)
  useEscape(onClose)

  useEffect(() => {
    api.note
      .noteHistory({vault, path})
      .then((v) => {
        setVersions(v)
        // On a wide screen, show the newest straight away.
        if (v.length && matchMedia("(min-width: 769px)").matches) setSelected(v[0])
      })
      .catch(async (e) => setError(await errorMessage(e)))
  }, [api, vault, path])

  useEffect(() => {
    if (!selected || loaded[selected.id]) return
    api.note
      .noteVersion({vault, id: selected.id})
      .then((c) => setLoaded((all) => ({...all, [c.id]: c})))
      .catch(async (e) => setError(await errorMessage(e)))
  }, [selected])

  const content = selected ? loaded[selected.id] : undefined

  const restore = async () => {
    if (!selected) return
    setRestoring(true)
    try {
      if (await props.onRestore(selected)) onClose()
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={selected ? "history showing" : "history"} role="dialog" aria-modal="true" aria-label="Version history">
        <header className="history-header">
          {selected && (
            <button className="icon-button history-back" title="Back to the list" onClick={() => setSelected(null)}>
              ‹
            </button>
          )}
          <h2>
            Version history <span className="history-name">{nameOf(path)}</span>
          </h2>
          <button className="icon-button" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="history-body">
          <ul className="history-list">
            {error && <li className="history-note error">{error}</li>}
            {versions === null && !error && <li className="history-note">Loading…</li>}
            {versions?.length === 0 && (
              <li className="history-note">
                No earlier versions yet. A copy is kept before each change (at most every 10 minutes while you're
                typing), for 14 days, and one a day for 90 days.
              </li>
            )}
            {versions?.map((v) => (
              <li key={v.id}>
                <button className={v.id === selected?.id ? "history-item selected" : "history-item"} onClick={() => setSelected(v)}>
                  <span className="history-when">{when(v.modifiedAt)}</span>
                  <span className="history-detail">
                    {bytes(v.size)}
                    {v.reason === "Delete" && " · before it was deleted"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <section className="history-preview">
            {!selected ? (
              <p className="history-note">Pick a version to see it.</p>
            ) : !content ? (
              <div className="note-loading" aria-busy="true" />
            ) : (
              <>
                <div className="history-toolbar">
                  {!content.attachment && (
                    <div className="segmented" role="tablist">
                      <button role="tab" aria-selected={view === "changes"} onClick={() => setView("changes")}>
                        Compare with now
                      </button>
                      <button role="tab" aria-selected={view === "text"} onClick={() => setView("text")}>
                        Whole text
                      </button>
                    </div>
                  )}
                  <button className="button primary" disabled={restoring} onClick={() => void restore()}>
                    {restoring ? "Restoring…" : "Restore this version"}
                  </button>
                </div>
                {content.attachment ? (
                  <p className="history-note">
                    The file as it was then ({bytes(content.size)}). Restoring puts it back in place of the current one.
                  </p>
                ) : view === "text" ? (
                  <pre className="history-text">{content.content || <span className="history-note">(empty)</span>}</pre>
                ) : (
                  <Changes then={content.content} now={current} />
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

/** The version's text marked against the current text: lines only it has, and lines it doesn't have. */
function Changes({then, now}: {then: string; now: string}) {
  const lines = useMemo(() => lineDiff(now, then), [then, now])
  if (then === now) return <p className="history-note">Same as the note is now.</p>
  // Long runs of unchanged lines fold away, keeping a little context around each change.
  const CONTEXT = 2
  const near = lines.map((_, i) =>
    lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((l) => l.kind !== "same")
  )
  const out: React.ReactNode[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!near[i]) {
      let j = i
      while (j < lines.length && !near[j]) j++
      out.push(
        <div key={`skip${i}`} className="diff-skip">
          {j - i} unchanged {j - i === 1 ? "line" : "lines"}
        </div>
      )
      i = j - 1
      continue
    }
    const l = lines[i]
    out.push(
      <div key={i} className={`diff-line ${l.kind}`}>
        <span className="diff-mark" aria-label={l.kind === "added" ? "Only in this version" : l.kind === "removed" ? "Only in the note now" : undefined}>
          {l.kind === "added" ? "+" : l.kind === "removed" ? "−" : " "}
        </span>
        {l.text || " "}
      </div>
    )
  }
  return (
    <div className="history-diff">
      <p className="diff-legend">
        <span className="diff-line added">+ only in this version</span> <span className="diff-line removed">− only in the note now</span>
      </p>
      {out}
    </div>
  )
}

/** Notes and files deleted in the last 90 days, to bring back. */
export function RecentlyDeleted(props: {api: Api; vault: Vault.ID; onRestore(version: NoteVersionSummary): Promise<boolean>; onClose(): void}) {
  const {api, vault, onClose} = props
  const toast = useToast()
  const [items, setItems] = useState<NoteVersionSummary[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEscape(onClose)

  useEffect(() => {
    api.note
      .recentlyDeleted(vault)
      .then(setItems)
      .catch(async (e) => {
        toast(`Couldn't load deleted notes: ${await errorMessage(e)}`, "error")
        onClose()
      })
  }, [api, vault])

  const restore = async (v: NoteVersionSummary) => {
    setBusy(v.id)
    try {
      if (await props.onRestore(v)) setItems((all) => all?.filter((x) => x.id !== v.id) ?? null)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="history deleted" role="dialog" aria-modal="true" aria-label="Recently deleted">
        <header className="history-header">
          <h2>Recently deleted</h2>
          <button className="icon-button" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <ul className="history-list wide">
          {items === null && <li className="history-note">Loading…</li>}
          {items?.length === 0 && <li className="history-note">Nothing deleted in the last 90 days.</li>}
          {items?.map((v) => (
            <li key={v.id} className="deleted-item">
              <div className="deleted-text">
                <span className="history-when">{nameOf(v.path)}</span>
                <span className="history-detail">
                  {dirname(v.path) ? `${dirname(v.path)} · ` : ""}deleted {when(v.savedAt).replace(/^(Today|Yesterday)/, (d) => d.toLowerCase())} · {bytes(v.size)}
                </span>
              </div>
              <button className="button" disabled={busy !== null} onClick={() => void restore(v)}>
                {busy === v.id ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
