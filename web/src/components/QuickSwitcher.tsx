import {useEffect, useMemo, useRef, useState} from "react"
import type {Api, SearchHit, Vault} from "@notebarn/shared/api"
import {fuzzyFilter} from "../lib/fuzzy"
import {dirname, normalizeNotePath, noteTitle} from "@notebarn/shared/paths"

interface QuickSwitcherProps {
  api: Api
  vault: Vault.ID
  paths: readonly string[]
  recent: readonly string[]
  onOpen(path: string): void
  onCreate(path: string): void
  onClose(): void
}

type Item = {kind: "note"; path: string} | {kind: "create"; path: string} | {kind: "hit"; hit: SearchHit}

/** Find a note by name (instantly) or by what's in it (from the server), or create one. */
export function QuickSwitcher({api, vault, paths, recent, onOpen, onCreate, onClose}: QuickSwitcherProps) {
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const names = useMemo(() => {
    if (!query.trim()) return recent.filter((p) => paths.includes(p)).slice(0, 10)
    return fuzzyFilter(query, paths, 30)
  }, [query, paths, recent])

  useEffect(() => {
    const q = query.trim()
    setHits([])
    if (q.length < 2) return
    setSearching(true)
    let cancelled = false
    const timer = setTimeout(() => {
      api.note
        .searchNotes({vault, query: q, limit: 30})
        .then((h) => !cancelled && setHits(h.filter((x) => x.snippet !== null)))
        .catch(() => {})
        .finally(() => !cancelled && setSearching(false))
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, vault])

  const createPath = normalizeNotePath(query)
  // Creating comes last, so Enter opens the best match; Shift+Enter always creates.
  const items: Item[] = [
    ...names.map((path) => ({kind: "note" as const, path})),
    ...hits.filter((h) => !names.includes(h.path)).map((hit) => ({kind: "hit" as const, hit})),
    ...(createPath && !paths.some((p) => p.toLowerCase() === createPath.toLowerCase())
      ? [{kind: "create" as const, path: createPath}]
      : [])
  ]

  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({block: "nearest"})
  }, [selected])

  const choose = (item: Item | undefined) => {
    if (!item) return
    if (item.kind === "create") onCreate(item.path)
    else onOpen(item.kind === "note" ? item.path : item.hit.path)
    onClose()
  }

  return (
    <div className="modal-backdrop top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="switcher" role="dialog" aria-modal="true" aria-label="Find a note">
        <input
          autoFocus
          className="switcher-input"
          placeholder="Find or create a note…"
          value={query}
          enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setSelected((s) => Math.min(s + 1, items.length - 1))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setSelected((s) => Math.max(s - 1, 0))
            } else if (e.key === "Enter") {
              e.preventDefault()
              // Shift+Enter always creates, like Obsidian.
              choose(e.shiftKey && createPath ? {kind: "create", path: createPath} : items[selected])
            } else if (e.key === "Escape") onClose()
          }}
        />
        <ul className="switcher-list" ref={list}>
          {!query.trim() && names.length > 0 && <li className="switcher-heading">Recent</li>}
          {items.map((item, i) => (
            <li
              key={item.kind === "hit" ? `hit:${item.hit.path}` : `${item.kind}:${item.path}`}
              data-index={i}
              className={i === selected ? "switcher-item selected" : "switcher-item"}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(item)}
            >
              {item.kind === "note" && (
                <>
                  <span className="switcher-title">{noteTitle(item.path)}</span>
                  {dirname(item.path) && <span className="switcher-detail">{dirname(item.path)}</span>}
                </>
              )}
              {item.kind === "create" && (
                <span className="switcher-title">
                  <span className="switcher-create">Create</span> {item.path.replace(/\.md$/i, "")}
                </span>
              )}
              {item.kind === "hit" && (
                <>
                  <span className="switcher-title">{noteTitle(item.hit.path)}</span>
                  <span className="switcher-snippet">{item.hit.snippet}</span>
                </>
              )}
            </li>
          ))}
          {query.trim().length >= 2 && searching && <li className="switcher-heading">Searching note contents…</li>}
          {items.length === 0 && !searching && <li className="switcher-heading">No notes yet.</li>}
        </ul>
      </div>
    </div>
  )
}
