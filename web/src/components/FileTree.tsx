import {memo, useEffect, useMemo, useState, type DragEvent, type MouseEvent} from "react"
import {buildTree, noteTitle, isMarkdown, basename, dirname, type FolderNode} from "@notebarn/shared/paths"
import {usePersistentState} from "../lib/storage"
import type {MenuAnchor} from "./Menu"

export type TreeItem = {kind: "file" | "folder"; path: string}

interface FileTreeProps {
  vault: string
  paths: readonly string[]
  current: string | null
  onOpen(path: string): void
  onNewNote(folder: string): void
  /** Right-click, long press, or the "⋯" button on a row. */
  onMenu(item: TreeItem, anchor: MenuAnchor): void
  /** Dragged onto a folder (or "" for the top level). */
  onDrop(item: TreeItem, folder: string): void
}

const DRAG_TYPE = "application/x-notebarn-item"

export const FileTree = memo(function FileTree({vault, paths, current, onOpen, onNewNote, onMenu, onDrop}: FileTreeProps) {
  const tree = useMemo(() => buildTree(paths), [paths])
  const [open, setOpen] = usePersistentState<Record<string, boolean>>(`tree-open:${vault}`, {})
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const toggle = (path: string) => setOpen((o) => ({...o, [path]: !o[path]}))

  // Opening a note reveals it by expanding its folders, once; after that they collapse and expand as usual.
  useEffect(() => {
    if (!current) return
    const parts = current.split("/")
    const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))
    if (ancestors.length === 0) return
    setOpen((o) => (ancestors.every((a) => o[a]) ? o : {...o, ...Object.fromEntries(ancestors.map((a) => [a, true]))}))
  }, [current, setOpen])

  // Scroll the open note into view when it changes (say, opened from search).
  useEffect(() => {
    if (!current) return
    const el = document.querySelector<HTMLElement>(`.tree-row.file[data-path="${CSS.escape(current)}"]`)
    el?.scrollIntoView({block: "nearest"})
  }, [current, open])

  const menu = (item: TreeItem) => (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onMenu(item, {x: e.clientX, y: e.clientY})
  }

  const dragStart = (item: TreeItem) => (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))
    e.dataTransfer.effectAllowed = "move"
  }
  const dropProps = (folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = "move"
      setDropTarget(folder)
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropTarget((t) => (t === folder ? null : t))
    },
    onDrop: (e: DragEvent) => {
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      setDropTarget(null)
      if (!raw) return
      e.preventDefault()
      e.stopPropagation()
      const item = JSON.parse(raw) as TreeItem
      // Nowhere to go: already there, or a folder into itself.
      if (dirname(item.path) === folder) return
      if (item.kind === "folder" && (folder === item.path || folder.startsWith(`${item.path}/`))) return
      onDrop(item, folder)
    }
  })

  const renderFolder = (folder: FolderNode, depth: number) => (
    <>
      {folder.folders.map((f) => {
        const expanded = !!open[f.path]
        const item: TreeItem = {kind: "folder", path: f.path}
        return (
          <li key={`d:${f.path}`} {...dropProps(f.path)} className={dropTarget === f.path ? "drop-target" : undefined}>
            <div
              className="tree-row folder"
              style={{paddingLeft: 8 + depth * 14}}
              draggable
              onDragStart={dragStart(item)}
              onContextMenu={menu(item)}
            >
              <button className="tree-label" onClick={() => toggle(f.path)} aria-expanded={expanded}>
                <span className={expanded ? "chevron open" : "chevron"} aria-hidden>
                  ›
                </span>
                {f.name}
              </button>
              <button className="tree-action" title={`New note in ${f.name}`} onClick={() => onNewNote(f.path)}>
                +
              </button>
              <button
                className="tree-action"
                title="More"
                onClick={(e) => {
                  e.stopPropagation()
                  onMenu(item, e.currentTarget.getBoundingClientRect())
                }}
              >
                ⋯
              </button>
            </div>
            {expanded && <ul>{renderFolder(f, depth + 1)}</ul>}
          </li>
        )
      })}
      {folder.files.map((p) => (
        <li key={`f:${p}`}>
          <button
            className={p === current ? "tree-row file active" : "tree-row file"}
            style={{paddingLeft: 22 + depth * 14}}
            onClick={() => onOpen(p)}
            onContextMenu={menu({kind: "file", path: p})}
            draggable
            onDragStart={dragStart({kind: "file", path: p})}
            data-path={p}
            title={p}
          >
            {isMarkdown(p) ? noteTitle(p) : basename(p)}
            {!isMarkdown(p) && <span className="file-ext">{basename(p).split(".").pop()}</span>}
          </button>
        </li>
      ))}
    </>
  )

  if (paths.length === 0) return <p className="tree-empty">No notes yet.</p>
  return (
    <ul className={dropTarget === "" ? "tree drop-target" : "tree"} {...dropProps("")}>
      {renderFolder(tree, 0)}
    </ul>
  )
}
)
