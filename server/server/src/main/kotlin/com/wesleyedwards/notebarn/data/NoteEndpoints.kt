package com.wesleyedwards.notebarn.data

import com.lightningkite.lightningserver.BadRequestException
import com.lightningkite.lightningserver.NotFoundException
import com.lightningkite.lightningserver.auth.id
import com.lightningkite.lightningserver.auth.require
import com.lightningkite.lightningserver.definition.builder.ServerBuilder
import com.lightningkite.lightningserver.http.post
import com.lightningkite.lightningserver.pathing.PathSpec0
import com.lightningkite.lightningserver.runtime.send
import com.lightningkite.lightningserver.typed.ApiWebsocketHandler
import com.lightningkite.lightningserver.websockets.request
import com.lightningkite.lightningserver.runtime.ServerRuntime
import com.lightningkite.lightningserver.typed.ApiHttpHandler
import com.lightningkite.lightningserver.typed.ModelInfo
import com.lightningkite.lightningserver.typed.ModelRestEndpoints
import com.lightningkite.lightningserver.typed.auth
import com.lightningkite.lightningserver.typed.modelInfo
import com.lightningkite.services.database.*
import com.wesleyedwards.notebarn.*
import com.wesleyedwards.notebarn.data.VaultEndpoints.info
import com.lightningkite.services.files.FileObject
import kotlinx.coroutines.flow.toList
import java.security.MessageDigest
import kotlin.time.Clock
import kotlin.time.Duration.Companion.hours
import kotlin.uuid.Uuid

/** Largest note accepted, in characters. Lambda caps a response at 6MB, and a changes page may hold a few notes. */
const val MAX_NOTE_SIZE = 2_000_000

/** Roughly how much content one page of changes may carry before it stops early. */
private const val CHANGES_PAGE_BUDGET = 3_000_000

/** Largest attachment accepted, in bytes. Its bytes go straight to the file system, not through the server's requests. */
const val MAX_ATTACHMENT_SIZE = 100_000_000L

/** How long upload and download links for attachments last. */
private val ATTACHMENT_URL_DURATION = 1.hours

private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

/** What a note holds: text, or an attachment's hash and size. */
private class Body(val content: String, val hash: String, val size: Int, val attachment: Boolean) {
    companion object {
        fun text(content: String) = Body(content, sha256Hex(content), content.length, false)
        fun of(note: Note) = Body(note.content, note.hash, note.size, note.attachment)
    }
}

object NoteEndpoints : ServerBuilder() {
    /**
     * Reading notes is open to their owner through the usual REST endpoints. Every write goes through the endpoints
     * below instead, which hand out versions and refuse to overwrite a change the writer hasn't seen.
     */
    private val info: ModelInfo<User, Note, Note.ID> = Server.database.modelInfo(
        auth = UserAuth.require(),
        permissions = {
            ModelPermissions(
                create = Condition.Never,
                read = condition { it.owner eq auth.id },
                update = Condition.Never,
                delete = Condition.Never,
            )
        },
    )

    val Note.Companion.info get() = this@NoteEndpoints.info

    /** Earlier copies of notes (see [NoteHistory]). Only read through the endpoints below, never written by clients. */
    private val historyInfo: ModelInfo<User, NoteVersion, NoteVersion.ID> = Server.database.modelInfo(
        auth = UserAuth.require(),
        permissions = {
            ModelPermissions(
                create = Condition.Never,
                read = Condition.Never,
                update = Condition.Never,
                delete = Condition.Never,
            )
        },
    )

    val NoteVersion.Companion.info get() = this@NoteEndpoints.historyInfo

    val rest = path include ModelRestEndpoints(info)

    /** Where a vault's [VaultChanged] nudges are published, for the Live Changes connections watching it. */
    val vaultChanged = path.path("vault-changed").arg<Vault.ID>("vault").topic(VaultChanged.serializer())

    init {
        // Every note write goes through info.table(), so this hears all of them, after they've landed.
        info.registerChangeListener { changes ->
            changes.changes.mapNotNull { it.new }.groupBy { it.vault }.forEach { (vault, notes) ->
                vaultChanged.send(vault, VaultChanged(vault, notes.maxOf { it.version }))
            }
        }
    }

    val live = path.path("live") bind ApiWebsocketHandler<PathSpec0, Vault.ID, User, String, VaultChanged>(
        summary = "Live Changes",
        description = "Connect with ?vault=<id> to hear a VaultChanged whenever a note in that vault changes, then ask Note Changes for what changed. Ask once when the connection opens too, since anything before it isn't sent. Any message sent to the server is ignored, which keeps the connection from idling out.",
        auth = UserAuth.require(),
        willConnectType = { access ->
            val raw = access.request.queryParameters["vault"] ?: throw BadRequestException("Say which vault to watch, with ?vault=.")
            val id = try {
                Vault.ID(Uuid.parse(raw))
            } catch (e: IllegalArgumentException) {
                throw BadRequestException("That isn't a vault ID.")
            }
            ownedVault(id, access.auth.id)._id
        },
        didConnectType = { subscribe(vaultChanged.request(currentState)) },
        topicHandlersType = { vaultChanged bind { send(it.value) } },
    )

    /**
     * Cleans up a path into the form notes are stored under: forward slashes, no leading or trailing slash, no empty,
     * `.` or `..` parts.
     */
    fun normalizePath(raw: String): String {
        val parts = raw.replace('\\', '/').split('/').filter { it.isNotEmpty() }
        if (parts.any { it.isBlank() }) throw BadRequestException("A path can't have a blank folder or file name.")
        if (parts.isEmpty()) throw BadRequestException("A note needs a path.")
        if (parts.any { it == "." || it == ".." }) throw BadRequestException("A path can't contain '.' or '..' parts.")
        if (parts.any { p -> p.any { it.code < 32 } }) throw BadRequestException("A path can't contain control characters.")
        val path = parts.joinToString("/")
        if (path.length > 1024) throw BadRequestException("That path is too long.")
        return path
    }

    context(_: ServerRuntime)
    private suspend fun ownedVault(id: Vault.ID, user: User.ID): Vault {
        val vault = Vault.info.table().get(id)
        if (vault == null || vault.owner != user) throw NotFoundException("No such vault.")
        return vault
    }

    /** Hands out the vault's next version. Versions skipped by a failed write are just never used. */
    context(_: ServerRuntime)
    private suspend fun nextVersion(vault: Vault.ID): Long =
        Vault.info.table().updateOne(condition { it._id eq vault }, modification { it.latestVersion += 1L }).new?.latestVersion
            ?: throw NotFoundException("No such vault.")

    /** Where an attachment's bytes are kept: by vault and hash, so the same file is only ever stored once per vault. */
    context(_: ServerRuntime)
    fun blob(vault: Vault.ID, hash: String): FileObject {
        if (!SHA256_HEX.matches(hash)) throw BadRequestException("An attachment's hash must be a SHA-256 in lowercase hex.")
        return Server.files().root.then("attachments/$vault/$hash")
    }

    /** The SHA-256 (hex) and length of a stored file's bytes, read in pieces so a big file doesn't fill memory. */
    context(_: ServerRuntime)
    private suspend fun hashOf(file: FileObject): Pair<String, Long>? {
        val data = file.get() ?: return null
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        data.data.source().use { source ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = source.readAtMostTo(buffer, 0, buffer.size)
                if (read <= 0) break
                digest.update(buffer, 0, read)
                size += read
                if (size > MAX_ATTACHMENT_SIZE) throw BadRequestException("That attachment is too big to save.")
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) } to size
    }

    context(_: ServerRuntime)
    private suspend fun find(vault: Vault.ID, path: String): Note? =
        info.table().findOne(condition { (it.vault eq vault) and (it.path eq path) })

    /**
     * Saves [content] at [path] in place of [existing], but only if the note is still exactly [existing] (nothing
     * changed it in between). Returns null if it changed.
     */
    context(_: ServerRuntime)
    private suspend fun put(vault: Vault, path: String, body: Body, existing: Note?, keepCopy: Boolean = false): Note? {
        if (existing != null) NoteHistory.beforeChange(historyInfo.table(), existing, VersionReason.Edit, always = keepCopy)
        val version = nextVersion(vault._id)
        val now = Clock.System.now()
        if (existing == null) {
            return try {
                info.table().insertOne(
                    Note(
                        owner = vault.owner,
                        vault = vault._id,
                        path = path,
                        content = body.content,
                        hash = body.hash,
                        size = body.size,
                        version = version,
                        modifiedAt = now,
                        attachment = body.attachment,
                    )
                )
            } catch (e: UniqueViolationException) {
                null // Someone created it at the same moment.
            }
        }
        return info.table().updateOne(
            condition { (it._id eq existing._id) and (it.version eq existing.version) },
            modification {
                it.path assign path
                it.content assign body.content
                it.hash assign body.hash
                it.size assign body.size
                it.version assign version
                it.modifiedAt assign now
                it.deleted assign false
                it.attachment assign body.attachment
            }
        ).new
    }

    context(_: ServerRuntime)
    private suspend fun tombstone(existing: Note, vault: Vault.ID, keepCopy: Boolean = true): Note? {
        if (keepCopy) NoteHistory.beforeChange(historyInfo.table(), existing, VersionReason.Delete)
        val version = nextVersion(vault)
        return info.table().updateOne(
            condition { (it._id eq existing._id) and (it.version eq existing.version) },
            modification {
                it.content assign ""
                it.hash assign sha256Hex("")
                it.size assign 0
                it.version assign version
                it.modifiedAt assign Clock.System.now()
                it.deleted assign true
            }
        ).new
    }

    val write = path.path("write").post bind ApiHttpHandler(
        summary = "Write Note",
        description = "Creates or updates a note. The write only succeeds if the note is still at baseVersion (or, with no baseVersion, doesn't exist yet); otherwise the result has success = false and the server's current note, to merge with. Writing the content the note already has always succeeds. Writing to a deleted note brings it back.",
        auth = UserAuth.require(),
        implementation = { input: WriteNote ->
            if (input.content.length > MAX_NOTE_SIZE) throw BadRequestException("That note is too big to save.")
            val vault = ownedVault(input.vault, auth.id)
            save(vault, normalizePath(input.path), Body.text(input.content), input.baseVersion)
        }
    )

    /** Saves [body] at [path] if the note there is still at [baseVersion] (see [write]). */
    context(_: ServerRuntime)
    private suspend fun save(vault: Vault, path: String, body: Body, baseVersion: Long?, keepCopy: Boolean = false): WriteResult {
        // A few tries, in case another write lands between reading the note and saving over it.
        repeat(3) {
            val existing = find(vault._id, path)
            if (existing != null && !existing.deleted) {
                if (existing.hash == body.hash && existing.attachment == body.attachment) return WriteResult(true, existing)
                if (existing.version != baseVersion) return WriteResult(false, existing)
            }
            put(vault, path, body, existing, keepCopy)?.let { return WriteResult(true, it) }
        }
        return WriteResult(false, find(vault._id, path))
    }

    val attachmentUpload = path.path("attachment-upload").post bind ApiHttpHandler(
        summary = "Attachment Upload",
        description = "Where to PUT an attachment's bytes (a link that lasts an hour), before calling Write Attachment. The link is null when the server already has a file with that hash, so there's nothing to upload.",
        auth = UserAuth.require(),
        implementation = { input: AttachmentUpload ->
            val vault = ownedVault(input.vault, auth.id)
            if (input.size > MAX_ATTACHMENT_SIZE) throw BadRequestException("That attachment is too big to save.")
            val file = blob(vault._id, input.hash)
            AttachmentUploadInfo(if (file.head() != null) null else file.uploadUrl(ATTACHMENT_URL_DURATION))
        }
    )

    val writeAttachment = path.path("write-attachment").post bind ApiHttpHandler(
        summary = "Write Attachment",
        description = "Creates or updates an attachment whose bytes were already uploaded (see Attachment Upload). Checks the uploaded bytes match the hash. Otherwise works just like Write Note.",
        auth = UserAuth.require(),
        implementation = { input: WriteAttachment ->
            val vault = ownedVault(input.vault, auth.id)
            val path = normalizePath(input.path)
            val file = blob(vault._id, input.hash)
            // Bytes that some note in this vault already uses were checked when it was saved.
            val known = info.table().findOne(
                condition { (it.vault eq vault._id) and (it.hash eq input.hash) and (it.attachment eq true) and (it.deleted eq false) }
            )
            val size = known?.size?.toLong() ?: run {
                val (hash, size) = hashOf(file) ?: throw BadRequestException("The attachment's bytes haven't been uploaded.")
                if (hash != input.hash) {
                    file.delete()
                    throw BadRequestException("The uploaded bytes don't match their hash. Upload them again.")
                }
                size
            }
            save(vault, path, Body("", input.hash, size.toInt(), true), input.baseVersion)
        }
    )

    val attachmentUrls = path.path("attachment-urls").post bind ApiHttpHandler(
        summary = "Attachment Links",
        description = "Download links (lasting an hour) for attachments' bytes, by hash, in the order asked for.",
        auth = UserAuth.require(),
        implementation = { input: AttachmentUrls ->
            val vault = ownedVault(input.vault, auth.id)
            if (input.hashes.size > 1000) throw BadRequestException("Ask for at most 1000 links at a time.")
            input.hashes.map { blob(vault._id, it).signedUrl }
        }
    )

    val delete = path.path("delete").post bind ApiHttpHandler(
        summary = "Delete Note",
        description = "Deletes a note, leaving a tombstone so sync clients delete it too. With a baseVersion, only deletes if nobody has changed the note since; otherwise the result has success = false and the current note.",
        auth = UserAuth.require(),
        implementation = { input: DeleteNote ->
            val vault = ownedVault(input.vault, auth.id)
            val path = normalizePath(input.path)
            val existing = find(vault._id, path)
            when {
                existing == null -> throw NotFoundException("No note at $path.")
                existing.deleted -> WriteResult(true, existing)
                input.baseVersion != null && existing.version != input.baseVersion -> WriteResult(false, existing)
                else -> tombstone(existing, vault._id)?.let {
                    ShareEndpoints.deleted(vault._id, path)
                    WriteResult(true, it)
                } ?: WriteResult(false, find(vault._id, path))
            }
        }
    )

    val rename = path.path("rename").post bind ApiHttpHandler(
        summary = "Rename Note",
        description = "Moves a note to a new path, which must not already have a note. Sync clients see the old path deleted and the new one created. With a baseVersion, only if the note hasn't changed since.",
        auth = UserAuth.require(),
        implementation = { input: RenameNote ->
            val vault = ownedVault(input.vault, auth.id)
            val from = normalizePath(input.from)
            val to = normalizePath(input.to)
            val existing = find(vault._id, from)
            if (existing == null || existing.deleted) throw NotFoundException("No note at $from.")
            if (input.baseVersion != null && existing.version != input.baseVersion) return@ApiHttpHandler WriteResult(false, existing)
            if (from == to) return@ApiHttpHandler WriteResult(true, existing)
            val target = find(vault._id, to)
            if (target != null && !target.deleted) throw BadRequestException("There's already a note at $to.")
            val moved = put(vault, to, Body.of(existing), target) ?: throw BadRequestException("There's already a note at $to.")
            // The content lives on at the new path, so there's nothing to keep a copy of; its history goes along.
            tombstone(existing, vault._id, keepCopy = false)
            NoteHistory.moved(historyInfo.table(), vault._id, from, to)
            ShareEndpoints.moved(vault._id, from, to)
            WriteResult(true, moved)
        }
    )

    val changes = path.path("changes").post bind ApiHttpHandler(
        summary = "Note Changes",
        description = "Notes changed (including deletions) after version `since`, oldest first. Keep asking from `cursor` while `hasMore`. Versions are handed out just before a write lands, so a client should occasionally compare against the manifest too.",
        auth = UserAuth.require(),
        implementation = { input: ChangesRequest ->
            val vault = ownedVault(input.vault, auth.id)
            val limit = input.limit.coerceIn(1, 1000)
            val found = info.table().find(
                condition { (it.vault eq vault._id) and (it.version gt input.since) },
                orderBy = sort { it.version.ascending() },
                limit = limit + 1,
            ).toList()
            val page = ArrayList<Note>()
            var budget = CHANGES_PAGE_BUDGET
            for (note in found.take(limit)) {
                val weight = if (note.attachment) 0 else note.size
                if (page.isNotEmpty() && weight > budget) break
                page.add(note)
                budget -= weight
            }
            ChangesResponse(
                notes = page,
                cursor = page.lastOrNull()?.version ?: input.since,
                hasMore = page.size < found.size,
                latestVersion = vault.latestVersion,
            )
        }
    )

    val manifest = path.path("manifest").post bind ApiHttpHandler(
        summary = "Vault Manifest",
        description = "Every note in the vault, deleted ones included, without content: path, version, hash and size.",
        auth = UserAuth.require(),
        implementation = { vaultId: Vault.ID ->
            val vault = ownedVault(vaultId, auth.id)
            val notes = info.table().find(condition { it.vault eq vault._id }).toList()
            Manifest(
                notes = notes.map { NoteSummary(it.path, it.version, it.hash, it.size, it.modifiedAt, it.deleted, it.attachment) }
                    .sortedBy { it.path.lowercase() },
                latestVersion = notes.maxOfOrNull { it.version }?.coerceAtLeast(vault.latestVersion) ?: vault.latestVersion,
            )
        }
    )

    val history = path.path("history").post bind ApiHttpHandler(
        summary = "Note History",
        description = "Earlier copies of the note at a path, newest first, without their content (see Note Version).",
        auth = UserAuth.require(),
        implementation = { input: NoteHistoryRequest ->
            val vault = ownedVault(input.vault, auth.id)
            val path = normalizePath(input.path)
            historyInfo.table().find(
                condition { (it.vault eq vault._id) and (it.path eq path) },
                orderBy = sort { it.savedAt.descending() },
                limit = 500,
            ).toList().map(NoteHistory::summary)
        }
    )

    val version = path.path("version").post bind ApiHttpHandler(
        summary = "Note Version",
        description = "One earlier copy of a note, with its content. To restore it, write it back like any edit.",
        auth = UserAuth.require(),
        implementation = { input: ReadVersion ->
            val vault = ownedVault(input.vault, auth.id)
            val found = historyInfo.table().get(input.id)
            if (found == null || found.vault != vault._id) throw NotFoundException("That version isn't there anymore.")
            NoteHistory.content(found)
        }
    )

    val restore = path.path("restore").post bind ApiHttpHandler(
        summary = "Restore Version",
        description = "Puts an earlier copy of a note back, like writing it (baseVersion works the same way). What it replaces is always kept in the history, so a restore can be undone too.",
        auth = UserAuth.require(),
        implementation = { input: RestoreVersion ->
            val vault = ownedVault(input.vault, auth.id)
            val found = historyInfo.table().get(input.id)
            if (found == null || found.vault != vault._id) throw NotFoundException("That version isn't there anymore.")
            val body = if (found.attachment) {
                if (blob(vault._id, found.hash).head() == null) throw BadRequestException("That file's contents aren't on the server anymore.")
                Body("", found.hash, found.size, true)
            } else {
                Body.text(NoteHistory.content(found).content)
            }
            save(vault, found.path, body, input.baseVersion, keepCopy = true)
        }
    )

    val recentlyDeleted = path.path("deleted").post bind ApiHttpHandler(
        summary = "Recently Deleted",
        description = "Notes deleted in the last 90 days that haven't come back since, newest first: the last copy of each.",
        auth = UserAuth.require(),
        implementation = { vaultId: Vault.ID ->
            val vault = ownedVault(vaultId, auth.id)
            val gone = info.table().find(condition { (it.vault eq vault._id) and (it.deleted eq true) }).toList().map { it.path }.toSet()
            historyInfo.table().find(
                condition { (it.vault eq vault._id) and (it.reason eq VersionReason.Delete) },
                orderBy = sort { it.savedAt.descending() },
                limit = 2000,
            ).toList()
                .filter { it.path in gone }
                .distinctBy { it.path }
                .map(NoteHistory::summary)
        }
    )

    val read = path.path("read").post bind ApiHttpHandler(
        summary = "Read Note",
        description = "The note at a path, or null if there isn't one (or it was deleted).",
        auth = UserAuth.require(),
        implementation = { input: ReadNote ->
            val vault = ownedVault(input.vault, auth.id)
            find(vault._id, normalizePath(input.path))?.takeUnless { it.deleted }
        }
    )

    val search = path.path("search").post bind ApiHttpHandler(
        summary = "Search Notes",
        description = "Notes whose path or content contains the query (ignoring case), with a line of context.",
        auth = UserAuth.require(),
        implementation = { input: SearchNotes ->
            val vault = ownedVault(input.vault, auth.id)
            val q = input.query.trim()
            if (q.isEmpty()) return@ApiHttpHandler emptyList<SearchHit>()
            val found = info.table().find(
                condition { (it.vault eq vault._id) and (it.deleted eq false) and ((it.path contains q) or ((it.attachment eq false) and (it.content contains q))) },
                limit = input.limit.coerceIn(1, 200),
            ).toList()
            // Notes whose name matches come first.
            found.sortedBy { if (it.path.contains(q, ignoreCase = true)) 0 else 1 }
                .map { SearchHit(it.path, snippet(it.content, q)) }
        }
    )

    /** The line around the first match of [q] in [content], trimmed to a readable length. */
    fun snippet(content: String, q: String): String? {
        val at = content.indexOf(q, ignoreCase = true)
        if (at < 0) return null
        val lineStart = content.lastIndexOf('\n', at).let { if (it < 0) 0 else it + 1 }
        val lineEnd = content.indexOf('\n', at).let { if (it < 0) content.length else it }
        val start = maxOf(lineStart, at - 60)
        val end = minOf(lineEnd, at + q.length + 100)
        return (if (start > lineStart) "…" else "") + content.substring(start, end).trim() + (if (end < lineEnd) "…" else "")
    }
}
