import {basename, isMarkdown, linkTextFor, resolveWikilink, stripMd} from "./paths"

/** One link in a note: a `[[wikilink]]`/`![[embed]]`, or a markdown `[text](path)` to a file in the vault. */
export interface FoundLink {
  /** Where the link's target text is in the note (not the brackets around it), so it can be replaced. */
  from: number
  to: number
  /** The target as written, without any `#heading` or `|alias`. Already URL-decoded for markdown links. */
  target: string
  kind: "wiki" | "markdown"
}

/** Spans of code (fenced blocks and inline `code`), where `[[...]]` is just text. */
function codeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm
  for (const m of text.matchAll(fence)) spans.push([m.index, m.index + m[0].length])
  const inside = (at: number) => spans.some(([a, b]) => at >= a && at < b)
  for (const m of text.matchAll(/(`+)[^`\n][\s\S]*?\1/g)) {
    if (!inside(m.index)) spans.push([m.index, m.index + m[0].length])
  }
  return spans
}

/** Every link to something in the vault, outside code. Web links are left out. */
export function findLinks(text: string): FoundLink[] {
  const code = codeSpans(text)
  const inCode = (at: number) => code.some(([a, b]) => at >= a && at < b)
  const out: FoundLink[] = []

  for (const m of text.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)) {
    if (inCode(m.index)) continue
    const inner = m[1]
    const start = m.index + m[0].indexOf("[[") + 2
    const cut = inner.search(/[#|]/)
    const raw = cut < 0 ? inner : inner.slice(0, cut)
    const target = raw.trim()
    if (!target) continue
    const lead = raw.length - raw.trimStart().length
    out.push({from: start + lead, to: start + lead + target.length, target, kind: "wiki"})
  }

  for (const m of text.matchAll(/(!?\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^)\s]+)[^)\n]*\)/g)) {
    if (inCode(m.index)) continue
    let raw = m[2]
    let from = m.index + m[1].length
    if (raw.startsWith("<")) {
      raw = raw.slice(1, -1)
      from++
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue
    const path = raw.split("#")[0]
    let target = path
    try {
      target = decodeURI(path)
    } catch {
      // Not encoded.
    }
    out.push({from, to: from + path.length, target, kind: "markdown"})
  }
  return out.sort((a, b) => a.from - b.from)
}

/** Whether the note at `notePath` (with `text`) links to `target`. */
export function linksTo(text: string, notePath: string, target: string, paths: readonly string[]): boolean {
  return findLinks(text).some((l) => resolveWikilink(l.target, notePath, paths) === target)
}

/** The lines of `text` that link to `target`, trimmed, for showing where a backlink comes from. */
export function linkingLines(text: string, notePath: string, target: string, paths: readonly string[]): string[] {
  const lines = new Set<string>()
  for (const l of findLinks(text)) {
    if (resolveWikilink(l.target, notePath, paths) !== target) continue
    const start = text.lastIndexOf("\n", l.from - 1) + 1
    const end = text.indexOf("\n", l.to)
    lines.add(text.slice(start, end < 0 ? text.length : end).trim())
  }
  return [...lines]
}

/** The shortest `[[link]]` text for any file: like linkTextFor, but other files keep their extension. */
export function wikiTargetFor(path: string, paths: readonly string[]): string {
  if (isMarkdown(path)) return linkTextFor(path, paths)
  const name = basename(path).toLowerCase()
  return paths.filter((p) => basename(p).toLowerCase() === name).length <= 1 ? basename(path) : path
}

/**
 * Points links in a note at files' new paths, after they were moved: `moves` maps each old path to its new one.
 * `notePath` is where the note itself was before the move (for links relative to it). Links keep their `#heading`
 * and `|alias`. Returns the text unchanged when nothing in it pointed at a moved file.
 */
export function rewriteLinks(
  text: string,
  notePath: string,
  moves: ReadonlyMap<string, string>,
  pathsBefore: readonly string[],
  pathsAfter: readonly string[]
): string {
  let out = ""
  let last = 0
  for (const link of findLinks(text)) {
    const old = resolveWikilink(link.target, notePath, pathsBefore)
    const moved = old === null ? undefined : moves.get(old)
    if (!moved) continue
    let replacement: string
    if (link.kind === "wiki") {
      replacement = wikiTargetFor(moved, pathsAfter)
      // Leave a link alone if it still reaches the file as written (say, by name after a folder move).
      if (resolveWikilink(link.target, notePath, pathsAfter) === moved) continue
      if (stripMd(replacement).toLowerCase() === stripMd(link.target).toLowerCase()) continue
    } else {
      const written = text.slice(link.from, link.to)
      replacement = written.includes("%") || !/\s/.test(written) ? encodeURI(moved) : moved
    }
    out += text.slice(last, link.from) + replacement
    last = link.to
  }
  return last === 0 ? text : out + text.slice(last)
}
