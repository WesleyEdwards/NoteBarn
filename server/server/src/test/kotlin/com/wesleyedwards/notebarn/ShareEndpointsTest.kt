package com.wesleyedwards.notebarn

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
import com.wesleyedwards.notebarn.data.NoteEndpoints
import com.wesleyedwards.notebarn.data.ShareEndpoints
import com.wesleyedwards.notebarn.data.UserEndpoints.info
import com.wesleyedwards.notebarn.data.VaultEndpoints
import java.security.MessageDigest
import kotlin.test.*

class ShareEndpointsTest {
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

    context(_: TestRunner<*>)
    private suspend fun attach(auth: Authentication<User>, vault: Vault, path: String, bytes: ByteArray): String {
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        NoteEndpoints.blob(vault._id, hash).put(TypedData.bytes(bytes, MediaType.Application.OctetStream))
        assertTrue(NoteEndpoints.writeAttachment.test(auth, WriteAttachment(vault._id, path, hash)).success)
        return hash
    }

    @Test
    fun `anyone with the link reads the note as it is now`() = testServer {
        val (auth, vault) = setUp()
        val v1 = NoteEndpoints.write.test(auth, WriteNote(vault._id, "Folder/Recipe.md", "one")).note!!.version
        val share = ShareEndpoints.create.test(auth, ShareNote(vault._id, "Folder/Recipe.md"))
        assertEquals(share._id, ShareEndpoints.create.test(auth, ShareNote(vault._id, "Folder/Recipe.md"))._id)

        val seen = ShareEndpoints.view.test(null, share._id.toString())
        assertEquals("Recipe", seen.title)
        assertEquals("one", seen.content)

        NoteEndpoints.write.test(auth, WriteNote(vault._id, "Folder/Recipe.md", "two", baseVersion = v1))
        assertEquals("two", ShareEndpoints.view.test(null, share._id.toString()).content)
    }

    @Test
    fun `a shared note gets links only to the files it shows`() = testServer {
        val (auth, vault) = setUp()
        val photo = attach(auth, vault, "Folder/img/photo one.png", byteArrayOf(1))
        val other = attach(auth, vault, "pie.png", byteArrayOf(2))
        attach(auth, vault, "secret.pdf", byteArrayOf(3))
        val text = "![[photo one.png|300]] and ![pie](/pie.png) and [[secret.pdf]] and ![[missing.png]]"
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "Folder/Recipe.md", text))
        val share = ShareEndpoints.create.test(auth, ShareNote(vault._id, "Folder/Recipe.md"))

        val files = ShareEndpoints.view.test(null, share._id.toString()).attachments.associate { it.target to it.hash }
        assertEquals(mapOf("photo one.png" to photo, "pie.png" to other), files)
    }

    @Test
    fun `stopping sharing or deleting the note ends the link`() = testServer {
        val (auth, vault) = setUp()
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "a"))
        val first = ShareEndpoints.create.test(auth, ShareNote(vault._id, "A.md"))
        ShareEndpoints.stop.test(auth, ShareNote(vault._id, "A.md"))
        assertFailsWith<NotFoundException> { ShareEndpoints.view.test(null, first._id.toString()) }
        assertFailsWith<NotFoundException> { ShareEndpoints.view.test(null, "nope") }

        val second = ShareEndpoints.create.test(auth, ShareNote(vault._id, "A.md"))
        assertNotEquals(first._id, second._id)
        NoteEndpoints.delete.test(auth, DeleteNote(vault._id, "A.md"))
        // A new note at the same path isn't shared.
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "new"))
        assertFailsWith<NotFoundException> { ShareEndpoints.view.test(null, second._id.toString()) }
    }

    @Test
    fun `the link follows a renamed note`() = testServer {
        val (auth, vault) = setUp()
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "a"))
        val share = ShareEndpoints.create.test(auth, ShareNote(vault._id, "A.md"))
        NoteEndpoints.rename.test(auth, RenameNote(vault._id, "A.md", "Folder/B.md"))
        assertEquals("B", ShareEndpoints.view.test(null, share._id.toString()).title)
        assertEquals("Folder/B.md", ShareEndpoints.rest.query.test(auth, Query(Condition.Always)).single().path)
    }

    @Test
    fun `only the owner can share and see their shares`() = testServer {
        val (auth, vault) = setUp()
        val (other, _) = setUp("other@test.com")
        NoteEndpoints.write.test(auth, WriteNote(vault._id, "A.md", "a"))
        assertFailsWith<NotFoundException> { ShareEndpoints.create.test(other, ShareNote(vault._id, "A.md")) }
        assertFailsWith<NotFoundException> { ShareEndpoints.create.test(auth, ShareNote(vault._id, "Nope.md")) }
        ShareEndpoints.create.test(auth, ShareNote(vault._id, "A.md"))
        assertEquals(0, ShareEndpoints.rest.query.test(other, Query(Condition.Always)).size)
    }
}
