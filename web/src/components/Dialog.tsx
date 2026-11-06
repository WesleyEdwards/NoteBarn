import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from "react"

type Request =
  | {
      kind: "prompt"
      title: string
      label?: string
      initial: string
      confirm: string
      suggestions?: readonly string[]
      resolve: (v: string | null) => void
    }
  | {kind: "confirm"; title: string; message: string; confirm: string; danger?: boolean; resolve: (v: boolean) => void}

interface Dialogs {
  /** Asks for some text. `suggestions` are offered as it's typed (like folder names). */
  prompt(options: {title: string; label?: string; initial?: string; confirm?: string; suggestions?: readonly string[]}): Promise<string | null>
  confirm(options: {title: string; message: string; confirm?: string; danger?: boolean}): Promise<boolean>
}

const DialogContext = createContext<Dialogs | null>(null)

export const useDialogs = () => {
  const d = useContext(DialogContext)
  if (!d) throw new Error("Not inside DialogProvider")
  return d
}

export function DialogProvider({children}: {children: ReactNode}) {
  const [request, setRequest] = useState<Request | null>(null)
  const prompt = useCallback<Dialogs["prompt"]>(
    (o) =>
      new Promise((resolve) =>
        setRequest({
          kind: "prompt",
          title: o.title,
          label: o.label,
          initial: o.initial ?? "",
          confirm: o.confirm ?? "OK",
          suggestions: o.suggestions,
          resolve
        })
      ),
    []
  )
  const confirm = useCallback<Dialogs["confirm"]>(
    (o) =>
      new Promise((resolve) =>
        setRequest({kind: "confirm", title: o.title, message: o.message, confirm: o.confirm ?? "OK", danger: o.danger, resolve})
      ),
    []
  )
  const close = () => setRequest(null)
  return (
    <DialogContext.Provider value={{prompt, confirm}}>
      {children}
      {request && <DialogView request={request} close={close} />}
    </DialogContext.Provider>
  )
}

function DialogView({request, close}: {request: Request; close: () => void}) {
  const [value, setValue] = useState(request.kind === "prompt" ? request.initial : "")
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    // Select the name without its extension, like renaming a file.
    const ext = /\.[a-z0-9]{1,8}$/i.exec(value)
    el.setSelectionRange(0, ext && ext.index > 0 ? ext.index : value.length)
  }, [])

  const cancel = () => {
    if (request.kind === "prompt") request.resolve(null)
    else request.resolve(false)
    close()
  }
  const submit = () => {
    if (request.kind === "prompt") request.resolve(value)
    else request.resolve(true)
    close()
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => e.key === "Escape" && cancel()}
      >
        <h2>{request.title}</h2>
        {request.kind === "prompt" ? (
          <label className="field">
            {request.label && <span>{request.label}</span>}
            <input
              ref={input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoCapitalize="sentences"
              list={request.suggestions?.length ? "dialog-suggestions" : undefined}
            />
            {request.suggestions?.length ? (
              <datalist id="dialog-suggestions">
                {request.suggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            ) : null}
          </label>
        ) : (
          <p>{request.message}</p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            className={request.kind === "confirm" && request.danger ? "button danger" : "button primary"}
            autoFocus={request.kind === "confirm"}
          >
            {request.confirm}
          </button>
        </div>
      </form>
    </div>
  )
}
