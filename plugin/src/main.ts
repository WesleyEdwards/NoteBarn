import {type App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder, type TAbstractFile} from "obsidian"
import type {LiveApi, Vault} from "@notebarn/shared/api"
import {HttpError} from "@notebarn/shared/errors"
import {SyncEngine, remoteVault, type SyncAction, type SyncStatus} from "@notebarn/shared/sync/SyncEngine"
import {anonymousApi, obsidianTransfer, sessionApi} from "./client"
import {ObsidianFiles} from "./ObsidianFiles"
import {PluginBaseStore} from "./PluginBaseStore"

interface Settings {
  serverUrl: string
  sessionToken: string
  email: string
  vaultId: string
  vaultName: string
  pollSeconds: number
}

const DEFAULT_SETTINGS: Settings = {
  serverUrl: "https://api.notebarn.a.wesleyedwards.xyz",
  sessionToken: "",
  email: "",
  vaultId: "",
  vaultName: "",
  pollSeconds: 10
}

/** Compare everything (which also catches anything polling missed) this often. */
const FULL_SYNC_MS = 10 * 60 * 1000
/** Wait this long after the last edit to a file before sending it. */
const EDIT_DELAY_MS = 1500

const ACTION_LABELS: Record<SyncAction["decision"], string> = {
  upload: "Send to server",
  download: "Get from server",
  merge: "Merge edits from both sides",
  conflict: "Keep both (yours becomes a conflict copy)",
  deleteRemote: "Delete on server",
  deleteLocal: "Move to trash here",
  adopt: "Already the same; just record it",
  forget: "Gone on both sides; forget it",
  none: "Nothing"
}

export default class NotebarnPlugin extends Plugin {
  settings: Settings = {...DEFAULT_SETTINGS}
  api: LiveApi | null = null
  engine: SyncEngine | null = null
  private bases: PluginBaseStore | null = null
  private statusEl: HTMLElement | null = null
  private status: SyncStatus | "off" = "off"
  private statusMessage = ""
  private pending = new Map<string, number>()
  private lastFullSync = 0
  readonly log: string[] = []

  async onload() {
    this.settings = {...DEFAULT_SETTINGS, ...(await this.loadData())}
    this.makeApi()

    this.statusEl = this.addStatusBarItem()
    this.statusEl.addClass("notebarn-status")
    this.statusEl.onClickEvent(() => new LogModal(this.app, this).open())
    this.addSettingTab(new NotebarnSettingTab(this.app, this))
    this.addRibbonIcon("refresh-cw", "Sync notes now", () => void this.syncNow())
    this.addCommand({id: "sync-now", name: "Sync now", callback: () => void this.syncNow()})
    this.addCommand({id: "preview-sync", name: "Preview sync (changes nothing)", callback: () => void this.preview()})
    this.addCommand({id: "show-log", name: "Show sync log", callback: () => new LogModal(this.app, this).open()})

    // Registered after the vault loads; otherwise every existing file arrives as a "create".
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (f) => this.onLocalChange(f)))
      this.registerEvent(this.app.vault.on("modify", (f) => this.onLocalChange(f)))
      this.registerEvent(this.app.vault.on("delete", (f) => this.onLocalChange(f)))
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => this.onLocalRename(f, oldPath)))
      void this.restart()
    })

    this.registerInterval(window.setInterval(() => this.tick(), this.settings.pollSeconds * 1000))
    // Coming back to the window (or, on a phone, back to the app): check right away.
    this.registerDomEvent(window, "focus", () => this.tick())
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.tick()
      // Phones pause apps as soon as they're switched away from: send waiting edits now, not in 1.5 seconds.
      else this.sendPendingNow()
    })
  }

  async onunload() {
    for (const timer of this.pending.values()) window.clearTimeout(timer)
    await this.bases?.save()
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  /** Why sync can't run right now, or null if it can. */
  get blocker(): string | null {
    if (!this.settings.sessionToken) return "Not signed in"
    if (!this.settings.vaultId) return "No server vault chosen"
    return null
  }

  makeApi() {
    this.api = this.settings.sessionToken
      ? sessionApi(this.settings.serverUrl, this.settings.sessionToken, () => void this.signOut("The server ended this session. Sign in again."))
      : null
  }

  async signOut(message?: string) {
    this.settings.sessionToken = ""
    this.settings.email = ""
    await this.saveSettings()
    this.makeApi()
    await this.restart()
    if (message) new Notice(`Notebarn: ${message}`)
  }

  /** Rebuilds the engine for the current settings and runs a full sync. */
  async restart() {
    await this.bases?.save()
    this.engine = null
    this.bases = null
    const blocker = this.blocker
    if (blocker || !this.api) return this.setStatus("off", blocker ?? "")
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`
    this.bases = await PluginBaseStore.load(this.app.vault.adapter, dir, this.settings.vaultId)
    const isSyncable = (path: string) => this.isSyncable(path)
    this.engine = new SyncEngine(
      new ObsidianFiles(this.app, isSyncable, this.bases.hashCache),
      this.bases,
      remoteVault(this.api, this.settings.vaultId as Vault.ID, obsidianTransfer),
      {
        onStatus: (s, message) => this.setStatus(s, message),
        onAction: (a) => this.addLog(`${ACTION_LABELS[a.decision]}: ${a.path}`),
        onConflict: (path, copy) => {
          this.addLog(`Couldn't merge ${path}; your version is in ${copy}`)
          new Notice(`Notebarn: edits to "${path}" couldn't be merged. Your version was kept as "${copy}".`, 15000)
        },
        onSkipped: (path, message) => {
          this.addLog(`Skipped ${path}: ${message}`)
          new Notice(`Notebarn: couldn't sync "${path}" on this device, so it was skipped: ${message}`, 15000)
        }
      },
      {isSyncable}
    )
    await this.fullSync()
  }

  /** Every file in the vault (notes and attachments), except settings, the trash and other hidden files. */
  isSyncable(path: string): boolean {
    if (path.startsWith(`${this.app.vault.configDir}/`) || path.startsWith(".trash/")) return false
    return !path.split("/").some((part) => part.startsWith("."))
  }

  async fullSync() {
    if (!this.engine) return
    this.lastFullSync = Date.now()
    try {
      const actions = await this.engine.fullSync()
      if (actions.length) this.addLog(`Full sync: ${actions.length} change${actions.length === 1 ? "" : "s"}`)
      await this.bases?.cleanUp((p) => !!this.app.vault.getFileByPath(p))
    } catch (e) {
      this.reportError("Full sync", e)
    }
  }

  async syncNow() {
    if (!this.engine) {
      new Notice(`Notebarn: ${this.blocker ?? "not ready"}`)
      return
    }
    await this.fullSync()
    if (this.status === "idle") new Notice("Notebarn: everything is in sync.")
  }

  async preview() {
    if (!this.engine) {
      new Notice(`Notebarn: ${this.blocker ?? "not ready"}`)
      return
    }
    try {
      new PreviewModal(this.app, await this.engine.fullSync(true)).open()
    } catch (e) {
      this.reportError("Preview", e)
    }
  }

  private tick() {
    if (!this.engine) return
    if (Date.now() - this.lastFullSync > FULL_SYNC_MS) void this.fullSync()
    else this.engine.pull().catch((e) => this.reportError("Checking for changes", e))
  }

  private onLocalChange(file: TAbstractFile) {
    if (file instanceof TFile) this.schedule(file.path)
    // A deleted folder's files may not each get an event; anything that was synced under it is checked.
    else if (file instanceof TFolder) this.scheduleUnder(file.path)
  }

  private onLocalRename(file: TAbstractFile, oldPath: string) {
    // To the server a rename is a delete of the old path and a new note at the new one.
    if (file instanceof TFile) {
      this.schedule(oldPath)
      this.schedule(file.path)
    } else if (file instanceof TFolder) {
      this.scheduleUnder(oldPath)
      const walk = (f: TAbstractFile) => (f instanceof TFolder ? f.children.forEach(walk) : this.schedule(f.path))
      walk(file)
    }
  }

  private scheduleUnder(folder: string) {
    void this.bases?.paths().then((paths) => paths.filter((p) => p.startsWith(`${folder}/`)).forEach((p) => this.schedule(p)))
  }

  /** Sends a file a moment after its last change, so typing doesn't send every keystroke. */
  private schedule(path: string) {
    if (!this.engine || !this.isSyncable(path)) return
    const existing = this.pending.get(path)
    if (existing) window.clearTimeout(existing)
    this.pending.set(
      path,
      window.setTimeout(() => {
        this.pending.delete(path)
        this.engine?.localChanged(path).catch((e) => this.reportError(`Sending ${path}`, e))
      }, EDIT_DELAY_MS)
    )
  }

  private sendPendingNow() {
    for (const [path, timer] of this.pending) {
      window.clearTimeout(timer)
      this.engine?.localChanged(path).catch((e) => this.reportError(`Sending ${path}`, e))
    }
    this.pending.clear()
  }

  private reportError(what: string, e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    this.addLog(`${what} failed: ${message}`)
    // Claude: Being offline (a TypeError) is normal and retries by itself. Mobile has no status bar, so anything else
    // needs a notice.
    if (!(e instanceof TypeError) && !(e instanceof HttpError && e.status === 401)) new Notice(`Notebarn: ${what} failed: ${message}`, 10000)
  }

  addLog(line: string) {
    const time = new Date().toLocaleTimeString()
    this.log.push(`${time}  ${line}`)
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300)
  }

  private setStatus(status: SyncStatus | "off", message = "") {
    if (status !== this.status && (status === "offline" || status === "error")) this.addLog(`${status}: ${message}`)
    this.status = status
    this.statusMessage = message
    const el = this.statusEl
    if (!el) return
    el.toggleClass("is-error", status === "error")
    el.toggleClass("is-offline", status === "offline")
    const labels = {idle: "Synced", syncing: "Syncing…", offline: "Sync offline", error: "Sync error", off: "Sync off"}
    el.setText(labels[status])
    el.setAttr("aria-label", message || labels[status])
    el.setAttr("data-tooltip-position", "top")
  }

  get statusText() {
    const labels = {idle: "In sync", syncing: "Syncing…", offline: "Offline (keeps retrying)", error: "Error", off: "Off"}
    return `${labels[this.status]}${this.statusMessage ? `: ${this.statusMessage}` : ""}`
  }
}

class NotebarnSettingTab extends PluginSettingTab {
  private email = ""
  private code = ""
  private proofKey: string | null = null
  private vaults: Vault[] | null = null

  constructor(
    app: App,
    private readonly plugin: NotebarnPlugin
  ) {
    super(app, plugin)
  }

  display() {
    const {containerEl} = this
    const s = this.plugin.settings
    containerEl.empty()

    new Setting(containerEl).setName("Status").setDesc(this.plugin.statusText)

    new Setting(containerEl)
      .setName("Server")
      .setDesc("Your Notebarn server's address.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.serverUrl)
          .setValue(s.serverUrl)
          .onChange(async (v) => {
            s.serverUrl = v.trim() || DEFAULT_SETTINGS.serverUrl
            await this.plugin.saveSettings()
            this.plugin.makeApi()
          })
      )

    if (!s.sessionToken) this.signInSection(containerEl)
    else this.vaultSection(containerEl)

    new Setting(containerEl)
      .setName("Check for changes every")
      .setDesc("Also checks whenever you come back to Obsidian. Takes effect after restarting Obsidian.")
      .addDropdown((d) =>
        d
          .addOptions({"5": "5 seconds", "10": "10 seconds", "30": "30 seconds", "60": "1 minute"})
          .setValue(String(s.pollSeconds))
          .onChange(async (v) => {
            s.pollSeconds = Number(v)
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName("Sync")
      .setDesc("Preview shows what a full sync would do, without changing anything.")
      .addButton((b) => b.setButtonText("Preview").onClick(() => void this.plugin.preview()))
      .addButton((b) => b.setButtonText("Show log").onClick(() => new LogModal(this.app, this.plugin).open()))
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            await this.plugin.syncNow()
            this.display()
          })
      )
  }

  private signInSection(el: HTMLElement) {
    new Setting(el)
      .setName("Email")
      .setDesc("We'll send you a sign-in code.")
      .setClass("notebarn-stacked")
      .addText((t) => {
        t.inputEl.type = "email"
        t.setPlaceholder("you@example.com")
          .setValue(this.email)
          .onChange((v) => (this.email = v.trim()))
      })
      .addButton((b) =>
        b
          .setButtonText(this.proofKey ? "Send again" : "Send code")
          .setCta()
          .onClick(async () => {
            try {
              this.proofKey = await anonymousApi(this.plugin.settings.serverUrl).userAuth.beginEmailOwnershipProof(this.email)
              new Notice(`Code sent to ${this.email}.`)
              this.display()
            } catch (e) {
              new Notice(`Couldn't send a code: ${e instanceof Error ? e.message : e}`)
            }
          })
      )
    if (!this.proofKey) return
    new Setting(el)
      .setName("Code")
      .setClass("notebarn-stacked")
      .addText((t) => {
        t.inputEl.inputMode = "numeric"
        t.inputEl.autocomplete = "one-time-code"
        t.setPlaceholder("123456").onChange((v) => (this.code = v.trim()))
      })
      .addButton((b) =>
        b
          .setButtonText("Sign in")
          .setCta()
          .onClick(async () => {
            try {
              const api = anonymousApi(this.plugin.settings.serverUrl)
              const proof = await api.userAuth.proveEmailOwnership({key: this.proofKey!, password: this.code})
              const result = await api.userAuth.logIn([proof])
              if (!result.session) throw new Error("The server didn't start a session.")
              this.plugin.settings.sessionToken = result.session
              this.plugin.settings.email = this.email
              await this.plugin.saveSettings()
              this.plugin.makeApi()
              this.proofKey = null
              this.code = ""
              this.display()
            } catch (e) {
              new Notice(e instanceof HttpError && e.status === 400 ? "That code didn't work." : `Couldn't sign in: ${e instanceof Error ? e.message : e}`)
            }
          })
      )
  }

  private vaultSection(el: HTMLElement) {
    const s = this.plugin.settings
    new Setting(el).setName("Signed in").setDesc(s.email).addButton((b) => b.setButtonText("Sign out").onClick(async () => {
      await this.plugin.signOut()
      this.display()
    }))

    const vaultSetting = new Setting(el)
      .setName("Server vault")
      .setDesc("Which vault on the server this one syncs with. Changing it starts over with a first sync, which never deletes anything.")
    if (this.vaults === null) {
      vaultSetting.addButton((b) => b.setButtonText("Loading…").setDisabled(true))
      this.plugin.api?.vault
        .query({condition: {Always: true}, orderBy: ["name"], limit: 1000})
        .then((v) => {
          this.vaults = v
          this.display()
        })
        .catch((e) => {
          vaultSetting.setDesc(`Couldn't load vaults: ${e instanceof Error ? e.message : e}`)
        })
      return
    }
    vaultSetting.addDropdown((d) => {
      d.addOption("", "Choose…")
      for (const v of this.vaults ?? []) d.addOption(v._id, v.name)
      d.setValue(s.vaultId).onChange(async (id) => {
        s.vaultId = id
        s.vaultName = this.vaults?.find((v) => v._id === id)?.name ?? ""
        await this.plugin.saveSettings()
        await this.plugin.restart()
        this.display()
      })
    })
    vaultSetting.addButton((b) =>
      b.setButtonText("New").onClick(async () => {
        try {
          const vault = await this.plugin.api!.vault.insert({
            _id: crypto.randomUUID() as Vault.ID,
            owner: crypto.randomUUID() as Vault["owner"],
            name: this.app.vault.getName(),
            createdAt: new Date().toISOString(),
            latestVersion: 0
          })
          this.vaults = [...(this.vaults ?? []), vault]
          s.vaultId = vault._id
          s.vaultName = vault.name
          await this.plugin.saveSettings()
          await this.plugin.restart()
          this.display()
        } catch (e) {
          new Notice(`Couldn't create a vault: ${e instanceof Error ? e.message : e}`)
        }
      })
    )
  }
}

class PreviewModal extends Modal {
  constructor(
    app: App,
    private readonly actions: SyncAction[]
  ) {
    super(app)
  }

  onOpen() {
    this.titleEl.setText("Sync preview")
    const el = this.contentEl.createDiv({cls: "notebarn-list"})
    if (this.actions.length === 0) {
      el.createEl("p", {text: "Everything is already in sync.", cls: "notebarn-muted"})
      return
    }
    el.createEl("p", {text: "Nothing has been changed. A full sync would:", cls: "notebarn-muted"})
    const groups = new Map<string, string[]>()
    for (const a of this.actions) groups.set(a.decision, [...(groups.get(a.decision) ?? []), a.path])
    for (const [decision, paths] of groups) {
      el.createDiv({cls: "notebarn-group", text: `${ACTION_LABELS[decision as SyncAction["decision"]]} (${paths.length})`})
      for (const p of paths) el.createDiv({cls: "notebarn-row", text: p})
    }
  }

  onClose() {
    this.contentEl.empty()
  }
}

class LogModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: NotebarnPlugin
  ) {
    super(app)
  }

  onOpen() {
    this.titleEl.setText("Notebarn")
    this.contentEl.createEl("p", {text: this.plugin.statusText})
    const el = this.contentEl.createDiv({cls: "notebarn-list"})
    if (this.plugin.log.length === 0) el.createEl("p", {text: "Nothing has happened yet.", cls: "notebarn-muted"})
    for (const line of [...this.plugin.log].reverse()) el.createDiv({cls: "notebarn-row", text: line})
    if (Platform.isMobile) this.contentEl.createEl("p", {text: "Tip: \"Sync now\" is in the ribbon menu.", cls: "notebarn-muted"})
  }

  onClose() {
    this.contentEl.empty()
  }
}
