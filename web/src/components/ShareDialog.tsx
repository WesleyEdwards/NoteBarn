import {useState} from "react"
import type {Api, Share, Vault} from "@notebarn/shared/api"
import {noteTitle} from "@notebarn/shared/paths"
import {errorMessage} from "../api/client"
import {useToast} from "./Toast"

export const shareLink = (share: Share) => `${window.location.origin}/s/${share._id}`

/** Makes a link anyone can read a note through, shows it, and turns it off ("Stop sharing"). */
export function ShareDialog(props: {
  api: Api
  vault: Vault.ID
  path: string
  /** The note's current link, if it's shared. */
  share: Share | null
  onChange(share: Share | null): void
  onClose(): void
}) {
  const {api, vault, path, share, onChange, onClose} = props
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const copy = async (s: Share) => {
    try {
      await navigator.clipboard.writeText(shareLink(s))
      toast("Link copied.")
    } catch {
      // Claude: clipboard access can be refused; the link is still there to select by hand.
    }
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast(await errorMessage(e), "error")
    } finally {
      setBusy(false)
    }
  }

  const create = () =>
    run(async () => {
      const s = await api.share.shareNote({vault, path})
      onChange(s)
      await copy(s)
    })

  const stop = () =>
    run(async () => {
      await api.share.stopSharing({vault, path})
      onChange(null)
      toast("The link doesn't work anymore.")
      onClose()
    })

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Share" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>Share "{noteTitle(path)}"</h2>
        {share ? (
          <>
            <p>Anyone with this link can read the note and the files it shows, as they are when they open it.</p>
            <div className="share-link">
              <input readOnly value={shareLink(share)} onFocus={(e) => e.currentTarget.select()} aria-label="Link" />
              <button type="button" className="button" onClick={() => void copy(share)}>
                Copy
              </button>
            </div>
            <div className="modal-actions">
              <button type="button" className="button danger" disabled={busy} onClick={() => void stop()}>
                Stop sharing
              </button>
              <button type="button" className="button primary" onClick={onClose} autoFocus>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Anyone with the link will be able to read this note, including changes you make later. They can't edit it
              or see your other notes.
            </p>
            <div className="modal-actions">
              <button type="button" className="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={() => void create()} autoFocus>
                Create link
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
