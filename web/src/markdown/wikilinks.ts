import {parseWikilink} from "@notebarn/shared/paths"

/** Links made from `[[...]]` use this scheme, so the renderer can tell them from ordinary links. */
export const WIKILINK_PREFIX = "wikilink:"
export const EMBED_PREFIX = "embed:"

const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g

// A minimal mdast shape: enough to walk the tree without depending on @types/mdast.
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

/** Splits one text node's value into text and link nodes. */
export function splitWikilinks(value: string): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  for (const m of value.matchAll(WIKILINK)) {
    const at = m.index ?? 0
    if (at > last) out.push({type: "text", value: value.slice(last, at)})
    const embed = m[1] === "!"
    const link = parseWikilink(m[2])
    const label = link.alias ?? (link.target ? link.target + (link.heading ? ` > ${link.heading}` : "") : (link.heading ?? ""))
    const target = link.target + (link.heading ? `#${link.heading}` : "")
    // An embed's alias is its size (`![[photo.png|300]]`), so it goes along.
    const url = embed && link.alias ? `${target}|${link.alias}` : target
    out.push({
      type: "link",
      url: (embed ? EMBED_PREFIX : WIKILINK_PREFIX) + encodeURIComponent(url),
      children: [{type: "text", value: label}]
    })
    last = at + m[0].length
  }
  if (last === 0) return [{type: "text", value}]
  if (last < value.length) out.push({type: "text", value: value.slice(last)})
  return out
}

function transform(node: MdNode) {
  if (!node.children) return
  // Code and existing links keep their text as it is.
  if (node.type === "link" || node.type === "linkReference") return
  const next: MdNode[] = []
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("[[")) next.push(...splitWikilinks(child.value))
    else {
      transform(child)
      next.push(child)
    }
  }
  node.children = next
}

/** A remark plugin turning Obsidian `[[links]]` and `![[embeds]]` into links the renderer handles. */
export function remarkWikilinks() {
  return (tree: MdNode) => transform(tree)
}

/** Splits YAML frontmatter (`---` ... `---` at the very top) from the rest of the note. */
export function splitFrontmatter(text: string): {frontmatter: string | null; body: string} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return {frontmatter: null, body: text}
  return {frontmatter: m[1], body: text.slice(m[0].length)}
}

/**
 * Turns the nth task checkbox (`- [ ]` / `- [x]`) in the markdown on or off, for ticking boxes while reading.
 * Returns the text unchanged if there's no such task.
 */
export function toggleTask(text: string, index: number): string {
  const TASK = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm
  let n = 0
  let inFence = false
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence
    if (inFence) continue
    TASK.lastIndex = 0
    const m = TASK.exec(lines[i])
    if (!m) continue
    if (n++ === index) {
      lines[i] = m[1] + (m[2] === " " ? "x" : " ") + m[3] + lines[i].slice(m[0].length)
      return lines.join("\n")
    }
  }
  return text
}
