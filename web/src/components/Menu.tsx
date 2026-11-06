import {useEffect, useLayoutEffect, useRef, useState} from "react"

export type MenuItem = {label: string; run(): void; danger?: boolean; hint?: string} | "separator"

/** Where to open a menu: next to a button (below its right edge), or at a point (a right-click). */
export type MenuAnchor = {x: number; y: number} | DOMRect

/** A small menu of actions, for right-clicks, long presses and "⋯" buttons. */
export function PopupMenu({anchor, items, onClose}: {anchor: MenuAnchor; items: MenuItem[]; onClose(): void}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{left: number; top: number} | null>(null)

  // Open beside the anchor, kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const {width, height} = el.getBoundingClientRect()
    const margin = 8
    let left: number
    let top: number
    if (anchor instanceof DOMRect) {
      left = anchor.right - width
      top = anchor.bottom + 4
      if (top + height > window.innerHeight - margin) top = anchor.top - height - 4
    } else {
      left = anchor.x
      top = anchor.y
      if (top + height > window.innerHeight - margin) top = anchor.y - height
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin))
    setPos({left, top})
  }, [anchor])

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    // Keyboard users start on the first item; a tap shouldn't show a focus ring.
    if (!matchMedia("(hover: none)").matches) ref.current?.querySelector<HTMLButtonElement>("button")?.focus({preventScroll: true})
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        close.current()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <>
      <div
        className="menu-scrim"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={ref}
        className="menu popup"
        role="menu"
        style={pos ?? {left: 0, top: 0, visibility: "hidden"}}
        onKeyDown={onKeyDown}
      >
        {items.map((item, i) =>
          item === "separator" ? (
            <div key={i} className="menu-separator" role="separator" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              onClick={() => {
                onClose()
                item.run()
              }}
            >
              <span>{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </button>
          )
        )}
      </div>
    </>
  )
}
