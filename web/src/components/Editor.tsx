import {forwardRef, useEffect, useImperativeHandle, useRef} from "react"
import {Annotation, EditorState} from "@codemirror/state"
import {EditorView, drawSelection, keymap, placeholder} from "@codemirror/view"
import {defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, undo} from "@codemirror/commands"
import {highlightSelectionMatches, search, searchKeymap} from "@codemirror/search"
import {markdown, markdownLanguage} from "@codemirror/lang-markdown"
import {languages} from "@codemirror/language-data"
import {HighlightStyle, syntaxHighlighting, indentUnit} from "@codemirror/language"
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion,
  type CompletionContext,
  type CompletionResult
} from "@codemirror/autocomplete"
import {tags as t} from "@lezer/highlight"
import {dirname, linkTextFor, noteTitle} from "@notebarn/shared/paths"
import {frontmatter} from "../markdown/frontmatter"
import {cycleHeading, insertWikilink, toggleTask, toggleWrap} from "../markdown/commands"

/** Formatting commands, for the toolbar. */
export type EditorCommand = "bold" | "italic" | "task" | "heading" | "link" | "indent" | "outdent" | "undo" | "redo"

/** Marks changes that came from outside (merges, other devices), so they aren't reported back as typing. */
const External = Annotation.define<boolean>()

export interface EditorHandle {
  /** Replaces the text, changing only the part that differs so the cursor stays where it was. */
  setText(text: string): void
  /** Types `text` at the cursor, as if the person had (so it's saved like any edit). */
  insertAtCursor(text: string): void
  focus(): void
  run(command: EditorCommand): void
}

interface EditorProps {
  initialText: string
  onChange(text: string): void
  /** Every note path, for `[[` autocomplete. Read when needed, so it can change without rebuilding the editor. */
  paths: () => readonly string[]
  onOpenLink(target: string): void
  onSave(): void
  /** Files pasted or dropped into the note. The cursor is already where they were dropped. */
  onFiles?(files: File[]): void
  autoFocus?: boolean
  /** The editor gained or lost the keyboard (the toolbar only shows while it has it). */
  onFocusChange?(focused: boolean): void
}

const highlight = HighlightStyle.define([
  {tag: t.heading1, class: "cm-h cm-h1"},
  {tag: t.heading2, class: "cm-h cm-h2"},
  {tag: t.heading3, class: "cm-h cm-h3"},
  {tag: [t.heading4, t.heading5, t.heading6], class: "cm-h cm-h4"},
  {tag: t.strong, fontWeight: "700"},
  {tag: t.emphasis, fontStyle: "italic"},
  {tag: t.strikethrough, textDecoration: "line-through"},
  {tag: t.link, class: "cm-md-link"},
  {tag: t.url, class: "cm-md-url"},
  {tag: t.monospace, class: "cm-md-code"},
  {tag: t.quote, class: "cm-md-quote"},
  {tag: [t.processingInstruction, t.meta, t.contentSeparator], class: "cm-md-mark"},
  {tag: t.atom, class: "cm-md-task"},
  {tag: t.keyword, class: "cm-tok-keyword"},
  {tag: [t.string, t.special(t.string)], class: "cm-tok-string"},
  {tag: t.comment, class: "cm-tok-comment"},
  {tag: [t.number, t.bool, t.null], class: "cm-tok-number"},
  {tag: [t.function(t.variableName), t.typeName, t.className], class: "cm-tok-fn"}
])

/** Suggests notes after `[[`, inserting the shortest link that reaches each. */
function wikilinkCompletion(paths: () => readonly string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^\]|#\n]*$/)
    if (!before) return null
    const all = paths()
    return {
      from: before.from + 2,
      options: all.map((p) => {
        const text = linkTextFor(p, all)
        return {
          label: noteTitle(p),
          detail: dirname(p) || undefined,
          // Insert the link and its closing brackets (skipping over them if already typed), then put the cursor after.
          apply: (view: EditorView, _c: unknown, from: number, to: number) => {
            const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to
            const insert = `${text}]]`
            view.dispatch({changes: {from, to: end, insert}, selection: {anchor: from + insert.length}, userEvent: "input.complete"})
          },
          type: "text"
        }
      }),
      validFor: /^[^\]|#\n]*$/
    }
  }
}

/** The `[[target]]` around a position in the text, if there is one. */
function wikilinkAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos)
  const offset = pos - line.from
  for (const m of line.text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const start = m.index ?? 0
    if (offset >= start && offset <= start + m[0].length) return m[1]
  }
  return null
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    const state = EditorState.create({
      doc: props.initialText,
      extensions: [
        history(),
        drawSelection(),
        closeBrackets(),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        keymap.of([
          {key: "Mod-s", run: () => (latest.current.onSave(), true)},
          {key: "Mod-b", run: (v) => toggleWrap(v, "**")},
          {key: "Mod-i", run: (v) => toggleWrap(v, "*")},
          {key: "Mod-Enter", run: toggleTask},
          ...searchKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab
        ]),
        markdown({base: markdownLanguage, codeLanguages: languages, addKeymap: true, extensions: [frontmatter]}),
        syntaxHighlighting(highlight),
        search({top: true}),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({spellcheck: "true", autocorrect: "on", autocapitalize: "sentences"}),
        placeholder("Start writing…"),
        autocompletion({override: [wikilinkCompletion(() => latest.current.paths())], icons: false}),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (update.transactions.some((tr) => tr.annotation(External))) return
          latest.current.onChange(update.state.doc.toString())
        }),
        EditorView.focusChangeEffect.of((_state, focusing) => {
          latest.current.onFocusChange?.(focusing)
          return null
        }),
        EditorView.domEventHandlers({
          paste(event) {
            const files = [...(event.clipboardData?.files ?? [])]
            if (!files.length || !latest.current.onFiles) return false
            event.preventDefault()
            latest.current.onFiles(files)
            return true
          },
          drop(event, v) {
            const files = [...(event.dataTransfer?.files ?? [])]
            if (!files.length || !latest.current.onFiles) return false
            event.preventDefault()
            const pos = v.posAtCoords({x: event.clientX, y: event.clientY})
            if (pos !== null) v.dispatch({selection: {anchor: pos}})
            latest.current.onFiles(files)
            return true
          },
          mousedown(event, v) {
            if (!(event.metaKey || event.ctrlKey)) return false
            const pos = v.posAtCoords({x: event.clientX, y: event.clientY})
            const link = pos === null ? null : wikilinkAt(v, pos)
            if (!link) return false
            event.preventDefault()
            latest.current.onOpenLink(link)
            return true
          }
        })
      ]
    })
    view.current = new EditorView({state, parent: host.current!})
    if (props.autoFocus) view.current.focus()
    return () => {
      view.current?.destroy()
      view.current = null
    }
    // The editor is made once per note; the parent remounts it (with a key) for another note.
  }, [])

  useImperativeHandle(ref, () => ({
    setText(text: string) {
      const v = view.current
      if (!v) return
      const current = v.state.doc.toString()
      if (current === text) return
      let start = 0
      while (start < current.length && start < text.length && current[start] === text[start]) start++
      let endA = current.length
      let endB = text.length
      while (endA > start && endB > start && current[endA - 1] === text[endB - 1]) {
        endA--
        endB--
      }
      v.dispatch({changes: {from: start, to: endA, insert: text.slice(start, endB)}, annotations: External.of(true)})
    },
    insertAtCursor(text: string) {
      const v = view.current
      if (!v) return
      const {from, to} = v.state.selection.main
      v.dispatch({changes: {from, to, insert: text}, selection: {anchor: from + text.length}, userEvent: "input"})
    },
    focus() {
      view.current?.focus()
    },
    run(command: EditorCommand) {
      const v = view.current
      if (!v) return
      switch (command) {
        case "bold":
          toggleWrap(v, "**")
          break
        case "italic":
          toggleWrap(v, "*")
          break
        case "task":
          toggleTask(v)
          break
        case "heading":
          cycleHeading(v)
          break
        case "link":
          insertWikilink(v)
          startCompletion(v)
          break
        case "indent":
          indentMore(v)
          break
        case "outdent":
          indentLess(v)
          break
        case "undo":
          undo(v)
          break
        case "redo":
          redo(v)
          break
      }
      v.focus()
    }
  }))

  return <div className="editor" ref={host} />
})
