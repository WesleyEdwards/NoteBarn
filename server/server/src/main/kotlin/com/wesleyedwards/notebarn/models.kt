package com.wesleyedwards.notebarn

import com.lightningkite.services.data.EmailAddress
import com.lightningkite.services.data.GenerateDataClassPaths
import com.lightningkite.services.data.IndexSet
import com.lightningkite.services.data.IndexUniqueness
import com.lightningkite.services.database.HasId
import com.lightningkite.services.database.TypedId
import kotlinx.serialization.Serializable
import kotlin.time.Clock.System.now
import kotlin.time.Instant
import kotlin.uuid.Uuid


interface HasOwner<T : Comparable<T>> : HasId<T> {
    val owner: User.ID
}

@Serializable
enum class UserRole { User, Admin, Root }

@Serializable
@GenerateDataClassPaths
data class User(
    override val _id: ID = ID(),
    val email: EmailAddress,
    val role: UserRole = UserRole.User,
) : HasId<User.ID> {

    @JvmInline
    @Serializable
    value class ID(override val raw: Uuid = Uuid.random()) : TypedId<Uuid, ID> {
        override fun toString(): String = raw.toString()
    }
}


/**
 * A set of notes, like an Obsidian vault. Every change to a note in the vault takes the next number from
 * [latestVersion], so "everything after version N" is how sync clients catch up.
 */
@Serializable
@GenerateDataClassPaths
data class Vault(
    override val _id: ID = ID(),
    override val owner: User.ID,
    val name: String,
    val createdAt: Instant = now(),
    /** The highest version handed out to a note in this vault. Only changed by NoteEndpoints. */
    val latestVersion: Long = 0,
) : HasOwner<Vault.ID> {

    @JvmInline
    @Serializable
    value class ID(override val raw: Uuid = Uuid.random()) : TypedId<Uuid, ID> {
        override fun toString(): String = raw.toString()
    }
}


/**
 * One file in a vault, identified by its [path] (like `Folder/My note.md`). Deleting a note keeps it as a tombstone
 * ([deleted], empty content) so sync clients learn about the deletion; writing to that path again reuses the record.
 *
 * Attachments (images, PDFs and other non-text files) are notes too, with [attachment] set: their [content] is empty
 * and their bytes are stored in the file system under their [hash] (see NoteEndpoints.blob), so they sync, rename and
 * delete just like text.
 *
 * Only written through NoteEndpoints, which hand out versions and check them, so no change is ever silently lost.
 */
@Serializable
@GenerateDataClassPaths
@IndexSet(["vault", "path"], unique = IndexUniqueness.Unique)
@IndexSet(["vault", "version"])
data class Note(
    override val _id: ID = ID(),
    override val owner: User.ID,
    val vault: Vault.ID,
    val path: String,
    val content: String,
    /**
     * SHA-256 in hex of [content] (as UTF-8), or of an attachment's bytes, so clients can tell whether their copy
     * matches without downloading it.
     */
    val hash: String,
    /** The length of [content] in characters, or of an attachment in bytes. */
    val size: Int = content.length,
    val version: Long,
    val modifiedAt: Instant = now(),
    val deleted: Boolean = false,
    /** A file stored by its [hash] instead of as text in [content]. */
    val attachment: Boolean = false,
) : HasOwner<Note.ID> {

    @JvmInline
    @Serializable
    value class ID(override val raw: Uuid = Uuid.random()) : TypedId<Uuid, ID> {
        override fun toString(): String = raw.toString()
    }
}


/** Writes [content] to [path]. [baseVersion] is the version the edit started from, or null for a new note. */
@Serializable
data class WriteNote(
    val vault: Vault.ID,
    val path: String,
    val content: String,
    val baseVersion: Long? = null,
)

/**
 * Asks where to upload an attachment's bytes before [WriteAttachment]. [hash] is the SHA-256 of the bytes in hex, and
 * [size] their length.
 */
@Serializable
data class AttachmentUpload(
    val vault: Vault.ID,
    val hash: String,
    val size: Long,
)

/** Where to PUT the bytes, or null if the server already has a file with that hash (so there's nothing to send). */
@Serializable
data class AttachmentUploadInfo(
    val uploadUrl: String?,
)

/**
 * Saves the attachment with bytes [hash] (already uploaded) at [path]. [baseVersion] works as in [WriteNote].
 */
@Serializable
data class WriteAttachment(
    val vault: Vault.ID,
    val path: String,
    val hash: String,
    val baseVersion: Long? = null,
)

/** Download links for attachments' bytes, by hash. */
@Serializable
data class AttachmentUrls(
    val vault: Vault.ID,
    val hashes: List<String>,
)

/** Deletes [path]. With a [baseVersion], only if nobody has changed the note since that version. */
@Serializable
data class DeleteNote(
    val vault: Vault.ID,
    val path: String,
    val baseVersion: Long? = null,
)

/** Moves [from] to [to], which must not already be a note. With a [baseVersion], only if [from] is still at it. */
@Serializable
data class RenameNote(
    val vault: Vault.ID,
    val from: String,
    val to: String,
    val baseVersion: Long? = null,
)

/**
 * The result of a write, delete or rename. On success [note] is the note as now saved. On a conflict (someone else
 * changed it since the client's base version) [note] is the server's current copy, so the client can merge.
 */
@Serializable
data class WriteResult(
    val success: Boolean,
    val note: Note?,
)

@Serializable
data class ChangesRequest(
    val vault: Vault.ID,
    /** The last version the client has seen; 0 for everything. */
    val since: Long,
    val limit: Int = 500,
)

/**
 * Notes (including tombstones) changed after the request's `since`, oldest first. Ask again from [cursor] while
 * [hasMore].
 */
@Serializable
data class ChangesResponse(
    val notes: List<Note>,
    val cursor: Long,
    val hasMore: Boolean,
    val latestVersion: Long,
)

/**
 * Sent over the Live Changes websocket when a vault changes: its newest note version. The message is only a nudge;
 * the client then asks Note Changes for what changed, so nothing it misses here is lost.
 */
@Serializable
data class VaultChanged(
    val vault: Vault.ID,
    val latestVersion: Long,
)

/** Every note in a vault without its content: enough to draw a file tree or check a sync client's copy. */
@Serializable
data class NoteSummary(
    val path: String,
    val version: Long,
    val hash: String,
    val size: Int,
    val modifiedAt: Instant,
    val deleted: Boolean,
    val attachment: Boolean = false,
)

@Serializable
data class Manifest(
    val notes: List<NoteSummary>,
    val latestVersion: Long,
)

@Serializable
data class SearchNotes(
    val vault: Vault.ID,
    val query: String,
    val limit: Int = 50,
)

@Serializable
data class SearchHit(
    val path: String,
    /** A line of text around the first match in the content, or null if only the path matched. */
    val snippet: String?,
)

@Serializable
data class ReadNote(
    val vault: Vault.ID,
    val path: String,
)


/** Why a [NoteVersion] was kept. */
@Serializable
enum class VersionReason {
    /** The note was about to be changed. */
    Edit,

    /** The note was deleted; this is what it held. */
    Delete,
}

/**
 * An earlier copy of a note, kept so a bad edit or a delete can be undone (see NoteHistory). Copies are taken at most
 * every so often while a note is being edited, and each is deleted at [expiresAt]. When a note is renamed, its
 * history moves with it.
 */
@Serializable
@GenerateDataClassPaths
@IndexSet(["vault", "path", "savedAt"])
@IndexSet(["vault", "expiresAt"])
@IndexSet(["vault", "reason", "savedAt"])
data class NoteVersion(
    override val _id: ID = ID(),
    override val owner: User.ID,
    val vault: Vault.ID,
    val path: String,
    /** The note's text, gzipped and in base64 when [compressed]. Empty for an attachment. */
    val content: String,
    val compressed: Boolean = false,
    val hash: String,
    val size: Int,
    val attachment: Boolean = false,
    /** The note's version while it held this. */
    val version: Long,
    /** When the note was saved with this content. */
    val modifiedAt: Instant,
    /** When this copy was taken (when the content was replaced or deleted). */
    val savedAt: Instant,
    val reason: VersionReason,
    val expiresAt: Instant,
) : HasOwner<NoteVersion.ID> {

    @JvmInline
    @Serializable
    value class ID(override val raw: Uuid = Uuid.random()) : TypedId<Uuid, ID> {
        override fun toString(): String = raw.toString()
    }
}

/** One entry in a note's history, without its content. */
@Serializable
data class NoteVersionSummary(
    val id: NoteVersion.ID,
    val path: String,
    val size: Int,
    val attachment: Boolean,
    val version: Long,
    val modifiedAt: Instant,
    val savedAt: Instant,
    val reason: VersionReason,
)

/** An earlier copy of a note, with its content. */
@Serializable
data class NoteVersionContent(
    val id: NoteVersion.ID,
    val path: String,
    val content: String,
    val hash: String,
    val size: Int,
    val attachment: Boolean,
    val version: Long,
    val modifiedAt: Instant,
    val savedAt: Instant,
    val reason: VersionReason,
)

@Serializable
data class NoteHistoryRequest(
    val vault: Vault.ID,
    val path: String,
)

@Serializable
data class ReadVersion(
    val vault: Vault.ID,
    val id: NoteVersion.ID,
)

/**
 * Puts an earlier copy back at its note's path. [baseVersion] is the note's current version as the client knows it
 * (null if it's deleted), as for [WriteNote].
 */
@Serializable
data class RestoreVersion(
    val vault: Vault.ID,
    val id: NoteVersion.ID,
    val baseVersion: Long? = null,
)


/**
 * A link anyone can use to read one note, as it is whenever they open it, until its owner stops sharing it. The
 * [_id] is the link's secret. When the note is renamed in the web app the share follows it; deleting the note ends it.
 */
@Serializable
@GenerateDataClassPaths
@IndexSet(["vault", "path"], unique = IndexUniqueness.Unique)
data class Share(
    override val _id: ID = ID(),
    override val owner: User.ID,
    val vault: Vault.ID,
    val path: String,
    val createdAt: Instant = now(),
) : HasOwner<Share.ID> {

    @JvmInline
    @Serializable
    value class ID(override val raw: Uuid = Uuid.random()) : TypedId<Uuid, ID> {
        override fun toString(): String = raw.toString()
    }
}

@Serializable
data class ShareNote(
    val vault: Vault.ID,
    val path: String,
)

/** A shared note as anyone with its link sees it: its name but not its folder, and only the files it shows. */
@Serializable
data class SharedNote(
    val title: String,
    val content: String,
    val modifiedAt: Instant,
    val attachments: List<SharedAttachment>,
)

/** A file a shared note shows, by the [target] its embed names (like `photo.png` in `![[photo.png]]`). */
@Serializable
data class SharedAttachment(
    val target: String,
    val hash: String,
    /** A download link that lasts an hour. */
    val url: String,
)

/** What the admin page shows: how many of each thing there are, and how much room the database takes. */
@Serializable
data class AdminStats(
    val users: Int,
    val vaults: Int,
    val notes: Int,
    val noteVersions: Int,
    val shares: Int,
    /** `null` when the database isn't MongoDB, like in local development. */
    val storage: DatabaseStorage?,
)

/** Sizes in bytes, from MongoDB's dbStats. [dataSize] is uncompressed; [storageSize] is what's on disk. */
@Serializable
data class DatabaseStorage(
    val dataSize: Long,
    val indexSize: Long,
    val storageSize: Long,
)
