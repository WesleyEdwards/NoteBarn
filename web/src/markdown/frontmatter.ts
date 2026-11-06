import type {MarkdownConfig} from "@lezer/markdown"
import {tags as t} from "@lezer/highlight"

/**
 * YAML frontmatter (`---` at the very top, up to the next `---`) for the editor's markdown parser. Without it, the
 * last property line and the closing `---` read as a big heading.
 */
export const frontmatter: MarkdownConfig = {
  defineNodes: [{name: "Frontmatter", block: true, style: t.meta}],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false
        let end = line.text.length
        // Runs to the closing line, or the end of the note while it's still being typed.
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length
          if (/^(---|\.\.\.)\s*$/.test(line.text)) {
            cx.nextLine()
            break
          }
        }
        cx.addElement(cx.elt("Frontmatter", 0, end))
        return true
      }
    }
  ]
}
