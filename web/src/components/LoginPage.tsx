import {useState} from "react"
import type {Api} from "@notebarn/shared/api"
import {errorMessage} from "../api/client"

export function LoginPage({api, onSignedIn}: {api: Api; onSignedIn(sessionToken: string): void}) {
  const [email, setEmail] = useState("")
  const [key, setKey] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendCode = async () => {
    setBusy(true)
    setError(null)
    try {
      setKey(await api.userAuth.beginEmailOwnershipProof(email.trim()))
    } catch (e) {
      setError(await errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    if (!key) return
    setBusy(true)
    setError(null)
    try {
      const proof = await api.userAuth.proveEmailOwnership({key, password: code.trim()})
      const result = await api.userAuth.logIn([proof])
      if (!result.session) throw new Error("The server didn't start a session.")
      onSignedIn(result.session)
    } catch (e) {
      setError(e instanceof Response && e.status === 400 ? "That code didn't work. Check it and try again." : await errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault()
          void (key ? verify() : sendCode())
        }}
      >
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Notebarn</h1>
        {!key ? (
          <>
            <p>Sign in with your email. We'll send you a code.</p>
            <input
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
            <button className="button primary" disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </>
        ) : (
          <>
            <p>Enter the code sent to {email.trim()}.</p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
            />
            <button className="button primary" disabled={busy || !code.trim()}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setKey(null)
                setCode("")
                setError(null)
              }}
            >
              Use a different email
            </button>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </form>
    </div>
  )
}
