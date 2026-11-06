const PRODUCTION = "https://api.notebarn.a.wesleyedwards.xyz"

/** Where the server is. The Vite dev server proxies /api to a local server; a built app talks to the deployed one. */
export const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? (import.meta.env.DEV ? "/api" : PRODUCTION)

/**
 * Where its websockets are. The deployed server takes them on their own API Gateway domain; anywhere else (a local
 * server, or Vite's /api proxy) takes them at the same address as everything else.
 */
export const WEBSOCKET_URL: string =
  import.meta.env.VITE_WEBSOCKET_URL ??
  (BACKEND_URL === PRODUCTION
    ? "wss://ws.api.notebarn.a.wesleyedwards.xyz"
    : (() => {
        const url = new URL(BACKEND_URL, window.location.href)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        return url.toString().replace(/\/$/, "")
      })())

/** The Live Changes websocket for a vault, authenticated with an access token. */
export const liveChangesUrl = (vault: string, accessToken: string) =>
  `${WEBSOCKET_URL}/?path=${encodeURIComponent("/note/live")}&vault=${encodeURIComponent(vault)}&jwt=${encodeURIComponent(accessToken)}`
