package com.wesleyedwards.notebarn

import com.lightningkite.lightningserver.BadRequestException
import com.lightningkite.lightningserver.NotFoundException
import com.lightningkite.lightningserver.auth.Authentication
import com.lightningkite.lightningserver.auth.testAuth
import com.lightningkite.lightningserver.runtime.test.TestRunner
import com.lightningkite.lightningserver.runtime.test.testBlocking
import com.lightningkite.lightningserver.settings.set
import com.lightningkite.lightningserver.typed.test
import com.lightningkite.services.cache.Cache
import com.lightningkite.services.data.MediaType
import com.lightningkite.services.data.TypedData
import com.lightningkite.services.data.toEmailAddress
import com.lightningkite.services.database.*
import com.lightningkite.services.files.PublicFileSystem
import com.wesleyedwards.notebarn.data.AdminEndpoints
import com.wesleyedwards.notebarn.data.NoteEndpoints
import com.wesleyedwards.notebarn.data.UserEndpoints.info
import com.wesleyedwards.notebarn.data.VaultEndpoints
import com.wesleyedwards.notebarn.data.VaultEndpoints.info
import java.security.MessageDigest
import kotlin.test.*

class NoteEndpointsTest {
    context(_: TestRunner<*>)
    private suspend fun setUp(email: String = "me@test.com"): Pair<Authentication<User>, Vault> {
        val user = User.info.table().insertOne(User(email = email.toEmailAddress()))!!
        val auth = UserAuth.testAuth(user)
        val vault = VaultEndpoints.rest.insert.test(auth, Vault(owner = user._id, name = "Personal"))
        return auth to vault
    }

    private fun testServer(action: suspend context(TestRunner<Server>) Server.() -> Unit) = Server.testBlocking(
        settings = {
            database set Database.Settings("ram")
            cache set Cache.Settings("ram")
            files set PublicFileSystem.Settings("file://${kotlin.io.path.createTempDirectory("notebarn-files")}?serveUrl=files")
        },
        action = action,
    )

    @Test
    fun `creating and updating a note bumps its version`() = testServer {
        val (auth, vault) = setUp()
        val created = NoteEndpoints.write.test(auth, WriteNote(vault._id, "Folder/A.md", "hello"))
        assertTrue(created.success)
        val v1 = created.note!!.version
        assertEquals("Folder/A.md", created.note!!.path)
        assertEquals(sha256Hex("hello"), created.note!!.hash)

        val updated = NoteEndpoints.write.test(auth, WriteNote(vault._id, "Folder/A.md", "hello world", baseVersion = v1))
        assertTrue(updated.success)
        assertTrue(updated.note!!.version > v1)
        assertEquals("hello world", updated.note!!.content)
    }

    @Test
    fun `a write from a stale version is a conflict and returns the current note`() = testServer {
        val (auth, vault) = setUp()
        val v1 = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "one")).note!!.version
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "two", baseVersion = v1))

        val stale = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "three", baseVersion = v1))
        assertFalse(stale.success)
        assertEquals("two", stale.note!!.content)

        // Creating a note that already exists is a conflict too.
        val dupe = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "new"))
        assertFalse(dupe.success)
    }

    @Test
    fun `writing the content a note already has always succeeds without a new version`() = testServer {
        val (auth, vault) = setUp()
        val note = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "same")).note!!
        val again = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "same", baseVersion = null))
        assertTrue(again.success)
        assertEquals(note.version, again.note!!.version)
    }

    @Test
    fun `deleting leaves a tombstone and writing brings the note back`() = testServer {
        val (auth, vault) = setUp()
        val note = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "x")).note!!
        val deleted = NoteEndpoints.delete.test(auth, DeleteNote(vault._id, "A.md", baseVersion = note.version))
        assertTrue(deleted.success)
        assertTrue(deleted.note!!.deleted)
        assertEquals("", deleted.note!!.content)
        assertNull(NoteEndpoints.read.test(auth, ReadNote(vault._id, "A.md")))

        val back = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "back"))
        assertTrue(back.success)
        assertFalse(back.note!!.deleted)
        assertEquals(note._id, back.note!!._id)
    }

    @Test
    fun `a stale delete is refused`() = testServer {
        val (auth, vault) = setUp()
        val v1 = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "one")).note!!.version
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "two", baseVersion = v1))
        val result = NoteEndpoints.delete.test(auth, DeleteNote(vault._id, "A.md", baseVersion = v1))
        assertFalse(result.success)
        assertEquals("two", NoteEndpoints.read.test(auth, ReadNote(vault._id, "A.md"))!!.content)
    }

    @Test
    fun `renaming moves the content and deletes the old path`() = testServer {
        val (auth, vault) = setUp()
        val note = NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "content")).note!!
        val moved = NoteEndpoints.rename.test(auth, RenameNote(vault._id, "A.md", "Sub/B.md", note.version))
        assertTrue(moved.success)
        assertEquals("content", NoteEndpoints.read.test(auth, ReadNote(vault._id, "Sub/B.md"))!!.content)
        assertNull(NoteEndpoints.read.test(auth, ReadNote(vault._id, "A.md")))

        NoteEndpoints.write.test(auth, WriteNote(vault._id, "C.md", "c"))
        assertFailsWith<BadRequestException> {
            NoteEndpoints.rename.test(auth, RenameNote(vault._id, "C.md", "Sub/B.md"))
        }
    }

    @Test
    fun `changes come back in version order and page with a cursor`() = testServer {
        val (auth, vault) = setUp()
        repeat(5) { NoteEndpoints.write.test(auth, WriteNote(vault._id, "N$it.md", "n$it")) }
        val first = NoteEndpoints.changes.test(auth, ChangesRequest(vault._id, since = 0, limit = 3))
        assertEquals(listOf("N0.md", "N1.md", "N2.md"), first.notes.map { it.path })
        assertTrue(first.hasMore)
        val second = NoteEndpoints.changes.test(auth, ChangesRequest(vault._id, since = first.cursor, limit = 3))
        assertEquals(listOf("N3.md", "N4.md"), second.notes.map { it.path })
        assertFalse(second.hasMore)

        NoteEndpoints.delete.test(auth, DeleteNote(vault._id, "N1.md"))
        val third = NoteEndpoints.changes.test(auth, ChangesRequest(vault._id, since = second.cursor))
        assertEquals(listOf("N1.md"), third.notes.map { it.path })
        assertTrue(third.notes.single().deleted)
    }

    @Test
    fun `manifest lists every note without content`() = testServer {
        val (auth, vault) = setUp()
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "b.md", "bb"))
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "a"))
        val manifest = NoteEndpoints.manifest.test(auth, vault._id)
        assertEquals(listOf("A.md", "b.md"), manifest.notes.map { it.path })
        assertEquals(2, manifest.notes[1].size)
        assertEquals(manifest.notes.maxOf { it.version }, manifest.latestVersion)
    }

    @Test
    fun `search finds by name and content`() = testServer {
        val (auth, vault) = setUp()
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "Recipes/Pancakes.md", "flour\nmilk and eggs"))
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "Groceries.md", "buy MILK"))
        val hits = NoteEndpoints.search.test(auth, SearchNotes(vault._id, "milk"))
        assertEquals(setOf("Recipes/Pancakes.md", "Groceries.md"), hits.map { it.path }.toSet())
        assertEquals("milk and eggs", hits.first { it.path == "Recipes/Pancakes.md" }.snippet)
        assertEquals("Recipes/Pancakes.md", NoteEndpoints.search.test(auth, SearchNotes(vault._id, "pancake")).first().path)
    }

    @Test
    fun `paths are normalized and bad ones refused`() = testServer {
        val (auth, vault) = setUp()
        val note = NoteEndpoints.write.test(auth, WriteNote(vault._id, "/Folder\\Sub//A.md/", "x")).note!!
        assertEquals("Folder/Sub/A.md", note.path)
        assertFailsWith<BadRequestException> { NoteEndpoints.write.test(auth, WriteNote(vault._id, "../A.md", "x")) }
        assertFailsWith<BadRequestException> { NoteEndpoints.write.test(auth, WriteNote(vault._id, "  /", "x")) }
    }

    @Test
    fun `other users can't touch my vault`() = testServer {
        val (auth, vault) = setUp()
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "Secret.md", "x"))
        val (other, _) = setUp("other@test.com")
        assertFailsWith<NotFoundException> { NoteEndpoints.read.test(other, ReadNote(vault._id, "Secret.md")) }
        assertFailsWith<NotFoundException> { NoteEndpoints.write.test(other, WriteNote(vault._id, "Secret.md", "y")) }
        assertFailsWith<NotFoundException> { NoteEndpoints.manifest.test(other, vault._id) }
        assertEquals(0, NoteEndpoints.rest.query.test(other, Query(Condition.Always)).size)
    }

    @Test
    fun `deleting a vault deletes its notes`() = testServer {
        val (auth, vault) = setUp()
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "x"))
        Vault.info.table().deleteOne(condition { it._id eq vault._id })
        assertEquals(0, NoteEndpoints.rest.query.test(auth, Query(Condition.Always)).size)
    }

    private fun sha256(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** Uploads [bytes] the way a client does: ask for a link, then put the bytes there. */
    context(runner: TestRunner<*>)
    private suspend fun upload(auth: Authentication<User>, vault: Vault, bytes: ByteArray): String {
        val hash = sha256(bytes)
        val info = NoteEndpoints.attachmentUpload.test(auth, AttachmentUpload(vault._id, hash, bytes.size.toLong()))
        if (info.uploadUrl != null) NoteEndpoints.blob(vault._id, hash).put(TypedData.bytes(bytes, MediaType.Application.OctetStream))
        return hash
    }

    @Test
    fun `attachments are saved by hash and sync like notes`() = testServer {
        val (auth, vault) = setUp()
        val bytes = byteArrayOf(1, 2, 3, 0, -1, 42)
        val hash = upload(auth, vault, bytes)

        val saved = NoteEndpoints.writeAttachment.test(auth, WriteAttachment(vault._id, "img/a.png", hash))
        assertTrue(saved.success)
        assertTrue(saved.note!!.attachment)
        assertEquals(hash, saved.note!!.hash)
        assertEquals(bytes.size, saved.note!!.size)
        assertEquals("", saved.note!!.content)

        // The bytes are already there now, so a second upload has nothing to send.
        assertNull(NoteEndpoints.attachmentUpload.test(auth, AttachmentUpload(vault._id, hash, bytes.size.toLong())).uploadUrl)

        val manifest = NoteEndpoints.manifest.test(auth, vault._id)
        assertTrue(manifest.notes.single().attachment)
        assertEquals(listOf("img/a.png"), NoteEndpoints.changes.test(auth, ChangesRequest(vault._id, 0)).notes.map { it.path })
        assertEquals(1, NoteEndpoints.attachmentUrls.test(auth, AttachmentUrls(vault._id, listOf(hash))).size)

        // Replacing it needs the version it started from, like a note.
        val other = upload(auth, vault, byteArrayOf(9, 9))
        assertFalse(NoteEndpoints.writeAttachment.test(auth, WriteAttachment(vault._id, "img/a.png", other)).success)
        val replaced = NoteEndpoints.writeAttachment.test(auth, WriteAttachment(vault._id, "img/a.png", other, saved.note!!.version))
        assertTrue(replaced.success)
        assertEquals(2, replaced.note!!.size)

        // Renaming keeps it an attachment.
        val moved = NoteEndpoints.rename.test(auth, RenameNote(vault._id, "img/a.png", "b.png"))
        assertTrue(moved.note!!.attachment)
        assertEquals(other, moved.note!!.hash)
    }

    @Test
    fun `an attachment must be uploaded and match its hash`() = testServer {
        val (auth, vault) = setUp()
        val missing = sha256(byteArrayOf(5))
        assertFailsWith<BadRequestException> { NoteEndpoints.writeAttachment.test(auth, WriteAttachment(vault._id, "a.png", missing)) }

        // Bytes stored under the wrong hash are refused, and thrown away.
        val wrong = sha256(byteArrayOf(6))
        NoteEndpoints.blob(vault._id, wrong).put(TypedData.bytes(byteArrayOf(7), MediaType.Application.OctetStream))
        assertFailsWith<BadRequestException> { NoteEndpoints.writeAttachment.test(auth, WriteAttachment(vault._id, "a.png", wrong)) }
        assertNull(NoteEndpoints.blob(vault._id, wrong).head())

        assertFailsWith<BadRequestException> { NoteEndpoints.attachmentUpload.test(auth, AttachmentUpload(vault._id, "../../etc", 1)) }
        val (other, _) = setUp("other@test.com")
        assertFailsWith<NotFoundException> { NoteEndpoints.attachmentUrls.test(other, AttachmentUrls(vault._id, listOf(missing))) }
    }

    @Test
    fun `admin stats count everything`() = testServer {
        val (auth, vault) = setUp()
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "hello"))
        val (boss, _) = setUp("boss@test.com")
        // Claude: .test() skips the auth requirement, so only the counts are checked here.
        val stats = AdminEndpoints.stats.test(boss, Unit)
        assertEquals(2, stats.users)
        assertEquals(2, stats.vaults)
        assertEquals(1, stats.notes)
        assertNull(stats.storage)
    }
}

class AllowedEmailsTest {
    @Test
    fun `only listed emails may log in, ignoring case, unless the list has a star`() {
        val allowed = listOf("Me@Example.com")
        assertTrue(emailAllowed(allowed, "me@example.com"))
        assertTrue(emailAllowed(allowed, " ME@EXAMPLE.COM "))
        assertFalse(emailAllowed(allowed, "stranger@example.com"))
        assertTrue(emailAllowed(listOf("*"), "anyone@example.com"))
        assertFalse(emailAllowed(emptyList(), "me@example.com"))
    }

    @Test
    fun `a star lists nobody as an admin`() {
        assertTrue(emailListed(listOf("Me@Example.com"), " me@example.com "))
        assertFalse(emailListed(listOf("*"), "anyone@example.com"))
    }
}
