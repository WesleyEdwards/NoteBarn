/** SHA-256 of the text's UTF-8 bytes in hex: the same as the server's `Note.hash`. */
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text))
}

/** SHA-256 of some bytes in hex: an attachment's `Note.hash`. */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
