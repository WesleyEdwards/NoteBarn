// Claude: Lambda@Edge (origin-response) that gives share links (/s/<id>) the note's title and opening text, so link
// previews in chat apps show them. Lambda@Edge can't have environment variables, hence the hardcoded addresses.
const SITE = "https://notebarn.a.wesleyedwards.xyz"
const API = "https://api.notebarn.a.wesleyedwards.xyz"

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c])

const describe = (markdown) =>
  markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/[#*_`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)

const page = (html, cacheControl) => ({
  status: "200",
  statusDescription: "OK",
  headers: {
    "content-type": [{key: "Content-Type", value: "text/html; charset=utf-8"}],
    "cache-control": [{key: "Cache-Control", value: cacheControl}]
  },
  body: html
})

export const handler = async (event) => {
  const {request, response} = event.Records[0].cf
  const id = request.uri.match(/^\/s\/([^/]+)\/?$/)?.[1]
  if (!id) return response

  // Claude: S3 has no file at /s/<id>, so this response is its 404; serve the app's page instead.
  let html
  try {
    const res = await fetch(`${SITE}/index.html`, {signal: AbortSignal.timeout(2000)})
    if (!res.ok) return response
    html = await res.text()
  } catch {
    return response
  }

  let note
  try {
    // Claude: the API's Lambda can be slow to wake up; better a plain page than a timed-out one.
    const res = await fetch(`${API}/share/view`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(decodeURIComponent(id)),
      signal: AbortSignal.timeout(2500)
    })
    if (!res.ok) return page(html, "no-cache")
    note = await res.json()
  } catch {
    return page(html, "no-cache")
  }

  const title = escape(note.title)
  const description = escape(describe(note.content))
  const tags = [
    `<title>${title} · Notebarn</title>`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Notebarn" />`,
    `<meta property="og:url" content="${SITE}/s/${escape(id)}" />`,
    `<meta property="og:image" content="${SITE}/icon-512.png" />`,
    `<meta name="twitter:card" content="summary" />`
  ].join("\n    ")
  return page(html.replace("<title>Notebarn</title>", tags), "max-age=300")
}
