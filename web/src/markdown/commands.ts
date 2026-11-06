import {EditorSelection, type ChangeSpec, type EditorState} from "@codemirror/state"
import type {EditorView} from "@codemirror/view"

/** Puts `mark` on both sides of the selection (or takes it off if it's already there), like Ctrl+B in Obsidian. */
export function toggleWrap(view: EditorView, mark: string): boolean {
  const {state} = view
  const n = mark.length
  view.dispatch(
    state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - n, range.from)
      const after = state.sliceDoc(range.to, range.to + n)
      if (before === mark && after === mark) {
        return {
          changes: [
            {from: range.from - n, to: range.from},
            {from: range.to, to: range.to + n}
          ],
          range: EditorSelection.range(range.from - n, range.to - n)
        }
      }
      const text = state.sliceDoc(range.from, range.to)
      if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
        return {
          changes: {from: range.from, to: range.to, insert: text.slice(n, -n)},
          range: EditorSelection.range(range.from, range.to - 2 * n)
        }
      }
      return {
        changes: [
          {from: range.from, insert: mark},
          {from: range.to, insert: mark}
        ],
        range: EditorSelection.range(range.from + n, range.to + n)
      }
    }),
    {userEvent: "input"}
  )
  return true
}

/** The lines the selection touches, each once. */
function selectedLines(state: EditorState) {
  const seen = new Set<number>()
  const lines = []
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos)
      if (!seen.has(line.number)) {
        seen.add(line.number)
        lines.push(line)
      }
      pos = line.to + 1
    }
  }
  return lines
}

const TASK = /^(\s*)([-*+]|\d+[.)]) \[( |x|X)\] /
const LIST = /^(\s*)([-*+]|\d+[.)]) /

/** Turns lines into checklist items, ticks and unticks them: text → `- [ ] text` → `- [x] text` → `- [ ] text`. */
export function toggleTask(view: EditorView): boolean {
  const {state} = view
  const changes: ChangeSpec[] = []
  for (const line of selectedLines(state)) {
    const task = TASK.exec(line.text)
    if (task) {
      const at = line.from + task[0].length - 3
      changes.push({from: at, to: at + 1, insert: task[3] === " " ? "x" : " "})
      continue
    }
    const list = LIST.exec(line.text)
    if (list) {
      changes.push({from: line.from + list[0].length, insert: "[ ] "})
      continue
    }
    const indent = /^\s*/.exec(line.text)![0].length
    changes.push({from: line.from + indent, insert: "- [ ] "})
  }
  view.dispatch({changes, userEvent: "input"})
  return true
}

/** Steps a line through heading levels: text → # → ## → ### → text. */
export function cycleHeading(view: EditorView): boolean {
  const {state} = view
  const changes: ChangeSpec[] = []
  for (const line of selectedLines(state)) {
    const m = /^(#{1,6}) /.exec(line.text)
    const level = m ? m[1].length : 0
    const next = level >= 3 ? "" : "#".repeat(level + 1) + " "
    changes.push({from: line.from, to: line.from + (m ? m[0].length : 0), insert: next})
  }
  view.dispatch({changes, userEvent: "input"})
  return true
}

/** Starts a `[[link]]` at the cursor (around the selection, if there is one) and puts the cursor inside it. */
export function insertWikilink(view: EditorView): boolean {
  const {state} = view
  view.dispatch(
    state.changeByRange((range) => ({
      changes: [
        {from: range.from, insert: "[["},
        {from: range.to, insert: "]]"}
      ],
      range: range.empty ? EditorSelection.cursor(range.from + 2) : EditorSelection.range(range.from + 2, range.to + 2)
    })),
    {userEvent: "input.type"}
  )
  return true
}
