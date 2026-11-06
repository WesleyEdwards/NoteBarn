package com.wesleyedwards.notebarn.data

import com.lightningkite.services.database.*
import com.wesleyedwards.notebarn.*
import kotlinx.coroutines.flow.firstOrNull
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlin.time.Clock
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant

/**
 * Keeps earlier copies of notes ([NoteVersion]) so edits and deletes can be undone, without keeping every save: the
 * web app saves less than a second after typing stops, so a copy is taken at most every [EDIT_GAP] while a note is
 * being edited (plus whenever text that had been left alone for [RESTING] is about to change). Copies last
 * [SHORT_KEEP], except the first of each day and deleted notes, which last [LONG_KEEP]. Expired copies are cleared
 * out whenever a new copy is taken in the vault, so there's no scheduled job to run.
 */
object NoteHistory {
    val EDIT_GAP = 10.minutes
    /** Big notes are copied less often, since each copy is big. */
    val BIG_EDIT_GAP = 60.minutes
    const val BIG_NOTE = 200_000
    val RESTING = 2.minutes
    val SHORT_KEEP = 14.days
    val LONG_KEEP = 90.days
    /** Text shorter than this isn't worth compressing. */
    private const val COMPRESS_OVER = 1024

    /** The time now; tests replace it. */
    var now: () -> Instant = { Clock.System.now() }

    /**
     * Takes a copy of [existing] if it's worth keeping, before it's changed or deleted. [always] skips the "not too
     * often" rule (for restoring an old version, so the text it replaces can be got back too).
     */
    suspend fun beforeChange(table: Table<NoteVersion>, existing: Note, reason: VersionReason, always: Boolean = false) {
        if (existing.deleted) return
        val now = now()
        val latest = table.find(
            condition { (it.vault eq existing.vault) and (it.path eq existing.path) },
            orderBy = sort { it.savedAt.descending() },
            limit = 1,
        ).firstOrNull()

        if (latest != null && latest.version == existing.version) {
            // Already have this content. A delete just makes sure it's marked as one, and kept as long.
            if (reason == VersionReason.Delete && latest.reason != VersionReason.Delete) {
                table.updateOneIgnoringResult(
                    condition { it._id eq latest._id },
                    modification {
                        it.reason assign VersionReason.Delete
                        it.savedAt assign now
                        it.expiresAt assign now + LONG_KEEP
                    }
                )
            }
            return
        }
        if (reason == VersionReason.Edit && latest != null && !always) {
            val gap = if (existing.size > BIG_NOTE) BIG_EDIT_GAP else EDIT_GAP
            val resting = now - existing.modifiedAt >= RESTING
            if (now - latest.savedAt < gap && !resting) return
        }

        val firstToday = latest == null || dayOf(latest.savedAt) != dayOf(now)
        val keep = if (reason == VersionReason.Delete || firstToday) LONG_KEEP else SHORT_KEEP
        val packed = if (existing.attachment) null else compress(existing.content)
        table.insertOne(
            NoteVersion(
                owner = existing.owner,
                vault = existing.vault,
                path = existing.path,
                content = packed ?: existing.content,
                compressed = packed != null,
                hash = existing.hash,
                size = existing.size,
                attachment = existing.attachment,
                version = existing.version,
                modifiedAt = existing.modifiedAt,
                savedAt = now,
                reason = reason,
                expiresAt = now + keep,
            )
        )
        table.deleteManyIgnoringOld(condition { (it.vault eq existing.vault) and (it.expiresAt lt now) })
    }

    /** A renamed note takes its history along. */
    suspend fun moved(table: Table<NoteVersion>, vault: Vault.ID, from: String, to: String) {
        table.updateManyIgnoringResult(
            condition { (it.vault eq vault) and (it.path eq from) },
            modification { it.path assign to }
        )
    }

    fun summary(v: NoteVersion) = NoteVersionSummary(v._id, v.path, v.size, v.attachment, v.version, v.modifiedAt, v.savedAt, v.reason)

    fun content(v: NoteVersion) = NoteVersionContent(
        id = v._id,
        path = v.path,
        content = if (v.compressed) decompress(v.content) else v.content,
        hash = v.hash,
        size = v.size,
        attachment = v.attachment,
        version = v.version,
        modifiedAt = v.modifiedAt,
        savedAt = v.savedAt,
        reason = v.reason,
    )

    private fun dayOf(at: Instant) = Math.floorDiv(at.epochSeconds, 86_400L)

    /** Gzipped and in base64, or null when that wouldn't be smaller. */
    fun compress(text: String): String? {
        if (text.length < COMPRESS_OVER) return null
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(text.toByteArray(Charsets.UTF_8)) }
        val packed = Base64.getEncoder().encodeToString(out.toByteArray())
        return packed.takeIf { it.length < text.length }
    }

    fun decompress(packed: String): String =
        GZIPInputStream(Base64.getDecoder().decode(packed).inputStream()).use { it.readBytes().toString(Charsets.UTF_8) }
}
