import {basename, isImage} from "@notebarn/shared/paths"
import {useAttachmentUrl, useAttachments} from "../sync/attachments"

const kindOf = (path: string) => {
  if (isImage(path)) return "image"
  if (/\.pdf$/i.test(path)) return "pdf"
  if (/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(path)) return "audio"
  if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(path)) return "video"
  return "file"
}

/**
 * An attachment shown inside a note, for `![[photo.png]]` (or `![[photo.png|300]]`, 300 pixels wide). `path` is
 * null when no file matches the link.
 */
export function AttachmentEmbed({path, name, size}: {path: string | null; name: string; size?: string}) {
  const attachments = useAttachments()
  const hash = path ? (attachments?.hashOf(path) ?? null) : null
  const {url, failed} = useAttachmentUrl(hash)

  if (!path || !hash) {
    return (
      <span className="embed-missing" title="No file with this name">
        📎 {name}
      </span>
    )
  }
  if (failed) {
    return (
      <span className="embed-missing" title="Couldn't load it. Are you offline?">
        📎 {basename(path)}
      </span>
    )
  }
  if (!url) return <span className="embed-loading">{basename(path)}</span>

  const [w, h] = (size ?? "").split("x").map((n) => (/^\d+$/.test(n) ? Number(n) : undefined))
  switch (kindOf(path)) {
    case "image":
      return <img className="embed-image" src={url} alt={basename(path)} width={w} height={h} loading="lazy" />
    case "pdf":
      return <iframe className="embed-pdf" src={url} title={basename(path)} />
    case "audio":
      return <audio className="embed-audio" src={url} controls preload="metadata" />
    case "video":
      return <video className="embed-video" src={url} controls preload="metadata" width={w} />
    default:
      return (
        <a className="embed-file" href={url} download={basename(path)} target="_blank" rel="noreferrer">
          📎 {basename(path)}
        </a>
      )
  }
}

/** An attachment opened on its own, from the file list or a link. */
export function AttachmentView({path}: {path: string}) {
  const attachments = useAttachments()
  const hash = attachments?.hashOf(path) ?? null
  const {url, failed} = useAttachmentUrl(hash)

  if (!hash) return <p className="note-error">There's no file at {path}.</p>
  if (failed) return <p className="note-error">Couldn't load {basename(path)}. Check your connection.</p>
  if (!url) return <div className="note-loading" aria-busy="true" />

  const kind = kindOf(path)
  return (
    <article className="attachment-view">
      <div className="attachment-body">
        {kind === "image" && <img src={url} alt={basename(path)} />}
        {kind === "pdf" && <iframe src={url} title={basename(path)} />}
        {kind === "audio" && <audio src={url} controls />}
        {kind === "video" && <video src={url} controls />}
        {kind === "file" && <p className="hint">This kind of file can't be shown here.</p>}
      </div>
      <a className="button" href={url} download={basename(path)} target="_blank" rel="noreferrer">
        Download
      </a>
    </article>
  )
}
