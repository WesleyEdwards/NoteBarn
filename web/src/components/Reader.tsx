import {memo, useRef, type MouseEvent} from "react"
import Markdown, {defaultUrlTransform, type Components} from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import {EMBED_PREFIX, WIKILINK_PREFIX, remarkWikilinks, splitFrontmatter, toggleTask} from "../markdown/wikilinks"
import {isNoteLink, parseWikilink, resolveWikilink} from "@notebarn/shared/paths"
import {AttachmentEmbed} from "./Attachment"

interface ReaderProps {
  text: string
  path: string
  paths: readonly string[]
  /** Without it, links to other notes are plain text (on a shared note, say). */
  onOpenLink?(target: string): void
  /** Ticking a checkbox edits the note. Without it, checkboxes can't be ticked. */
  onChangeText?(text: string): void
}

const remarkPlugins = [remarkGfm, remarkBreaks, remarkWikilinks]

const urlTransform = (url: string) =>
  url.startsWith(WIKILINK_PREFIX) || url.startsWith(EMBED_PREFIX) ? url : defaultUrlTransform(url)

export const Reader = memo(function Reader({text, path, paths, onOpenLink, onChangeText}: ReaderProps) {
  const container = useRef<HTMLDivElement>(null)
  const {frontmatter, body} = splitFrontmatter(text)

  const components: Components = {
    a({href, children}) {
      if (href?.startsWith(WIKILINK_PREFIX)) {
        if (!onOpenLink) return <span className="internal-link plain">{children}</span>
        const target = decodeURIComponent(href.slice(WIKILINK_PREFIX.length))
        const exists = resolveWikilink(parseWikilink(target).target, path, paths) !== null
        return (
          <a
            href="#"
            className={exists ? "internal-link" : "internal-link missing"}
            title={exists ? undefined : "Doesn't exist yet. Open it to create it."}
            onClick={(e) => {
              e.preventDefault()
              onOpenLink(target)
            }}
          >
            {children}
          </a>
        )
      }
      if (href?.startsWith(EMBED_PREFIX)) {
        const target = decodeURIComponent(href.slice(EMBED_PREFIX.length))
        const link = parseWikilink(target)
        const name = link.target
        const note = isNoteLink(name)
        if (note && !onOpenLink) return <span className="embed-link plain">↪ {children}</span>
        return note ? (
          <a
            href="#"
            className="embed-link"
            onClick={(e) => {
              e.preventDefault()
              onOpenLink?.(target)
            }}
          >
            ↪ {children}
          </a>
        ) : (
          <AttachmentEmbed path={resolveWikilink(name, path, paths)} name={name} size={link.alias} />
        )
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    },
    // Markdown images, `![alt](img/photo.png)`: a path in the vault, unless it's a web address.
    img({src, alt}) {
      if (typeof src !== "string" || /^(https?:|data:)/i.test(src)) return <img src={src} alt={alt} />
      let name = src
      try {
        name = decodeURI(src)
      } catch {
        // Not encoded.
      }
      return <AttachmentEmbed path={resolveWikilink(name, path, paths)} name={name} size={/^\d+(x\d+)?$/.test(alt ?? "") ? alt : undefined} />
    },
    input({type, checked}) {
      if (type !== "checkbox") return <input type={type} />
      return <input type="checkbox" checked={!!checked} readOnly className="task-checkbox" />
    }
  }

  // Checkboxes are counted in page order, which is the order toggleTask counts tasks in the text.
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return
    e.preventDefault()
    if (!onChangeText) return
    const boxes = [...(container.current?.querySelectorAll("input.task-checkbox") ?? [])]
    const index = boxes.indexOf(target)
    if (index < 0) return
    const offset = text.length - body.length
    onChangeText(text.slice(0, offset) + toggleTask(body, index))
  }

  return (
    <div className="reader markdown" ref={container} onClick={onClick}>
      {frontmatter !== null && <pre className="frontmatter">{frontmatter}</pre>}
      {body.trim() ? (
        <Markdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>
          {body}
        </Markdown>
      ) : (
        <p className="empty-note">This note is empty.</p>
      )}
    </div>
  )
})
