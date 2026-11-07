package com.wesleyedwards.notebarn.data

import com.lightningkite.lightningserver.NotFoundException
import com.lightningkite.lightningserver.auth.id
import com.lightningkite.lightningserver.auth.noAuth
import com.lightningkite.lightningserver.auth.require
import com.lightningkite.lightningserver.definition.builder.ServerBuilder
import com.lightningkite.lightningserver.http.post
import com.lightningkite.lightningserver.runtime.ServerRuntime
import com.lightningkite.lightningserver.typed.ApiHttpHandler
import com.lightningkite.lightningserver.typed.ModelInfo
import com.lightningkite.lightningserver.typed.ModelRestEndpoints
import com.lightningkite.lightningserver.typed.auth
import com.lightningkite.lightningserver.typed.modelInfo
import com.lightningkite.services.database.*
import com.wesleyedwards.notebarn.*
import com.wesleyedwards.notebarn.data.NoteEndpoints.info
import com.wesleyedwards.notebarn.data.VaultEndpoints.info
import kotlinx.coroutines.flow.toList
import java.net.URLDecoder

/**
 * Links that let anyone read a note (see [Share]). Owners list theirs through the REST endpoints; everything else
 * goes through the endpoints below.
 */
object ShareEndpoints : ServerBuilder() {
    private val info: ModelInfo<User, Share, Share.ID> = Server.database.modelInfo(
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

    val Share.Companion.info get() = this@ShareEndpoints.info

    val rest = path include ModelRestEndpoints(info)

    context(_: ServerRuntime)
    private suspend fun ownedVault(id: Vault.ID, user: User.ID): Vault {
        val vault = Vault.info.table().get(id)
        if (vault == null || vault.owner != user) throw NotFoundException("No such vault.")
        return vault
    }

    val create = path.path("create").post bind ApiHttpHandler(
        summary = "Share Note",
        description = "A link anyone can use to read the note. Sharing a note that's already shared returns its existing link.",
        auth = UserAuth.require(),
        implementation = { input: ShareNote ->
            val vault = ownedVault(input.vault, auth.id)
            val path = NoteEndpoints.normalizePath(input.path)
            val note = Note.info.table().findOne(condition { (it.vault eq vault._id) and (it.path eq path) })
            if (note == null || note.deleted) throw NotFoundException("No note at $path.")
            val table = info.table()
            table.findOne(condition { (it.vault eq vault._id) and (it.path eq path) })
                ?: try {
                    table.insertOne(Share(owner = vault.owner, vault = vault._id, path = path))!!
                } catch (e: UniqueViolationException) {
                    // Shared from another device at the same moment.
                    table.findOne(condition { (it.vault eq vault._id) and (it.path eq path) })!!
                }
        }
    )

    val stop = path.path("stop").post bind ApiHttpHandler(
        summary = "Stop Sharing",
        description = "Turns off the note's link, so it stops working for everyone. Sharing the note again makes a new link.",
        auth = UserAuth.require(),
        implementation = { input: ShareNote ->
            val vault = ownedVault(input.vault, auth.id)
            val path = NoteEndpoints.normalizePath(input.path)
            info.table().deleteManyIgnoringOld(condition { (it.vault eq vault._id) and (it.path eq path) })
            Unit
        }
    )

    val view = path.path("view").post bind ApiHttpHandler(
        summary = "View Shared Note",
        description = "The note a share link points to, as it is now, with links to the files it shows. Doesn't need a login.",
        auth = noAuth,
        implementation = { id: Share.ID ->
            val gone = NotFoundException("This link doesn't work anymore. Its owner may have stopped sharing it.")
            val share = info.table().get(id) ?: throw gone
            val note = Note.info.table().findOne(condition { (it.vault eq share.vault) and (it.path eq share.path) })
            if (note == null || note.deleted || note.attachment) throw gone
            val files = Note.info.table()
                .find(condition { (it.vault eq share.vault) and (it.attachment eq true) and (it.deleted eq false) })
                .toList()
            val byPath = files.associateBy { it.path }
            SharedNote(
                title = note.path.substringAfterLast('/').removeSuffix(".md"),
                content = note.content,
                modifiedAt = note.modifiedAt,
                attachments = embedTargets(note.content).mapNotNull { target ->
                    val file = resolve(target, note.path, byPath.keys) ?: return@mapNotNull null
                    SharedAttachment(target, byPath.getValue(file).hash, NoteEndpoints.blob(share.vault, byPath.getValue(file).hash).signedUrl)
                },
            )
        }
    )

    /** Moves a note's share along when the note is renamed. */
    context(_: ServerRuntime)
    suspend fun moved(vault: Vault.ID, from: String, to: String) {
        info.table().updateManyIgnoringResult(condition { (it.vault eq vault) and (it.path eq from) }, modification { it.path assign to })
    }

    /** Ends a note's share when the note is deleted, so a new note at that path isn't shared by accident. */
    context(_: ServerRuntime)
    suspend fun deleted(vault: Vault.ID, path: String) {
        info.table().deleteManyIgnoringOld(condition { (it.vault eq vault) and (it.path eq path) })
    }

    context(_: ServerRuntime)
    suspend fun vaultDeleted(vault: Vault.ID) {
        info.table().deleteManyIgnoringOld(condition { it.vault eq vault })
    }

    /**
     * The files [content] shows, as their embeds name them: `![[photo.png|300]]` gives `photo.png`, and
     * `![alt](img/my%20photo.png)` gives `img/my photo.png`. Like the web app's Reader, which looks them up by these names.
     */
    fun embedTargets(content: String): Set<String> {
        val wiki = Regex("""!\[\[([^\]\n]+?)\]\]""").findAll(content).map { it.groupValues[1].split('|', '#')[0] }
        val markdown = Regex("""!\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)""").findAll(content)
            .map { it.groupValues[1].removeSurrounding("<", ">") }
            .filterNot { Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE).containsMatchIn(it) }
            .map {
                try {
                    URLDecoder.decode(it.replace("+", "%2B"), Charsets.UTF_8)
                } catch (e: IllegalArgumentException) {
                    it
                }
            }
        return (wiki + markdown).map { it.trim().trimStart('/') }.filter { it.isNotEmpty() }.toSet()
    }

    /**
     * Finds the file [target] in the note at [from] points to among [paths], the way the web app does (resolveWikilink
     * in shared/src/paths.ts, which this must match): the exact path, then relative to the note's folder, then any
     * file with that name, nearest the note first, then the shortest path. Ignores case.
     */
    fun resolve(target: String, from: String, paths: Collection<String>): String? {
        val lower = paths.associateBy { it.lowercase() }
        val folder = from.substringBeforeLast('/', "")
        lower[target.lowercase()]?.let { return it }
        if (folder.isNotEmpty()) lower["$folder/$target".lowercase()]?.let { return it }
        val wanted = "/${target.lowercase()}"
        return paths.filter { it.lowercase().endsWith(wanted) }
            .minWithOrNull(compareBy({ if (it.substringBeforeLast('/', "") == folder) 0 else 1 }, { it.length }, { it }))
    }
}
