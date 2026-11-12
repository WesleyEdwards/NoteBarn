import {useEffect, useRef, useState, type MutableRefObject} from "react"
import type {Api, Note, Vault} from "@notebarn/shared/api"
import {errorMessage} from "../api/client"
import {
  INVALID_NAME_CHARS,
  availablePath,
  basename,
  dirname,
  linkTextFor,
  noteTitle,
  parseWikilink,
  pastedImageName,
  resolveWikilink
} from "@notebarn/shared/paths"
import {uploadAttachment} from "../sync/attachments"
import {NoteSession, localDraftStore, type SaveState} from "../sync/NoteSession"
import type {VaultStore} from "../sync/VaultStore"
import {noteCache} from "../sync/noteCache"
import {AttachmentEmbed} from "./Attachment"
import {Backlinks} from "./Backlinks"
import {Editor, type EditorHandle} from "./Editor"
import {EditorToolbar} from "./EditorToolbar"
import {Reader} from "./Reader"
import {useToast} from "./Toast"

export type Mode = "edit" | "read"

interface NoteViewProps {
  api: Api
  store: VaultStore
  vault: Vault.ID
  path: string
  mode: Mode
  paths: readonly string[]
  /** Select the title for renaming, after making a new note. */
  focusTitle: boolean
  onOpenLink(target: string): void
  /** Open a note by its path (from the linked mentions). */
  onOpen(path: string): void
  onSaveState(state: SaveState): void
  onRename(newTitle: string): Promise<boolean>
  /** Another device renamed or moved this note to `path`. */
  onMoved(path: string): void
  sessionRef: MutableRefObject<NoteSession | null>
}

/** `path` is the note it was loaded for: right after switching notes, the state still describes the previous one for a render. */
type Load =
  | {status: "loading"}
  | {status: "ready"; path: string; session: NoteSession; existed: boolean}
  | {status: "error"; path: string; message: string}

export function NoteView(props: NoteViewProps) {
  const {api, store, vault, path, mode, paths, sessionRef} = props
  const toast = useToast()
  const [load, setLoad] = useState<Load>({status: "loading"})
  const [text, setText] = useState("")
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [editorFocused, setEditorFocused] = useState(false)
  const editor = useRef<EditorHandle>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    let cancelled = false
    let session: NoteSession | null = null
    let unwatch: (() => void) | null = null
    setLoad({status: "loading"})

    const start = (note: Note | null) => {
      if (cancelled) return
      const s = new NoteSession(
        api.note,
        localDraftStore,
        vault,
        path,
        note,
        {
          onRemoteText: (t) => {
            setText(t)
            editor.current?.setText(t)
          },
          onState: (state) => {
            setSaveState(state)
            latest.current.onSaveState(state)
          },
          onSaved: (n) => {
            store.noteSaved(n)
            if (n.path === path) noteCache.put(n)
          },
          onConflictCopy: (p) =>
            toast(`Your edits couldn't be merged with changes from another device, so they were saved as "${noteTitle(p)}".`)
        },
        {existingPaths: () => store.getSnapshot().paths}
      )
      session = s
      sessionRef.current = s
      unwatch = store.watchNote(path, (n, movedTo) => {
        // Claude: with unsaved edits, stay put (typing brings the old note back) so they aren't lost.
        if (movedTo && s.saveState === "saved") return latest.current.onMoved(movedTo)
        noteCache.put(n)
        s.remoteUpdate(n)
      })
      setText(s.text)
      setSaveState(s.saveState)
      latest.current.onSaveState(s.saveState)
      setLoad({status: "ready", path, session: s, existed: !!note && !note.deleted})
    }

    // Open the copy on this device straight away (instant, and works offline), then check the server for newer.
    const cached = noteCache.get(vault, path)
    if (cached) start(cached)

    api.note
      .readNote({vault, path})
      .then((note) => {
        if (cancelled) return
        if (note) noteCache.put(note)
        else noteCache.remove(vault, path)
        if (!session) return start(note ?? null)
        if (note) {
          session.remoteUpdate(note)
        } else if (session.saveState === "saved") {
          // Gone from the server since it was cached, and not edited here: show it as the new, empty note it now is.
          unwatch?.()
          session.dispose()
          session = null
          start(null)
        }
      })
      .catch(async (e) => {
        if (cancelled) return
        if (session) {
          if (!(e instanceof TypeError)) toast(`Couldn't check for a newer copy: ${await errorMessage(e)}`, "error")
          return
        }
        if (e instanceof TypeError && localDraftStore.get(vault, path)) {
          toast("You're offline. Showing the unsaved copy on this device.")
          start(null)
        } else {
          setLoad({status: "error", path, message: await errorMessage(e)})
        }
      })

    return () => {
      cancelled = true
      unwatch?.()
      if (session) {
        const s = session
        if (sessionRef.current === s) sessionRef.current = null
        void s.flush().finally(() => s.dispose())
      }
    }
  }, [api, store, vault, path])

  if (load.status === "loading" || load.path !== path) return <div className="note-loading" aria-busy="true" />
  if (load.status === "error") return <p className="note-error">Couldn't open this note: {load.message}</p>

  const session = load.session
  const edit = (t: string) => {
    session.edit(t)
    setText(t)
  }

  /** Uploads pasted or dropped files next to the note, and links them where the cursor is, like Obsidian. */
  const addFiles = async (files: File[]) => {
    for (const file of files) {
      // Pasted screenshots arrive as "image.png"; name them the way Obsidian does instead.
      const generic = !file.name || /^image\.\w+$/i.test(file.name)
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*/, "") || "png"
      const name = generic ? pastedImageName(new Date(), ext) : file.name.replace(/[\\/:*?"<>|#^[\]]/g, "-")
      const target = availablePath(dirname(path), name, store.getSnapshot().paths)
      toast(`Uploading ${basename(target)}…`)
      try {
        store.noteSaved(await uploadAttachment(api, vault, target, file))
        editor.current?.insertAtCursor(`![[${linkTextFor(target, store.getSnapshot().paths)}]]`)
      } catch (e) {
        toast(`Couldn't upload ${basename(target)}: ${await errorMessage(e)}`, "error")
      }
    }
  }

  return (
    <>
    <article className={mode === "read" ? "note reading" : "note"}>
      <NoteTitle key={`title:${path}`} path={path} autoSelect={props.focusTitle} onRename={props.onRename} />
      {saveState === "deleted" && (
        <div className="banner">This note was deleted on another device. Edit it to bring it back.</div>
      )}
      {!load.existed && !text && saveState === "saved" && mode === "edit" && (
        <p className="hint">New note. It's created when you start typing.</p>
      )}
      {mode === "edit" ? (
        <Editor
          key={`editor:${path}`}
          ref={editor}
          initialText={session.text}
          onChange={edit}
          paths={() => latest.current.paths}
          onOpenLink={(t) => latest.current.onOpenLink(t)}
          onSave={() => void session.flush()}
          onFiles={(files) => void addFiles(files)}
          autoFocus={!props.focusTitle && !load.existed}
          onFocusChange={setEditorFocused}
          renderEmbed={(inner) => {
            const link = parseWikilink(inner)
            return <AttachmentEmbed path={resolveWikilink(link.target, path, paths)} name={link.target} size={link.alias} />
          }}
        />
      ) : (
        <Reader text={text} path={path} paths={paths} onOpenLink={props.onOpenLink} onChangeText={edit} />
      )}
      {load.existed && <Backlinks key={`backlinks:${path}`} api={api} vault={vault} path={path} paths={paths} onOpen={props.onOpen} />}
    </article>
    {mode === "edit" && editorFocused && (
      <EditorToolbar onCommand={(c) => editor.current?.run(c)} onAttach={() => filePicker.current?.click()} />
    )}
    {/* Outside the toolbar, which goes away while the picker has the screen. */}
    <input
      ref={filePicker}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        const files = [...(e.target.files ?? [])]
        e.target.value = ""
        if (files.length) void addFiles(files)
      }}
    />
    </>
  )
}

/** The note's name as an editable heading, like Obsidian's inline title. Changing it renames the file. */
function NoteTitle({path, autoSelect, onRename}: {path: string; autoSelect: boolean; onRename(t: string): Promise<boolean>}) {
  const [value, setValue] = useState(noteTitle(path))
  const input = useRef<HTMLTextAreaElement>(null)
  // Mounted once per note (keyed by path), so this runs when a new note opens.
  useEffect(() => {
    if (autoSelect) {
      input.current?.focus()
      input.current?.select()
    }
  }, [])
  useEffect(() => {
    // Grow to fit long titles.
    const el = input.current
    if (el) {
      el.style.height = "auto"
      el.style.height = `${el.scrollHeight}px`
    }
  }, [value])

  const invalid = INVALID_NAME_CHARS.test(value)
  const commit = async () => {
    const next = value.trim()
    if (!next || invalid || next === noteTitle(path)) {
      setValue(noteTitle(path))
      return
    }
    if (!(await onRename(next))) setValue(noteTitle(path))
  }

  return (
    <div className="note-title-wrap">
      {dirname(path) && <div className="note-folder">{dirname(path).split("/").join(" / ")}</div>}
      <textarea
        ref={input}
        className={invalid ? "note-title invalid" : "note-title"}
        value={value}
        rows={1}
        spellCheck={false}
        aria-label="Note name"
        enterKeyHint="done"
        onChange={(e) => setValue(e.target.value.replace(/\n/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            input.current?.blur()
          } else if (e.key === "Escape") {
            setValue(noteTitle(path))
            setTimeout(() => input.current?.blur())
          }
        }}
        onBlur={() => void commit()}
      />
      {invalid && <div className="field-error">A name can't contain any of \ / : * ? " &lt; &gt; | # ^ [ ]</div>}
    </div>
  )
}
