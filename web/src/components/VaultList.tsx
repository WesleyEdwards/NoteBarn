import {useEffect, useState} from "react"
import {Navigate, useNavigate} from "react-router-dom"
import type {Api, User, Vault} from "@notebarn/shared/api"
import {errorMessage} from "../api/client"
import {storage} from "../lib/storage"
import {useDialogs} from "./Dialog"
import {PopupMenu, type MenuAnchor} from "./Menu"
import {useToast} from "./Toast"

/**
 * Chooses a vault. At `/` it goes straight to the last vault used (or the only one); `/vaults` always shows the list.
 */
export function VaultList({api, user, signOut, pick}: {api: Api; user: User; signOut(): void; pick: boolean}) {
  const navigate = useNavigate()
  const dialogs = useDialogs()
  const toast = useToast()
  const [vaults, setVaults] = useState<Vault[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{vault: Vault; anchor: MenuAnchor} | null>(null)
  const last = storage.get<string | null>("last-vault", null)

  useEffect(() => {
    if (!pick && last) return
    api.vault
      .query({condition: {Always: true}, orderBy: ["name"], limit: 1000})
      .then(setVaults)
      .catch(async (e) => setError(await errorMessage(e)))
  }, [api])

  if (!pick && last) return <Navigate to={`/v/${last}`} replace />
  if (!pick && vaults?.length === 1) return <Navigate to={`/v/${vaults[0]._id}`} replace />

  const create = async () => {
    const name = await dialogs.prompt({title: "New vault", label: "Name", initial: vaults?.length ? "" : "Notes", confirm: "Create"})
    if (!name?.trim()) return
    try {
      const vault = await api.vault.insert({
        _id: crypto.randomUUID() as Vault.ID,
        owner: user._id,
        name: name.trim(),
        createdAt: new Date().toISOString(),
        latestVersion: 0
      })
      navigate(`/v/${vault._id}`)
    } catch (e) {
      toast(`Couldn't create the vault: ${await errorMessage(e)}`, "error")
    }
  }

  const rename = async (vault: Vault) => {
    const name = (await dialogs.prompt({title: "Rename vault", label: "Name", initial: vault.name, confirm: "Rename"}))?.trim()
    if (!name || name === vault.name) return
    try {
      const updated = await api.vault.simplifiedModify(vault._id, {name})
      setVaults((all) => all?.map((v) => (v._id === vault._id ? updated : v)) ?? null)
      storage.set(`vault-name:${vault._id}`, updated.name)
    } catch (e) {
      toast(`Couldn't rename the vault: ${await errorMessage(e)}`, "error")
    }
  }

  const remove = async (vault: Vault) => {
    const typed = await dialogs.prompt({
      title: `Delete "${vault.name}"?`,
      label: "This deletes every note and file in it, on every device, and can't be undone. Type the vault's name to confirm.",
      confirm: "Delete vault"
    })
    if (typed === null) return
    if (typed.trim() !== vault.name) {
      toast("The name didn't match, so nothing was deleted.", "error")
      return
    }
    try {
      await api.vault.delete(vault._id)
      setVaults((all) => all?.filter((v) => v._id !== vault._id) ?? null)
      if (storage.get<string | null>("last-vault", null) === vault._id) storage.remove("last-vault")
      storage.remove(`vault-cache:${vault._id}`)
      storage.remove(`vault-name:${vault._id}`)
      toast(`Deleted "${vault.name}".`)
    } catch (e) {
      toast(`Couldn't delete the vault: ${await errorMessage(e)}`, "error")
    }
  }

  return (
    <div className="vaults">
      <div className="vaults-card">
        <h1>Vaults</h1>
        <p className="hint">Like Obsidian vaults: each is its own set of notes.</p>
        {error && <p className="form-error">{error}</p>}
        {vaults === null && !error && <p className="hint">Loading…</p>}
        <ul className="vault-list">
          {vaults?.map((v) => (
            <li key={v._id} className={v._id === last ? "current" : undefined}>
              <button className="vault-open" onClick={() => navigate(`/v/${v._id}`)}>
                {v.name}
              </button>
              <button
                className="icon-button"
                title="More"
                aria-haspopup="menu"
                onClick={(e) => setMenu({vault: v, anchor: e.currentTarget.getBoundingClientRect()})}
              >
                ⋯
              </button>
            </li>
          ))}
        </ul>
        {menu && (
          <PopupMenu
            anchor={menu.anchor}
            onClose={() => setMenu(null)}
            items={[
              {label: "Open", run: () => navigate(`/v/${menu.vault._id}`)},
              {label: "Rename…", run: () => void rename(menu.vault)},
              "separator",
              {label: "Delete vault…", danger: true, run: () => void remove(menu.vault)}
            ]}
          />
        )}
        <button className="button primary" onClick={() => void create()}>
          New vault
        </button>
        <p className="vaults-footer">
          Signed in as {user.email} ·{" "}
          <button className="link-button" onClick={signOut}>
            Sign out
          </button>
        </p>
      </div>
    </div>
  )
}
