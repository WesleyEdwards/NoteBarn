/** The server answered with an error status. (A request that never got an answer throws something else.) */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "HttpError"
  }
}

/**
 * Whether an error means the server refused the request, as opposed to it never arriving (offline). The web app's
 * fetcher throws the Response itself; other clients throw HttpError.
 */
export function isServerRejection(e: unknown): boolean {
  if (e instanceof HttpError) return true
  return typeof Response !== "undefined" && e instanceof Response
}
