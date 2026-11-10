package com.wesleyedwards.notebarn

import com.lightningkite.lightningserver.auth.testAuth
import com.lightningkite.lightningserver.runtime.test.TestRunner
import com.lightningkite.lightningserver.runtime.test.testBlocking
import com.lightningkite.lightningserver.settings.set
import com.lightningkite.lightningserver.typed.test
import com.lightningkite.services.cache.Cache
import com.lightningkite.services.data.toEmailAddress
import com.lightningkite.services.database.*
import com.lightningkite.services.files.PublicFileSystem
import com.wesleyedwards.notebarn.data.Backups
import com.wesleyedwards.notebarn.data.NoteEndpoints
import com.wesleyedwards.notebarn.data.NoteEndpoints.info
import com.wesleyedwards.notebarn.data.UserEndpoints.info
import com.wesleyedwards.notebarn.data.VaultEndpoints
import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.*

class BackupsTest {
    private val backupDir = createTempDirectory("notebarn-backups").toFile()

    private fun testServer(action: suspend context(TestRunner<Server>) Server.() -> Unit) = Server.testBlocking(
        settings = {
            database set Database.Settings("ram")
            cache set Cache.Settings("ram")
            files set PublicFileSystem.Settings("file://${createTempDirectory("notebarn-files")}?serveUrl=files")
            backups set PublicFileSystem.Settings("file://$backupDir?serveUrl=backups")
        },
        action = action,
    )

    // Claude: the local file store keeps a `.contenttype` file beside each file.
    private fun backupNames() = backupDir.list()!!.filter { it.endsWith(".json.gz") }.sorted()

    @Test
    fun `a backup restores into an empty database`() {
        testServer {
            val user = User.info.table().insertOne(User(email = "me@test.com".toEmailAddress()))!!
            val auth = UserAuth.testAuth(user)
            val vault = VaultEndpoints.rest.insert.test(auth, Vault(owner = user._id, name = "Personal"))
            val v1 = NoteEndpoints.write.test(auth, WriteNote(vault._id, "a.md", "one")).note!!.version
            NoteEndpoints.write.test(auth, WriteNote(vault._id, "a.md", "two", baseVersion = v1))
            Backups.take()
        }
        val file = File(backupDir, backupNames().single())

        testServer {
            Backups.restore(file.readBytes())
            assertEquals("two", Note.info.table().findOne(condition { it.path eq "a.md" })!!.content)
            assertEquals(1, User.info.table().count())
            assertFailsWith<IllegalStateException> { Backups.restore(file.readBytes()) }
        }
    }

    @Test
    fun `only the newest backups are kept`() = testServer {
        repeat(Backups.KEEP + 5) { i ->
            File(backupDir, "2000-01-%02d.json.gz".format(i + 1)).writeBytes(byteArrayOf())
        }
        Backups.take()
        val names = backupNames()
        assertEquals(Backups.KEEP, names.size)
        assertFalse("2000-01-01.json.gz" in names)
        assertTrue(names.last().startsWith("20") && !names.last().startsWith("2000"))
    }
}
