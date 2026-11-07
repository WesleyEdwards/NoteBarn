# Notebarn

Self-hosted sync for Obsidian-style markdown notes: a web app for the phone and any browser, with the server as the
source of truth, and an Obsidian plugin that syncs vaults on desktop (and, next, the Obsidian mobile app).

```
server/     LightningServer (Kotlin): vaults, notes, versioned writes, change feed. AWS Lambda + Mongo Atlas.
shared/     TypeScript used by both clients: generated API client, merge, paths, and the sync engine.
web/        React + Vite + CodeMirror 6 web app (installable PWA, works offline).
plugin/     Obsidian plugin (desktop and the mobile app) that syncs a vault using shared/'s sync engine.
test-sync/  Scratch vault with a few sample notes for trying the plugin. Its .obsidian folder is gitignored (it holds
            your session).
```

The TypeScript packages are one npm workspace: run `npm install` once at the top level.

## Running locally

```bash
# Server on http://localhost:8085 (embedded Mongo on port 8006; data in server/local/)
cd server && ./gradlew server:serve

# Web app on http://localhost:8917 (proxies /api to the server)
npm install && cd web && npm run dev
```

Locally `allowedEmails` is `["*"]` and email is `console`, so sign in with any address and copy the code from the
server's output. Open the dev URL on your phone (same Wi-Fi, `http://<computer-ip>:8917`) to try it there.

After changing server endpoints or models, regenerate the TypeScript SDK (in `shared/src/api.ts`) while the server
runs: `cd shared && npm run generate-sdk`.

Tests: `cd server && ./gradlew server:test` and `npm test` (shared + web). To also run the two-device sync test against
a running local server: `NOTEBARN_SERVER=http://localhost:8085 NOTEBARN_SERVER_LOG=<file with the server's output> npm test -w @notebarn/shared`.

## The Obsidian plugin

`cd plugin && npm run install-test` builds it and installs it into `test-sync/`. Open `test-sync` as a vault in
Obsidian, turn off restricted mode (Settings → Community plugins), then enable Notebarn. In its settings:
set the server (`http://localhost:8085` for a local one), sign in with the emailed code, and choose or create the
server vault. "Preview" shows what a sync would do without changing anything.

- Syncs every file: notes (`.md`, `.canvas`) as text, and everything else (images, PDFs, audio...) as attachments, up
  to 100 MB each. Skips `.obsidian/`, `.trash/` and other hidden files.
- Sends a file 1.5 s after you stop editing it; checks the server every 10 s and whenever you come back to Obsidian;
  compares everything at startup and every 10 minutes.
- The first sync with a server vault never deletes anything: files that differ on the two sides become conflict copies.
- Files deleted by sync go to Obsidian's trash (following its "Deleted files" setting), so they can be restored.
- Its state lives in `.obsidian/plugins/notebarn/` (`sync-state.json` plus the last-synced text of each note in
  `bases/`). Deleting that folder's state just makes the next sync a first sync again.

### Releasing (and the phone)

Phones install it with the BRAT plugin, from this repo's GitHub releases. To release a new version:

```bash
node plugin/release.mjs 0.1.4   # sets the version everywhere, including the root manifest.json BRAT reads
git add -A manifest.json versions.json package-lock.json plugin .github && git commit -m "Notebarn 0.1.4"
git tag 0.1.4 && git push && git push origin 0.1.4
```

The tag starts `.github/workflows/plugin-release.yml`, which tests, builds and publishes the release. BRAT picks up
new versions on its own (or with its "Check for updates" command).

### Adding a vault or a device

Each Obsidian vault (on each device) syncs with one server vault. Plugins are per vault, so every new vault needs the
plugin installed in it, even on a device that already has another vault syncing.

**Setting up the plugin in a vault** (any device):

1. Settings → Community plugins: turn on community plugins and install **BRAT**.
2. In BRAT, "Add beta plugin": `WesleyEdwards/notebarn`. Enable
   **Notebarn**. (Or, on desktop, copy `plugin/main.js`, `manifest.json` and `styles.css` from a build into
   `<vault>/.obsidian/plugins/notebarn/`, but then updates are by hand.)
3. In Notebarn's settings, sign in.
4. Choose the server vault (below), then run **Preview sync** before the first real sync, and check what it plans.

**An existing vault, not on the server yet** (e.g. a desktop vault with notes in it):

1. Back the vault up first (copy its folder).
2. Set up the plugin in it, and under **Server vault** click **New**. The server vault is named after the local one.
3. The first sync sends every note to the server.

**Another device for a vault that's already syncing** (e.g. getting your desktop vault onto the phone):

1. On the new device, create a new, empty vault (on Android, in **App storage**). Naming it like the original keeps
   things clear.
2. Set up the plugin in it, and under **Server vault** choose the existing one. Don't click **New**.
3. Preview should show only "Get from server"; the first sync downloads everything.

**Two devices that both already have copies of the same notes:** choose the same server vault on both. The first sync
never deletes anything: identical files are just recorded, files only on one side are copied over, and files that
differ become conflict copies (`Name (conflict …).md`) to sort out by hand. Fewer differences means fewer conflict
copies, so if one copy is up to date, prefer starting the other device from an empty vault instead.

Things to avoid:

- **Don't point a vault that's already syncing at a different server vault.** Its first sync with the new one uploads
  all its notes there, mixing the two vaults together (on the server and every other device). Make a new vault instead.
- **Don't sync two unrelated vaults with the same server vault**, for the same reason.

What doesn't come across: anything in `.obsidian/` (themes, hotkeys, other plugins and their settings), so set those
up on each device.

## Deploying

Everything personal to Wesley's own deployment lives in `server/.../deploy/WesleyDeployment.kt` and the two
`terraform/wesley` folders (`server/server/terraform/wesley`, generated, and `web/terraform/wesley`).

Server (Lambda, Mongo Atlas free tier, SES email, DynamoDB cache):

1. Run `WesleyDeployment.EditSettings.main` to create or edit the encrypted `server/wesley-aws-settings` (put its
   password in `server/local.properties` as `DEPLOYMENT_SETTINGS_KEY`).
2. Run `WesleyDeployment.Deploy.main`. It deploys to `api.notebarn.a.wesleyedwards.xyz`; only the emails in
   `allowedEmails` can sign in. That list is kept in `wesley-aws-settings`, not in git; change it with step 1.

Web: `cd web && npm run deploy` (S3 + CloudFront at `notebarn.a.wesleyedwards.xyz`, Terraform state in the
`wesleyedwards-terraform` bucket under `notebarn/`). On the phone, open it and use **Add to Home Screen**.

**Deploying your own:** copy `WesleyDeployment.kt` and change its domain, buckets, Atlas org and contact email (its
`terraformRoot` must stay two folders inside `server/server/`, where the library expects it). Copy
`web/terraform/wesley` the same way, build the web app with `VITE_BACKEND_URL` and `VITE_WEBSOCKET_URL` set to your
server's addresses, and set the server address in the plugin's settings.

## How syncing works

Every note is `(vault, path, content, version)`. Each vault has a counter; every change to any note in it takes the
next number, so "everything after version N" is how a client catches up.

- **Write** `POST /note/write {vault, path, content, baseVersion}`: succeeds only if the note is still at `baseVersion`
  (`null` = "I think it doesn't exist"). Otherwise the result is `{success: false, note: <server copy>}` and the client
  merges. Writing content the note already has always succeeds; writing to a deleted note brings it back (edits beat
  deletes).
- **Delete / rename** work the same way. Deletes leave a tombstone (`deleted: true`) so other devices learn about them.
- **Changes** `POST /note/changes {vault, since}`: every note (tombstones included) changed after `since`, oldest
  first, paged with `cursor`/`hasMore`.
- **Manifest** `POST /note/manifest`: every path with its version and SHA-256 hash, no content. Used to draw the file
  tree, and for a sync client to double-check it hasn't missed anything.

**Attachments** (any file that isn't `.md` or `.canvas`) are notes too, with `attachment: true`, empty `content`, and
`hash`/`size` of their bytes. The bytes don't go through the server: they're stored in the file store (S3 in
production, `server/local/files` locally) at `attachments/<vault>/<sha256>`, so each file is kept once per vault.

- `POST /note/attachment-upload {vault, hash, size}` → `{uploadUrl}`: a link to PUT the bytes to, or null if the
  server already has them.
- `POST /note/write-attachment {vault, path, hash, baseVersion}`: like a write, once the bytes are uploaded. The
  server checks the bytes match the hash.
- `POST /note/attachment-urls {vault, hashes}`: download links, in the same order.
- Live Changes websocket: `/?path=/note/live&vault=<id>&jwt=<access token>` (deployed: on
  `wss://ws.api.notebarn.a.wesleyedwards.xyz`; locally: the server's own address). It sends `{vault, latestVersion}`
  whenever a note in the vault changes; ask `changes` from there. Nothing is sent for changes made while it's
  disconnected, so ask `changes` whenever it (re)opens. Send anything every few minutes to keep it open (API Gateway
  closes idle websockets after 10 minutes); the server ignores it.

**History**: before a note changes or is deleted, the server keeps a copy of it (`NoteVersion`, see
`server/.../data/NoteHistory.kt`), so every client gets history without doing anything. To keep it small:

- While a note is being edited, a copy is taken at most every 10 minutes (an hour for notes over 200 KB), plus
  whenever text that sat unchanged for 2 minutes is about to change. Deletes are always copied.
- Copies last 14 days; the first copy of each note each day, and deleted notes, last 90. Expired copies are cleared
  out whenever a new copy is taken in the vault, so there's no scheduled job. Text over 1 KB is stored gzipped.
- Renaming a note moves its history along. Attachments' copies hold only their hash (the bytes stay in the file store).
- `POST /note/history {vault, path}` lists a note's copies (no content); `POST /note/version {vault, id}` gets one;
  `POST /note/restore {vault, id, baseVersion}` puts one back like a write (and always keeps a copy of what it
  replaces); `POST /note/deleted` lists notes deleted in the last 90 days. In the web app: "Version history…" in a
  note's menu, and "Recently deleted…" in the sidebar's menu.

**Sharing**: a note can be shared through a link anyone can open, without signing in (`Share`, see
`server/.../data/ShareEndpoints.kt`). The link always shows the note as it is now, read-only, with the attachments it
embeds; links to other notes show as plain text. The link's secret is the share's random ID.

- `POST /share/create {vault, path}` returns the note's share (the same one if it's already shared);
  `POST /share/stop {vault, path}` turns it off. Owners list their shares through the `/share` REST endpoints.
- `POST /share/view <share id>` needs no login: the note's title (not its folder), content and modified time, plus a
  download link for each embedded attachment, keyed by the name the embed uses. The server finds embeds the way the
  web app does (`ShareEndpoints.resolve` matches `resolveWikilink` in `shared/src/paths.ts`), and sends nothing else
  from the vault.
- Renaming a note through `/note/rename` moves its share along. Deleting the note ends it. The Obsidian plugin
  renames by deleting and writing, so renaming a shared note in Obsidian ends its link.

Rename, delete, changes and the manifest treat attachments like any note. They're never merged: if both sides changed
one, the server's stays at the path and the other is kept as a conflict copy (`Photo (conflict …).png`).

Clients merge with a line-based three-way merge (`web/src/sync/merge.ts`): edits to different lines combine; lines
both sides added at the same spot are both kept. If edits really collide, the client keeps the server's version and
saves its own as `Name (conflict 2026-11-03 1405).md`, like Obsidian Sync. Nothing is silently overwritten.

In the web app:

- Right-click (or long-press, or "⋯") a file or folder in the sidebar to rename, move, duplicate or delete it; drag
  them onto folders to move them. Renaming or moving updates `[[links]]` to them in other notes, like Obsidian.
  Deleting shows an Undo for a few seconds.
- Under each note, "Linked mentions" lists the notes that link to it.
- On phones, a formatting bar sits above the keyboard (undo, indent, checkbox, heading, bold, italic, link, add a
  photo or file). On a computer: Ctrl/⌘+B, I, Enter (checkbox), F (find and replace), O (find a note), N, E, S, \\.
- The calendar button opens today's daily note (`2026-11-05.md`, in the folder that already holds daily notes).
- Vaults can be renamed and deleted from the vault list.
- "Share…" in a note's menu makes a link anyone can read it through (copied straight away), at `/s/<id>`. Shared notes
  have a 🔗 in the sidebar; "Stop sharing" in the same dialog turns the link off.

Paste or drop a file into a note to upload it next to the note and link it (`![[name]]`); reading
view shows images, PDFs, audio and video, and opening an attachment from the file list shows it with a download
button. The download button at the top of the sidebar saves the whole vault (notes and attachments, in their
folders) as a zip, straight from the server.

The web app (`web/src/sync/NoteSession.ts`) saves about 0.7 s after you stop typing, hears about other devices'
changes straight away over the Live Changes websocket (`web/src/sync/LiveConnection.ts`; it also checks every minute
in case a nudge went missing, and polls every 5 s while the websocket is down), keeps unsaved edits as a draft on the
device, and retries while offline. Recently opened notes and the app itself are cached, so it opens without a connection.

## Not done yet

- Attachments: replaced or deleted files' bytes stay in the file store (nothing cleans them up yet, except deleting
  the vault). The web app shows `![[embeds]]` only in reading view, not while editing.
- Web app: choose the sidebar's sort order, like Obsidian: by name (A–Z, Z–A) or modified time (newest, oldest), kept
  per vault on each device. Created time would need a new server field.
