import {createContext, useCallback, useContext, useRef, useState, type ReactNode} from "react"

type Tone = "info" | "error"
/** A button on the toast, like "Undo". */
export interface ToastAction {
  label: string
  run(): void
}
type Toast = {id: number; message: string; tone: Tone; action?: ToastAction}
type Show = (message: string, tone?: Tone, action?: ToastAction) => void
const ToastContext = createContext<Show>(() => {})

export const useToast = () => useContext(ToastContext)

export function ToastProvider({children}: {children: ReactNode}) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(0)
  const showing = useRef<Toast[]>([])
  const update = (f: (t: Toast[]) => Toast[]) => {
    showing.current = f(showing.current)
    setToasts(showing.current)
  }
  const dismiss = (id: number) => update((all) => all.filter((x) => x.id !== id))
  const show = useCallback<Show>((message, tone = "info", action) => {
    // The same message twice at once (say, two requests failing the same way) shows once.
    if (!action && showing.current.some((x) => x.message === message)) return
    const id = next.current++
    update((t) => [...t, {id, message, tone, action}])
    setTimeout(() => dismiss(id), action ? 8000 : tone === "error" ? 7000 : 4000)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
            <span className="toast-message">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={(e) => {
                  e.stopPropagation()
                  dismiss(t.id)
                  t.action!.run()
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
