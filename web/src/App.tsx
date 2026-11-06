import {Navigate, Route, Routes} from "react-router-dom"
import {useSession} from "./api/client"
import {LoginPage} from "./components/LoginPage"
import {VaultList} from "./components/VaultList"
import {Workspace} from "./components/Workspace"

export default function App() {
  const session = useSession()

  if (session.state === "loading") return <div className="splash" aria-busy="true" />

  if (session.state === "signed-out") {
    return <LoginPage api={session.api} onSignedIn={session.signIn} />
  }

  const {api, user, signOut, accessToken} = session
  return (
    <Routes>
      <Route path="/" element={<VaultList api={api} user={user} signOut={signOut} pick={false} />} />
      <Route path="/vaults" element={<VaultList api={api} user={user} signOut={signOut} pick={true} />} />
      {/* One route for the vault and its notes, so opening a note doesn't remount the workspace. */}
      <Route path="/v/:vaultId/*" element={<Workspace api={api} user={user} signOut={signOut} accessToken={accessToken} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
