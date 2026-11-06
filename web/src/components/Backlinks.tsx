import {useEffect, useRef, useState} from "react"
import type {Api, Vault} from "@notebarn/shared/api"
import {dirname, noteTitle} from "@notebarn/shared/paths"
import {usePersistentState} from "../lib/storage"
import {backlinks, type Backlink} from "../sync/fileOps"

/** "Linked mentions" under a note: the other notes that link to it, like Obsidian's backlinks pane. */
export function Backlinks({api, vault, path, paths, onOpen}: {api: Api; vault: Vault.ID; path: string; paths: readonly string[]; onOpen(p: string): void}) {
  const [links, setLinks] = useState<Backlink[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = usePersistentState("backlinks-open", true)
  // The file list changes with every save; read it when looking, rather than looking again each time.
  const latestPaths = useRef(paths)
  latestPaths.current = paths

  useEffect(() => {
    let cancelled = false
    setLinks(null)
    setFailed(false)
    // Let the note itself load first.
    const timer = setTimeout(() => {
      backlinks(api, vault, path, latestPaths.current)
        .then((b) => !cancelled && setLinks(b))
        .catch(() => !cancelled && setFailed(true))
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Looked up once per note.
  }, [api, vault, path])

  if (failed || links === null) return null
  return (
    <section className="backlinks" aria-label="Linked mentions">
      <button className="backlinks-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={open ? "chevron open" : "chevron"} aria-hidden>
          ›
        </span>
        Linked mentions
        <span className="backlinks-count">{links.length}</span>
      </button>
      {open &&
        (links.length === 0 ? (
          <p className="backlinks-empty">No other notes link here yet.</p>
        ) : (
          <ul className="backlinks-list">
            {links.map((b) => (
              <li key={b.path}>
                <button onClick={() => onOpen(b.path)}>
                  <span className="backlinks-title">
                    {noteTitle(b.path)}
                    {dirname(b.path) && <span className="backlinks-folder">{dirname(b.path)}</span>}
                  </span>
                  {b.lines.slice(0, 3).map((line, i) => (
                    <span key={i} className="backlinks-line">
                      {line}
                    </span>
                  ))}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  )
}
