import {Navigate, Route, Routes, useMatch} from "react-router-dom"
import type {Share} from "@notebarn/shared/api"
import {useSession} from "./api/client"
import {AdminPage} from "./components/AdminPage"
import {useDialogs} from "./components/Dialog"
import {LoginPage} from "./components/LoginPage"
import {SharedPage} from "./components/SharedPage"
import {VaultList} from "./components/VaultList"
import {Workspace} from "./components/Workspace"
import {storage} from "./lib/storage"

export default function App() {
  const session = useSession()
  const dialogs = useDialogs()
  // Shared notes open for anyone, signed in or not.
  const shared = useMatch("/s/:shareId")
  if (shared) return <SharedPage id={shared.params.shareId as Share.ID} />

  if (session.state === "loading") return <div className="splash" aria-busy="true" />

  if (session.state === "signed-out") {
    return <LoginPage api={session.api} onSignedIn={session.signIn} />
  }

  const {api, user, accessToken} = session
  // Claude: Wipes the device so the next person can't read this account's notes. The automatic
  // sign-out on an expired session doesn't, so it can't silently drop unsynced drafts.
  const signOut = async () => {
    const drafts = storage.keys().filter((k) => k.startsWith("draft:")).length
    if (drafts > 0) {
      const ok = await dialogs.confirm({
        title: "Sign out?",
        message: `${drafts === 1 ? "1 note has" : `${drafts} notes have`} changes that haven't synced yet. Signing out deletes them from this device.`,
        confirm: "Sign out",
        danger: true
      })
      if (!ok) return
    }
    storage.clear()
    session.signOut()
  }
  return (
    <Routes>
      <Route path="/" element={<VaultList api={api} user={user} signOut={signOut} pick={false} />} />
      <Route path="/vaults" element={<VaultList api={api} user={user} signOut={signOut} pick={true} />} />
      {/* One route for the vault and its notes, so opening a note doesn't remount the workspace. */}
      <Route path="/v/:vaultId/*" element={<Workspace api={api} user={user} signOut={signOut} accessToken={accessToken} />} />
      <Route path="/admin" element={<AdminPage api={api} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
