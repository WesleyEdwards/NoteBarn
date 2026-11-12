import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react"
import {Link, useLocation, useNavigate, useParams} from "react-router-dom"
import type {Api, NoteVersionSummary, Share, User, Vault} from "@notebarn/shared/api"
import {errorMessage} from "../api/client"
import {liveChangesUrl} from "../backends"
import {
  INVALID_NAME_CHARS,
  availablePath,
  basename,
  dirname,
  isMarkdown,
  isTextFile,
  joinPath,
  normalizeNotePath,
  noteTitle,
  parseWikilink,
  resolveWikilink,
  untitledPath
} from "@notebarn/shared/paths"
import {dailyPath} from "../lib/daily"
import {storage, usePersistentState} from "../lib/storage"
import type {NoteSession, SaveState} from "../sync/NoteSession"
import {VaultStore} from "../sync/VaultStore"
import {AttachmentContext, AttachmentLinks, uploadAttachment, type AttachmentContextValue} from "../sync/attachments"
import {deleteFiles, duplicateFile, moveFiles, restoreFiles} from "../sync/fileOps"
import {AttachmentView} from "./Attachment"
import {exportVault, saveBlob} from "../sync/exportVault"
import {noteCache} from "../sync/noteCache"
import {useDialogs} from "./Dialog"
import {FileTree, type TreeItem} from "./FileTree"
import {RecentlyDeleted, VersionHistory} from "./History"
import {when} from "../lib/when"
import {PopupMenu, type MenuAnchor, type MenuItem} from "./Menu"
import {NoteView, type Mode} from "./NoteView"
import {QuickSwitcher} from "./QuickSwitcher"
import {ShareDialog} from "./ShareDialog"
import {useToast} from "./Toast"

export const notePath = (vault: string, path: string) => `/v/${vault}/n/${path.split("/").map(encodeURIComponent).join("/")}`

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const modKey = isMac ? "⌘" : "Ctrl"

export function Workspace({
  api,
  user,
  signOut,
  accessToken
}: {
  api: Api
  user: User
  signOut(): void
  accessToken(): Promise<string>
}) {
  const params = useParams()
  const vaultId = params.vaultId as Vault.ID
  const rest = params["*"] ?? ""
  const path = rest.startsWith("n/") && rest.length > 2 ? rest.slice(2) : null
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const dialogs = useDialogs()

  const store = useMemo(
    () => new VaultStore(api, vaultId, undefined, async () => liveChangesUrl(vaultId, await accessToken())),
    // accessToken changes along with api.
    [api, vaultId]
  )
  useEffect(() => {
    store.start()
    return () => store.stop()
  }, [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const paths = snapshot.paths
  const links = useMemo(() => new AttachmentLinks(api, vaultId), [api, vaultId])
  // Rebuilt when the file list changes, so embeds of a file that just arrived show up.
  const attachments = useMemo<AttachmentContextValue>(
    () => ({
      links,
      hashOf: (p) => {
        const s = store.summary(p)
        return s?.attachment ? s.hash : null
      }
    }),
    [links, store, snapshot]
  )
  const isAttachment = path !== null && !isTextFile(path)

  const [vaultName, setVaultName] = useState<string>(() => storage.get(`vault-name:${vaultId}`, ""))
  useEffect(() => {
    storage.set("last-vault", vaultId)
    api.vault
      .detail(vaultId)
      .then((v) => {
        setVaultName(v.name)
        storage.set(`vault-name:${vaultId}`, v.name)
      })
      .catch(async (e) => {
        if (e instanceof Response && (e.status === 404 || e.status === 403)) {
          storage.remove("last-vault")
          toast("That vault doesn't exist, or isn't yours.", "error")
          navigate("/", {replace: true})
        }
      })
  }, [api, vaultId])

  const [mode, setMode] = usePersistentState<Mode>("mode", "edit")
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [desktopSidebar, setDesktopSidebar] = usePersistentState("sidebar", true)
  const [switcher, setSwitcher] = useState(false)
  /** What's under way that takes a moment (moving a folder, uploading), shown in the top bar. */
  const [busy, setBusy] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [recent, setRecent] = usePersistentState<string[]>(`recent:${vaultId}`, [])
  const sessionRef = useRef<NoteSession | null>(null)
  const justCreated = (location.state as {created?: boolean} | null)?.created === true

  useEffect(() => {
    if (!path) return
    setRecent((r) => [path, ...r.filter((p) => p !== path)].slice(0, 30))
    setSaveState("saved")
  }, [path])

  const open = useCallback(
    (p: string, state?: {created?: boolean}) => {
      setSidebarOpen(false)
      if (p === path) return
      navigate(notePath(vaultId, p), {state})
    },
    [navigate, vaultId, path]
  )

  const openLink = useCallback(
    (target: string) => {
      const link = parseWikilink(target)
      const found = path ? resolveWikilink(link.target, path, paths) : null
      // A link to a note that doesn't exist opens it empty; typing creates it, like Obsidian.
      open(found ?? normalizeNotePath(link.target))
    },
    [path, paths, open]
  )

  const newNote = useCallback(
    async (folder: string) => {
      const p = untitledPath(folder, paths)
      try {
        const result = await api.note.writeNote({vault: vaultId, path: p, content: "", baseVersion: null})
        if (result.note) {
          store.noteSaved(result.note)
          noteCache.put(result.note)
        }
        open(p, {created: true})
      } catch (e) {
        toast(`Couldn't make a note: ${await errorMessage(e)}`, "error")
      }
    },
    [api, vaultId, paths, store, open]
  )

  const createAt = useCallback(
    async (p: string) => {
      if (store.has(p)) return open(p)
      try {
        const result = await api.note.writeNote({vault: vaultId, path: p, content: "", baseVersion: null})
        if (result.note) store.noteSaved(result.note)
        open(p)
      } catch (e) {
        toast(`Couldn't make that note: ${await errorMessage(e)}`, "error")
      }
    },
    [api, vaultId, store, open]
  )

  /** Whether `to` is taken by a file other than `from` (a change of case alone is fine). */
  const taken = (to: string, from: string) =>
    to.toLowerCase() !== from.toLowerCase() && paths.some((p) => p.toLowerCase() === to.toLowerCase())

  /**
   * Moves files (and points links to them at their new paths), following the open note if it moved. Saves the open
   * note's edits first. Returns whether everything moved.
   */
  const moveAll = async (moves: Array<[string, string]>): Promise<boolean> => {
    moves = moves.filter(([from, to]) => from !== to)
    if (moves.length === 0) return false
    const clash = moves.find(([from, to]) => taken(to, from) && !moves.some(([f]) => f.toLowerCase() === to.toLowerCase()))
    if (clash) {
      toast(`There's already something called "${basename(clash[1])}" there.`, "error")
      return false
    }
    await sessionRef.current?.flush()
    // A note that was never saved isn't on the server: just open it at its new path.
    if (path && moves.length === 1 && moves[0][0] === path && !store.has(path)) {
      navigate(notePath(vaultId, moves[0][1]), {replace: true})
      return true
    }
    setBusy(moves.length > 1 ? `Moving ${moves.length} files…` : "Moving…")
    try {
      const {failed, relinked} = await moveFiles(api, store, vaultId, moves, (moved) => {
        setRecent((r) => r.map((p) => moved.get(p) ?? p))
        if (path && moved.has(path)) navigate(notePath(vaultId, moved.get(path)!), {replace: true})
      })
      if (failed.length) toast(`Couldn't move ${failed.length === 1 ? `"${basename(failed[0])}"` : `${failed.length} files`}.`, "error")
      else if (relinked) toast(`Updated links in ${relinked} ${relinked === 1 ? "note" : "notes"}.`)
      return failed.length === 0
    } finally {
      setBusy(null)
    }
  }

  const rename = (title: string) => (path ? moveAll([[path, joinPath(dirname(path), `${title}.md`)]]) : Promise.resolve(false))

  const folders = useMemo(() => {
    const all = new Set<string>()
    for (const p of paths) for (let d = dirname(p); d; d = dirname(d)) all.add(d)
    return [...all].sort((a, b) => a.localeCompare(b, undefined, {sensitivity: "base", numeric: true}))
  }, [paths])

  const filesIn = (folder: string) => paths.filter((p) => p.startsWith(`${folder}/`))

  const badName = (name: string) => {
    if (!INVALID_NAME_CHARS.test(name)) return false
    toast("Names can't contain \\ / : * ? \" < > | # ^ [ ]", "error")
    return true
  }

  /** Renames a file or folder where it is. */
  const renameItem = async (item: TreeItem) => {
    const file = item.kind === "file"
    const note = file && isMarkdown(item.path)
    const current = note ? noteTitle(item.path) : basename(item.path)
    const answer = await dialogs.prompt({
      title: file ? (note ? "Rename note" : "Rename file") : "Rename folder",
      label: "New name",
      initial: current,
      confirm: "Rename"
    })
    const name = answer?.trim()
    if (!name || name === current || badName(name)) return
    const target = joinPath(dirname(item.path), note ? `${name}.md` : name)
    if (file) await moveAll([[item.path, target]])
    else await moveAll(filesIn(item.path).map((p) => [p, target + p.slice(item.path.length)]))
  }

  /** Moves a file or folder into another folder. */
  const moveItem = async (item: TreeItem, folder?: string) => {
    if (folder === undefined) {
      const answer = await dialogs.prompt({
        title: item.kind === "folder" ? `Move "${basename(item.path)}"` : `Move "${isMarkdown(item.path) ? noteTitle(item.path) : basename(item.path)}"`,
        label: "Into folder (leave empty for the top level)",
        initial: dirname(item.path),
        confirm: "Move",
        suggestions: folders.filter((f) => item.kind === "file" || (f !== item.path && !f.startsWith(`${item.path}/`)))
      })
      if (answer === null) return
      folder = answer
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean)
        .join("/")
      if (folder.split("/").some((p) => badName(p))) return
    }
    const target = joinPath(folder, basename(item.path))
    if (item.kind === "file") await moveAll([[item.path, target]])
    else {
      if (folder === item.path || folder.startsWith(`${item.path}/`)) return toast("A folder can't go inside itself.", "error")
      await moveAll(filesIn(item.path).map((p) => [p, target + p.slice(item.path.length)]))
    }
  }

  /** Deletes files, with a moment to undo it. */
  const removeFiles = async (targets: string[], what: string) => {
    if (path && targets.includes(path)) {
      // Save, so undoing brings back the latest edits, then stop saving (or it'd come straight back).
      await sessionRef.current?.flush()
      sessionRef.current?.dispose()
      sessionRef.current = null
    }
    setBusy("Deleting…")
    try {
      const {deleted, failed} = await deleteFiles(api, store, vaultId, targets)
      setRecent((r) => r.filter((p) => !targets.includes(p)))
      if (path && targets.includes(path)) navigate(`/v/${vaultId}`, {replace: true})
      if (failed.length) toast(`Couldn't delete ${failed.length === 1 ? `"${basename(failed[0])}"` : `${failed.length} files`}.`, "error")
      else if (deleted.length)
        toast(`Deleted ${what}.`, "info", {
          label: "Undo",
          run: () =>
            void restoreFiles(api, store, vaultId, deleted).then((n) => {
              if (n < deleted.length) toast(`Couldn't bring back ${deleted.length - n} of them.`, "error")
              else if (deleted.length === 1 && deleted[0].path === path) navigate(notePath(vaultId, deleted[0].path))
            })
        })
    } finally {
      setBusy(null)
    }
  }

  const deleteItem = async (item: TreeItem) => {
    if (item.kind === "file") {
      const name = isMarkdown(item.path) ? noteTitle(item.path) : basename(item.path)
      const ok = await dialogs.confirm({
        title: isTextFile(item.path) ? "Delete note" : "Delete file",
        message: `Delete "${name}"? It's deleted on all your devices.`,
        confirm: "Delete",
        danger: true
      })
      if (ok) await removeFiles([item.path], `"${name}"`)
      return
    }
    const inside = filesIn(item.path)
    const ok = await dialogs.confirm({
      title: "Delete folder",
      message: `Delete "${basename(item.path)}" and the ${inside.length} ${inside.length === 1 ? "file" : "files"} in it? They're deleted on all your devices.`,
      confirm: "Delete",
      danger: true
    })
    if (ok) await removeFiles(inside, `"${basename(item.path)}"`)
  }

  const duplicate = async (p: string) => {
    const name = basename(p)
    const ext = /\.[^.]+$/.exec(name)?.[0] ?? ""
    const to = availablePath(dirname(p), `${name.slice(0, name.length - ext.length)} copy${ext}`, paths)
    try {
      await sessionRef.current?.flush()
      await duplicateFile(api, store, vaultId, p, to)
      open(to, {created: isMarkdown(to)})
    } catch (e) {
      toast(`Couldn't duplicate: ${await errorMessage(e)}`, "error")
    }
  }

  const uploadTarget = useRef("")
  const uploader = useRef<HTMLInputElement>(null)
  const upload = (folder: string) => {
    uploadTarget.current = folder
    uploader.current?.click()
  }
  const uploadFiles = async (files: File[]) => {
    const folder = uploadTarget.current
    let last: string | null = null
    for (const file of files) {
      const target = availablePath(folder, file.name.replace(/[\\/:*?"<>|#^[\]]/g, "-") || "file", store.getSnapshot().paths)
      setBusy(`Uploading ${basename(target)}…`)
      try {
        // A markdown file is a note: its text goes in as one.
        if (isTextFile(target)) {
          const result = await api.note.writeNote({vault: vaultId, path: target, content: await file.text(), baseVersion: null})
          if (result.note) store.noteSaved(result.note)
        } else {
          store.noteSaved(await uploadAttachment(api, vaultId, target, file))
        }
        last = target
      } catch (e) {
        toast(`Couldn't upload ${basename(target)}: ${await errorMessage(e)}`, "error")
      }
    }
    setBusy(null)
    if (last && files.length === 1) open(last)
    else if (last) toast(`Uploaded ${files.length} files.`)
  }

  const [exporting, setExporting] = useState(false)
  const downloadVault = async () => {
    if (exporting) return
    setExporting(true)
    setBusy("Preparing the zip…")
    try {
      const zip = await exportVault(api, vaultId)
      saveBlob(zip, `${(vaultName || "Vault").replace(/[\\/:*?"<>|]/g, "-")}.zip`)
    } catch (e) {
      toast(`Couldn't download the vault: ${await errorMessage(e)}`, "error")
    } finally {
      setExporting(false)
      setBusy(null)
    }
  }

  const newFolder = async (parent: string) => {
    const name = await dialogs.prompt({title: "New folder", label: parent ? `Folder name, inside ${parent}` : "Folder name", confirm: "Create"})
    const folder = name ? normalizeNotePath(joinPath(parent, name)).replace(/\.md$/i, "") : ""
    if (!folder) return
    if (folder.split("/").some((p) => badName(p))) return
    // Folders only exist through the notes in them, so start it with one.
    await newNote(folder)
  }

  // Opens empty if it isn't there yet; typing creates it.
  const openDaily = () => open(dailyPath(new Date(), paths))

  const [treeMenu, setTreeMenu] = useState<{item: TreeItem; anchor: MenuAnchor} | null>(null)
  const onTreeMenu = useCallback((item: TreeItem, anchor: MenuAnchor) => setTreeMenu({item, anchor}), [])
  const onTreeDrop = useCallback((item: TreeItem, folder: string) => void moveItemRef.current(item, folder), [])
  const moveItemRef = useRef(moveItem)
  moveItemRef.current = moveItem

  const itemMenu = (item: TreeItem): MenuItem[] => {
    if (item.kind === "folder") {
      return [
        {label: "New note", run: () => void newNote(item.path)},
        {label: "New folder", run: () => void newFolder(item.path)},
        {label: "Upload files here…", run: () => upload(item.path)},
        "separator",
        {label: "Rename…", run: () => void renameItem(item)},
        {label: "Move to…", run: () => void moveItem(item)},
        "separator",
        {label: "Delete folder", danger: true, run: () => void deleteItem(item)}
      ]
    }
    const p = item.path
    return [
      ...(p !== path ? [{label: "Open", run: () => open(p)}] : []),
      {label: "Rename…", run: () => void renameItem(item)},
      {label: "Move to…", run: () => void moveItem(item)},
      {label: "Duplicate", run: () => void duplicate(p)},
      ...(isTextFile(p) ? [{label: "New note in this folder", run: () => void newNote(dirname(p))}] : []),
      ...(isMarkdown(p) ? [{label: sharedPaths.has(p) ? "Shared…" : "Share…", run: () => setSharing(p)}] : []),
      "separator" as const,
      {label: isTextFile(p) ? "Delete note" : "Delete file", danger: true, run: () => void deleteItem(item)}
    ]
  }

  const vaultMenu: MenuItem[] = [
    {label: "New folder", run: () => void newFolder("")},
    {label: "Upload files…", run: () => upload("")},
    {label: "Recently deleted…", run: () => setDeletedOpen(true)},
    {label: "Download vault as zip", run: () => void downloadVault()},
    "separator",
    {label: "Switch vault", run: () => navigate("/vaults")},
    {label: `Sign out (${user.email})`, run: signOut}
  ]

  const [shares, setShares] = useState<Share[]>([])
  const [sharing, setSharing] = useState<string | null>(null)
  const sharedPaths = useMemo(() => new Set(shares.map((s) => s.path)), [shares])
  // Claude: asked again whenever the file list changes, since a rename or delete moves or ends a note's share.
  const pathsKey = paths.join("\n")
  useEffect(() => {
    api.share.query({condition: {vault: {Equal: vaultId}}, limit: 10000}).then(setShares, () => {})
  }, [api, vaultId, pathsKey])
  const onShareChange = (p: string, share: Share | null) =>
    setShares((list) => [...list.filter((s) => s.path !== p), ...(share ? [share] : [])])

  const [historyOpen, setHistoryOpen] = useState(false)
  const [deletedOpen, setDeletedOpen] = useState(false)
  useEffect(() => setHistoryOpen(false), [path])

  /** Puts an earlier copy back (an old version, or a deleted note). Returns whether it worked. */
  const restoreVersion = async (v: NoteVersionSummary): Promise<boolean> => {
    const name = isMarkdown(v.path) ? noteTitle(v.path) : basename(v.path)
    try {
      // Edits still on their way would make the restore a conflict.
      if (v.path === path) await sessionRef.current?.flush()
      const result = await api.note.restoreVersion({vault: vaultId, id: v.id, baseVersion: store.summary(v.path)?.version ?? null})
      if (!result.success || !result.note) {
        toast(`"${name}" changed just now, so it wasn't restored. Try again.`, "error")
        return false
      }
      store.noteSaved(result.note)
      if (!result.note.attachment) noteCache.put(result.note)
      // Brings the open note's editor up to date too.
      await store.poll()
      if (v.reason === "Delete") toast(`Restored "${name}".`, "info", v.path === path ? undefined : {label: "Open", run: () => open(v.path)})
      else toast(`Restored the version from ${when(v.modifiedAt).replace(/^(Today|Yesterday)/, (d) => d.toLowerCase())}. What it replaced is in the history too.`)
      return true
    } catch (e) {
      toast(`Couldn't restore "${name}": ${await errorMessage(e)}`, "error")
      return false
    }
  }

  const [menuAt, setMenuAt] = useState<{items: MenuItem[]; anchor: MenuAnchor} | null>(null)
  const closeMenus = useCallback(() => {
    setMenuAt(null)
    setTreeMenu(null)
  }, [])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === "o" || key === "p" || (key === "k" && !e.shiftKey)) {
        e.preventDefault()
        setSwitcher(true)
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault()
        void newNote(path ? dirname(path) : "")
      } else if (key === "e") {
        e.preventDefault()
        setMode((m) => (m === "edit" ? "read" : "edit"))
      } else if (key === "s") {
        e.preventDefault()
        void sessionRef.current?.flush()
      } else if (key === "\\") {
        e.preventDefault()
        setDesktopSidebar((s) => !s)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [newNote, path])

  // Warn before closing the tab while edits are still on their way (they're kept as a draft either way).
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving") {
        void sessionRef.current?.flush()
        e.preventDefault()
      }
    }
    window.addEventListener("beforeunload", onUnload)
    return () => window.removeEventListener("beforeunload", onUnload)
  }, [saveState])

  // Phones: save when the app is switched away from, since it may never come back to the foreground.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void sessionRef.current?.flush()
    }
    document.addEventListener("visibilitychange", onHide)
    return () => document.removeEventListener("visibilitychange", onHide)
  }, [])

  useEffect(() => {
    const name = path ? (isMarkdown(path) ? noteTitle(path) : basename(path)) : vaultName
    document.title = name ? `${name} · Notebarn` : "Notebarn"
    return () => {
      document.title = "Notebarn"
    }
  }, [path, vaultName])

  const status = busy
    ? {text: busy, tone: "busy", title: busy}
    : statusLabel(path && !isAttachment ? saveState : "saved", snapshot.connection)
  const noteCount = useMemo(() => paths.filter(isTextFile).length, [paths])
  const fileCount = paths.length - noteCount

  const pageMenu: MenuItem[] = path
    ? [
        ...(!isAttachment
          ? [{label: mode === "edit" ? "Reading view" : "Edit", hint: `${modKey} E`, run: () => setMode(mode === "edit" ? "read" : "edit")}]
          : []),
        {label: "Rename…", run: () => void renameItem({kind: "file", path})},
        {label: "Move to…", run: () => void moveItem({kind: "file", path})},
        {label: "Duplicate", run: () => void duplicate(path)},
        {label: "New note in this folder", run: () => void newNote(dirname(path))},
        {label: "Version history…", run: () => setHistoryOpen(true)},
        ...(isMarkdown(path) ? [{label: sharedPaths.has(path) ? "Shared…" : "Share…", run: () => setSharing(path)}] : []),
        "separator",
        {label: isAttachment ? "Delete file" : "Delete note", danger: true, run: () => void deleteItem({kind: "file", path})}
      ]
    : []

  return (
    <div className={desktopSidebar ? "app" : "app sidebar-collapsed"}>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
      <aside className={sidebarOpen ? "sidebar open" : "sidebar"} aria-label="Notes">
        <div className="sidebar-header">
          <Link to="/vaults" className="vault-name" title="Switch vault">
            {vaultName || "Vault"} <span aria-hidden>⇅</span>
          </Link>
          <button className="icon-button" title="Today's note" onClick={openDaily}>
            <IconCalendar />
          </button>
          <button className="icon-button" title={`New note (${modKey}+N)`} onClick={() => void newNote("")}>
            <IconNewNote />
          </button>
          <button
            className="icon-button"
            title="More"
            aria-haspopup="menu"
            onClick={(e) => setMenuAt({items: vaultMenu, anchor: e.currentTarget.getBoundingClientRect()})}
          >
            <IconDots />
          </button>
        </div>
        <button className="search-button" onClick={() => setSwitcher(true)}>
          <IconSearch /> Search <kbd>{modKey} O</kbd>
        </button>
        <nav className="sidebar-tree">
          {snapshot.loaded ? (
            <FileTree
              vault={vaultId}
              paths={paths}
              current={path}
              onOpen={open}
              onNewNote={(f) => void newNote(f)}
              onMenu={onTreeMenu}
              onDrop={onTreeDrop}
              shared={sharedPaths}
            />
          ) : (
            <p className="tree-empty">Loading…</p>
          )}
        </nav>
        <div className="sidebar-footer">
          <span className={`dot ${snapshot.connection}`} />
          <span className="footer-text" title={user.email}>
            {snapshot.connection === "offline"
              ? "Offline"
              : `${noteCount} ${noteCount === 1 ? "note" : "notes"}${fileCount ? `, ${fileCount} ${fileCount === 1 ? "file" : "files"}` : ""}`}
          </span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="icon-button mobile-only" title="Notes" onClick={() => setSidebarOpen(true)}>
            <IconMenu />
          </button>
          <button
            className="icon-button desktop-only"
            title={`Toggle sidebar (${modKey}+\\)`}
            onClick={() => setDesktopSidebar((s) => !s)}
          >
            <IconSidebar />
          </button>
          <div className="topbar-title">{path ? (isMarkdown(path) ? noteTitle(path) : basename(path)) : vaultName}</div>
          <span className={`save-status ${status.tone}`} title={status.title}>
            {status.text}
          </span>
          <button className="icon-button mobile-only" title="Search" onClick={() => setSwitcher(true)}>
            <IconSearch />
          </button>
          {path && (
            <>
              {!isAttachment && (
                <button
                  className="icon-button"
                  title={mode === "edit" ? `Reading view (${modKey}+E)` : `Edit (${modKey}+E)`}
                  onClick={() => setMode(mode === "edit" ? "read" : "edit")}
                >
                  {mode === "edit" ? <IconBook /> : <IconPencil />}
                </button>
              )}
              <button
                className="icon-button"
                title="More"
                aria-haspopup="menu"
                onClick={(e) => setMenuAt({items: pageMenu, anchor: e.currentTarget.getBoundingClientRect()})}
              >
                <IconDots />
              </button>
            </>
          )}
        </header>
        <div className="content">
          <AttachmentContext.Provider value={attachments}>
            {isAttachment ? (
              <AttachmentView key={path} path={path} />
            ) : path ? (
              <NoteView
                api={api}
                store={store}
                vault={vaultId}
                path={path}
                mode={mode}
                paths={paths}
                focusTitle={justCreated}
                onOpenLink={openLink}
                onOpen={open}
                onSaveState={setSaveState}
                onRename={rename}
                onMoved={(to) => navigate(notePath(vaultId, to), {replace: true})}
                sessionRef={sessionRef}
              />
            ) : (
              <Home
                recent={recent.filter((p) => paths.includes(p))}
                loaded={snapshot.loaded}
                onOpen={open}
                onNew={() => void newNote("")}
                onDaily={openDaily}
                onSearch={() => setSwitcher(true)}
              />
            )}
          </AttachmentContext.Provider>
        </div>
      </main>

      {menuAt && <PopupMenu anchor={menuAt.anchor} items={menuAt.items} onClose={closeMenus} />}
      {treeMenu && <PopupMenu anchor={treeMenu.anchor} items={itemMenu(treeMenu.item)} onClose={closeMenus} />}
      <input
        ref={uploader}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ""
          if (files.length) void uploadFiles(files)
        }}
      />

      {historyOpen && path && (
        <VersionHistory
          api={api}
          vault={vaultId}
          path={path}
          current={sessionRef.current?.text ?? ""}
          onRestore={restoreVersion}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {sharing && (
        <ShareDialog
          api={api}
          vault={vaultId}
          path={sharing}
          share={shares.find((s) => s.path === sharing) ?? null}
          onChange={(share) => onShareChange(sharing, share)}
          onClose={() => setSharing(null)}
        />
      )}
      {deletedOpen && <RecentlyDeleted api={api} vault={vaultId} onRestore={restoreVersion} onClose={() => setDeletedOpen(false)} />}

      {switcher && (
        <QuickSwitcher
          api={api}
          vault={vaultId}
          paths={paths}
          recent={recent}
          onOpen={open}
          onCreate={(p) => void createAt(p)}
          onClose={() => setSwitcher(false)}
        />
      )}
    </div>
  )
}

function statusLabel(save: SaveState, connection: string): {text: string; tone: string; title: string} {
  switch (save) {
    case "dirty":
    case "saving":
      return {text: "Saving…", tone: "busy", title: "Saving your changes"}
    case "offline":
      return {text: "Offline", tone: "warn", title: "Your changes are kept on this device and saved when you're back online"}
    case "error":
      return {text: "Not saved", tone: "error", title: "The server refused the last save. Edit again to retry."}
    case "deleted":
      return {text: "Deleted", tone: "warn", title: "Deleted on another device"}
  }
  if (connection === "offline") return {text: "Offline", tone: "warn", title: "Can't reach the server"}
  return {text: "Saved", tone: "ok", title: "Everything is saved"}
}

function Home(props: {recent: string[]; loaded: boolean; onOpen(p: string): void; onNew(): void; onDaily(): void; onSearch(): void}) {
  return (
    <div className="home">
      <div className="home-actions">
        <button className="button primary" onClick={props.onNew}>
          New note
        </button>
        <button className="button" onClick={props.onDaily}>
          Today's note
        </button>
        <button className="button" onClick={props.onSearch}>
          Find a note
        </button>
      </div>
      {props.recent.length > 0 && (
        <>
          <h3>Recent</h3>
          <ul className="recent-list">
            {props.recent.slice(0, 15).map((p) => (
              <li key={p}>
                <button onClick={() => props.onOpen(p)}>
                  <span className="recent-title">{noteTitle(p)}</span>
                  {dirname(p) && <span className="recent-folder">{dirname(p)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {props.loaded && props.recent.length === 0 && <p className="hint">Open a note from the sidebar, or make a new one.</p>}
    </div>
  )
}

// Icons: simple strokes in the style of Lucide, inline so they work offline.
const Svg = ({children}: {children: React.ReactNode}) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
)
const IconMenu = () => (
  <Svg>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
)
const IconSidebar = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
)
const IconSearch = () => (
  <Svg>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
)
const IconNewNote = () => (
  <Svg>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6M12 12v6M9 15h6" />
  </Svg>
)
const IconCalendar = () => (
  <Svg>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M16 3v4M8 3v4M3 10h18" />
  </Svg>
)
const IconBook = () => (
  <Svg>
    <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
  </Svg>
)
const IconPencil = () => (
  <Svg>
    <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  </Svg>
)
const IconDots = () => (
  <Svg>
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="19" r="1" />
  </Svg>
)

