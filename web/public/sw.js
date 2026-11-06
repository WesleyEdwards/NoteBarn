// Keeps the app itself (HTML, scripts, styles, icons) on the device so it opens without a connection.
// Notes aren't cached here: the app keeps those itself (recent notes and unsaved drafts in localStorage).
const CACHE = "notebarn-shell-v1"

self.addEventListener("install", () => self.skipWaiting())

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return

  if (request.mode === "navigate") {
    // The page: always try for the newest version, fall back to the saved one offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE).then((c) => c.put("/", copy))
          return response
        })
        .catch(() => caches.match("/").then((r) => r || Response.error()))
    )
    return
  }

  // Built files have their content hash in the name, so a saved copy is always right.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE).then((c) => c.put(request, copy))
          }
          return response
        })
    )
  )
})
