import {useEffect, useState} from "react"
import type {EditorCommand} from "./Editor"

/**
 * Formatting buttons above the phone's keyboard, for what's awkward to type there: indenting lists, checkboxes,
 * links, and adding a photo or file.
 */
export function EditorToolbar({onCommand, onAttach}: {onCommand(c: EditorCommand): void; onAttach(): void}) {
  const bottom = useKeyboardInset()
  const button = (command: EditorCommand, title: string, icon: React.ReactNode) => (
    <button
      key={command}
      className="toolbar-button"
      title={title}
      aria-label={title}
      // Keep the keyboard open: a tap here mustn't take focus from the editor.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onCommand(command)}
    >
      {icon}
    </button>
  )
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting" style={{bottom}}>
      {button("undo", "Undo", <Icon d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4" />)}
      {button("redo", "Redo", <Icon d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h4" />)}
      {button("outdent", "Outdent", <Icon d="M21 6H11M21 12H11M21 18H11M7 8l-4 4 4 4" />)}
      {button("indent", "Indent", <Icon d="M21 6H11M21 12H11M21 18H11M3 8l4 4-4 4" />)}
      {button("task", "Checkbox", <Icon d="M4 4h16v16H4zM8 12l3 3 5-6" />)}
      {button("heading", "Heading", <Icon d="M6 4v16M18 4v16M6 12h12" />)}
      {button("bold", "Bold", <Icon d="M7 4h7a4 4 0 0 1 0 8H7zM7 12h8a4 4 0 0 1 0 8H7z" />)}
      {button("italic", "Italic", <Icon d="M19 4h-9M14 20H5M15 4 9 20" />)}
      {button("link", "Link to a note", <Icon d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />)}
      <button
        className="toolbar-button"
        title="Add a photo or file"
        aria-label="Add a photo or file"
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAttach}
      >
        <Icon d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
      </button>
    </div>
  )
}

const Icon = ({d}: {d: string}) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)

/**
 * How far the on-screen keyboard reaches up from the bottom of the window. Android already shrinks the window for it
 * (`interactive-widget=resizes-content`), so this is 0 there; iOS doesn't, so the toolbar is lifted by hand.
 */
function useKeyboardInset() {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    update()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
    }
  }, [])
  return inset
}
