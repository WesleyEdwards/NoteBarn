package com.wesleyedwards.notebarn.data

import com.lightningkite.lightningserver.definition.ScheduledTask
import com.lightningkite.lightningserver.runtime.ServerRuntime
import com.lightningkite.services.data.MediaType
import com.lightningkite.services.data.TypedData
import com.lightningkite.services.database.Condition
import com.lightningkite.services.email.Email
import com.lightningkite.services.email.EmailAddressWithName
import com.wesleyedwards.notebarn.*
import com.wesleyedwards.notebarn.data.NoteEndpoints.info
import com.wesleyedwards.notebarn.data.ShareEndpoints.info
import com.wesleyedwards.notebarn.data.UserEndpoints.info
import com.wesleyedwards.notebarn.data.VaultEndpoints.info
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withContext
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.Serializable
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/**
 * Everything in the database worth keeping, as one gzipped JSON file per day in [Server.backups]. Attachments' bytes
 * aren't included: they're already in their own file store. Login sessions aren't either; you just log in again.
 */
object Backups {
    const val KEEP = 30

    @Serializable
    data class Backup(
        val users: List<User>,
        val vaults: List<Vault>,
        val notes: List<Note>,
        val noteVersions: List<NoteVersion>,
        val shares: List<Share>,
    )

    /** Saves today's backup (replacing one already taken today) and deletes all but the newest [KEEP]. */
    context(server: ServerRuntime)
    suspend fun take() {
        // Claude: baseTable skips the models' signals, so nothing else happens on read or restore.
        val backup = Backup(
            users = User.info.baseTable().find(Condition.Always).toList(),
            vaults = Vault.info.baseTable().find(Condition.Always).toList(),
            notes = Note.info.baseTable().find(Condition.Always).toList(),
            noteVersions = NoteVersion.info.baseTable().find(Condition.Always).toList(),
            shares = Share.info.baseTable().find(Condition.Always).toList(),
        )
        val out = ByteArrayOutputStream()
        withContext(Dispatchers.IO) {
            GZIPOutputStream(out).use {
                it.write(
                    server.internalSerialization.json.encodeToString(backup).toByteArray()
                )
            }
        }

        val today = server.clock.now().toLocalDateTime(TimeZone.UTC).date
        val root = Server.backups().root
        root.then("$today.json.gz").put(TypedData.bytes(out.toByteArray(), MediaType.Application.OctetStream))
        // Claude: names are ISO dates, so sorting by name sorts by age.
        root.list()?.sortedByDescending { it.name }?.drop(KEEP)?.forEach { it.delete() }
    }

    /**
     * Loads a backup made by [take] into this server's database.
     *
     * Refuses unless the database is empty, so it can't mix a backup into live data.
     */
    context(server: ServerRuntime)
    suspend fun restore(gzipped: ByteArray) {
        val text = withContext(Dispatchers.IO) {
            GZIPInputStream(gzipped.inputStream()).use { it.readBytes().toString(Charsets.UTF_8) }
        }
        val backup = server.internalSerialization.json.decodeFromString<Backup>(text)
        check(
            User.info.baseTable().count() == 0 &&
                Vault.info.baseTable().count() == 0 &&
                Note.info.baseTable().count() == 0 &&
                NoteVersion.info.baseTable().count() == 0 &&
                Share.info.baseTable().count() == 0
        ) { "The database already has data. Restore only into an empty one." }
        User.info.baseTable().insert(backup.users)
        Vault.info.baseTable().insert(backup.vaults)
        Note.info.baseTable().insert(backup.notes)
        NoteVersion.info.baseTable().insert(backup.noteVersions)
        Share.info.baseTable().insert(backup.shares)
    }

    /**
     * Emails the admins that the nightly backup (or the attachment cleanup after it) failed. The Lambda adapter turns a
     * scheduled task's exception into a quiet 500, so without this nobody would hear about it.
     */
    context(_: ServerRuntime)
    suspend fun reportFailure(e: Exception) {
        val to = Server.admins().map { EmailAddressWithName(it) }
        if (to.isEmpty()) return
        val trace = e.stackTraceToString()
        Server.email().send(
            Email(
                subject = "Notebarn's nightly backup failed",
                to = to,
                html = "<p>Tonight's backup or attachment cleanup failed:</p><pre>${trace.replace("&", "&amp;").replace("<", "&lt;")}</pre>",
                plainText = "Tonight's backup or attachment cleanup failed:\n\n$trace",
            )
        )
    }
}

// Claude: AWS runs schedules in UTC whatever zone is given here.
val BackupTask = ScheduledTask(LocalTime(10, 0), TimeZone.UTC) {
    try {
        Backups.take()
        NoteEndpoints.deleteUnusedAttachments()
    } catch (e: Exception) {
        Backups.reportFailure(e)
        throw e
    }
}