/** Helpers for vault paths like `Folder/Sub/My note.md`. Paths never start or end with a slash. */

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

export const dirname = (path: string) => {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

export const isMarkdown = (path: string) => /\.md$/i.test(path)

/** Files synced as text, which can be merged. Everything else is an attachment, synced as bytes. */
export const isTextFile = (path: string) => /\.(md|canvas)$/i.test(path)

const MIME_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", avif: "image/avif", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
  ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", md: "text/markdown",
  canvas: "application/json", txt: "text/plain", json: "application/json"
}

/** The media type for a file, by its extension. */
export const mimeType = (path: string) =>
  MIME_TYPES[/\.([^./]+)$/.exec(path)?.[1].toLowerCase() ?? ""] ?? "application/octet-stream"

/** Attachments that can be shown as an image. */
export const isImage = (path: string) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path)

export const stripMd = (name: string) => name.replace(/\.md$/i, "")

/** What a note is called in the app: its file name without `.md`. */
export const noteTitle = (path: string) => stripMd(basename(path))

/** Cleans up what someone typed as a path: slashes, spaces around parts, and `.md` on the end. */
export function normalizeNotePath(raw: string): string {
  const parts = raw
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== "." && p !== "..")
  if (parts.length === 0) return ""
  const path = parts.join("/")
  return isMarkdown(path) ? path : `${path}.md`
}

/** Characters Obsidian won't allow in a file name, since they break links or some file systems. */
export const INVALID_NAME_CHARS = /[\\/:*?"<>|#^[\]]/

/** A `[[link]]` split into its parts: `[[target#heading|alias]]`. */
export interface Wikilink {
  target: string
  heading?: string
  alias?: string
}

export function parseWikilink(inner: string): Wikilink {
  const [beforeAlias, ...aliasParts] = inner.split("|")
  const alias = aliasParts.length ? aliasParts.join("|").trim() : undefined
  const hashAt = beforeAlias.indexOf("#")
  const target = (hashAt < 0 ? beforeAlias : beforeAlias.slice(0, hashAt)).trim()
  const heading = hashAt < 0 ? undefined : beforeAlias.slice(hashAt + 1).trim() || undefined
  return {target, heading, alias: alias || undefined}
}

/**
 * Finds the note a `[[target]]` in `fromPath` points to, the way Obsidian does: an exact path from the vault root, then
 * a path relative to the note's folder, then any note with that name (closest to the linking note first, then the
 * shortest path). Ignores case. Returns null if no note matches.
 */
export function resolveWikilink(target: string, fromPath: string, paths: readonly string[]): string | null {
  const t = target.trim().replace(/^\/+/, "")
  if (!t) return fromPath
  const lower = new Map<string, string>()
  for (const p of paths) lower.set(p.toLowerCase(), p)
  const tryPath = (p: string) => lower.get(p.toLowerCase()) ?? lower.get(`${p}.md`.toLowerCase()) ?? null

  const exact = tryPath(t)
  if (exact) return exact
  const relative = tryPath(joinPath(dirname(fromPath), t))
  if (relative) return relative

  const wanted = t.toLowerCase()
  const matches = paths.filter((p) => {
    const lp = p.toLowerCase()
    return lp.endsWith(`/${wanted}`) || lp.endsWith(`/${wanted}.md`)
  })
  if (matches.length === 0) return null
  const fromFolder = dirname(fromPath)
  return [...matches].sort((a, b) => {
    const aNear = dirname(a) === fromFolder ? 0 : 1
    const bNear = dirname(b) === fromFolder ? 0 : 1
    return aNear - bNear || a.length - b.length || a.localeCompare(b)
  })[0]
}

/**
 * The shortest text that links to `path` from anywhere: just the title when no other note has the same name,
 * otherwise the full path without `.md`.
 */
export function linkTextFor(path: string, paths: readonly string[]): string {
  const title = noteTitle(path).toLowerCase()
  const sameName = paths.filter((p) => noteTitle(p).toLowerCase() === title)
  return sameName.length <= 1 ? noteTitle(path) : stripMd(path)
}

/** Where to keep my copy of a note when it can't be merged with someone else's edit, like Obsidian Sync does. */
export function conflictPath(path: string, at: Date, taken: readonly string[] = []): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`
  const folder = dirname(path)
  // Keeps the extension, so the copy opens the same way: `Photo (conflict …).png`.
  const ext = /\.[^.]+$/.exec(basename(path))?.[0] ?? ""
  const name = basename(path).slice(0, basename(path).length - ext.length)
  const takenLower = new Set(taken.map((p) => p.toLowerCase()))
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${n}`
    const candidate = joinPath(folder, `${name} (conflict ${stamp}${suffix})${ext}`)
    if (!takenLower.has(candidate.toLowerCase())) return candidate
  }
}

/** `name` in `folder`, or `name 1`, `name 2`... (before the extension) if that's taken. Ignores case. */
export function availablePath(folder: string, name: string, taken: readonly string[]): string {
  const takenLower = new Set(taken.map((p) => p.toLowerCase()))
  const ext = /\.[^.]+$/.exec(name)?.[0] ?? ""
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 0; ; n++) {
    const candidate = joinPath(folder, n === 0 ? name : `${stem} ${n}${ext}`)
    if (!takenLower.has(candidate.toLowerCase())) return candidate
  }
}

/** What Obsidian calls a pasted image: `Pasted image 20261104103000.png`. */
export function pastedImageName(at: Date, ext: string): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `Pasted image ${stamp}.${ext}`
}

/** A path for a new note in `folder` that isn't taken: `Untitled.md`, `Untitled 1.md`, ... */
export function untitledPath(folder: string, taken: readonly string[], base = "Untitled"): string {
  const takenLower = new Set(taken.map((p) => p.toLowerCase()))
  for (let n = 0; ; n++) {
    const candidate = joinPath(folder, `${base}${n === 0 ? "" : ` ${n}`}.md`)
    if (!takenLower.has(candidate.toLowerCase())) return candidate
  }
}

export interface FolderNode {
  name: string
  path: string
  folders: FolderNode[]
  files: string[]
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, {sensitivity: "base", numeric: true})

/** Folders and files for the sidebar, folders first, each sorted by name. */
export function buildTree(paths: readonly string[]): FolderNode {
  const root: FolderNode = {name: "", path: "", folders: [], files: []}
  const folders = new Map<string, FolderNode>([["", root]])
  const folderFor = (path: string): FolderNode => {
    const existing = folders.get(path)
    if (existing) return existing
    const parent = folderFor(dirname(path))
    const node: FolderNode = {name: basename(path), path, folders: [], files: []}
    parent.folders.push(node)
    folders.set(path, node)
    return node
  }
  for (const p of paths) folderFor(dirname(p)).files.push(p)
  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => byName(a.name, b.name))
    node.files.sort((a, b) => byName(basename(a), basename(b)))
    node.folders.forEach(sort)
  }
  sort(root)
  return root
}
