package com.wesleyedwards.notebarn

import com.lightningkite.lightningserver.NotFoundException
import com.lightningkite.lightningserver.auth.Authentication
import com.lightningkite.lightningserver.auth.testAuth
import com.lightningkite.lightningserver.runtime.test.TestRunner
import com.lightningkite.lightningserver.runtime.test.testBlocking
import com.lightningkite.lightningserver.settings.set
import com.lightningkite.lightningserver.typed.test
import com.lightningkite.services.cache.Cache
import com.lightningkite.services.data.toEmailAddress
import com.lightningkite.services.database.*
import com.lightningkite.services.files.PublicFileSystem
import com.wesleyedwards.notebarn.data.NoteEndpoints
import com.wesleyedwards.notebarn.data.NoteEndpoints.info
import com.wesleyedwards.notebarn.data.NoteHistory
import com.wesleyedwards.notebarn.data.UserEndpoints.info
import com.wesleyedwards.notebarn.data.VaultEndpoints
import com.wesleyedwards.notebarn.data.VaultEndpoints.info
import kotlinx.coroutines.flow.toList
import kotlin.test.*
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class NoteHistoryTest {
    /** How far the history's clock is ahead of the real one: "time passing" without waiting. */
    private var later = Duration.ZERO

    @BeforeTest
    fun fakeClock() {
        later = Duration.ZERO
        NoteHistory.now = { Clock.System.now() + later }
    }

    @AfterTest
    fun realClock() {
        NoteHistory.now = { Clock.System.now() }
    }

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

    /** Writes [content] over whatever's at [path]. */
    context(_: TestRunner<*>)
    private suspend fun write(auth: Authentication<User>, vault: Vault, path: String, content: String): Note {
        val current = NoteEndpoints.read.test(auth, ReadNote(vault._id, path))
        val result = NoteEndpoints.write.test(auth, WriteNote(vault._id, path, content, current?.version))
        assertTrue(result.success)
        return result.note!!
    }

    context(_: TestRunner<*>)
    private suspend fun history(auth: Authentication<User>, vault: Vault, path: String) =
        NoteEndpoints.history.test(auth, NoteHistoryRequest(vault._id, path))

    context(_: TestRunner<*>)
    private suspend fun contentOf(auth: Authentication<User>, vault: Vault, v: NoteVersionSummary) =
        NoteEndpoints.version.test(auth, ReadVersion(vault._id, v.id)).content

    @Test
    fun `saves while typing keep one copy every ten minutes`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "start")
        // Typing: saves a few seconds apart.
        for (i in 1..5) {
            later += 5.seconds
            write(auth, vault, "A.md", "start $i")
        }
        assertEquals(listOf("start"), history(auth, vault, "A.md").map { contentOf(auth, vault, it) })

        later += 11.minutes
        write(auth, vault, "A.md", "start 6")
        assertEquals(listOf("start 5", "start"), history(auth, vault, "A.md").map { contentOf(auth, vault, it) })
    }

    @Test
    fun `text left alone for a while is kept before it changes`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "one")
        later += 10.seconds
        write(auth, vault, "A.md", "two") // copies "one" (the first copy)
        later += 3.minutes
        write(auth, vault, "A.md", "three") // "two" sat for 3 minutes: worth keeping, though it's inside the gap
        assertEquals(listOf("two", "one"), history(auth, vault, "A.md").map { contentOf(auth, vault, it) })
    }

    @Test
    fun `the first copy of a day lasts longer than the rest`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "one")
        later += 1.minutes
        write(auth, vault, "A.md", "two")
        later += 11.minutes
        write(auth, vault, "A.md", "three")
        val table = NoteVersion.info.table()
        val copies = table.find(Condition.Always, orderBy = sort { it.savedAt.ascending() }).toList()
        assertEquals(2, copies.size)
        val dayChanged = copies[0].savedAt.epochSeconds / 86_400 != copies[1].savedAt.epochSeconds / 86_400
        assertEquals(NoteHistory.LONG_KEEP, copies[0].expiresAt - copies[0].savedAt)
        assertEquals(if (dayChanged) NoteHistory.LONG_KEEP else NoteHistory.SHORT_KEEP, copies[1].expiresAt - copies[1].savedAt)
    }

    @Test
    fun `deleted notes can be found and brought back`() = testServer {
        val (auth, vault) = setUp()
        val note = write(auth, vault, "Gone.md", "precious")
        write(auth, vault, "Stays.md", "x")
        NoteEndpoints.delete.test(auth, DeleteNote(vault._id, "Gone.md", note.version))

        val deleted = NoteEndpoints.recentlyDeleted.test(auth, vault._id)
        assertEquals(listOf("Gone.md"), deleted.map { it.path })
        assertEquals(VersionReason.Delete, deleted[0].reason)
        assertEquals("precious", contentOf(auth, vault, deleted[0]))

        // Restoring brings it back, after which it's no longer "deleted".
        val back = NoteEndpoints.restore.test(auth, RestoreVersion(vault._id, deleted[0].id, null))
        assertTrue(back.success)
        assertEquals("precious", NoteEndpoints.read.test(auth, ReadNote(vault._id, "Gone.md"))!!.content)
        assertEquals(emptyList(), NoteEndpoints.recentlyDeleted.test(auth, vault._id))
    }

    @Test
    fun `deleting right after a copy marks that copy instead of making another`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "one")
        later += 10.seconds
        val two = write(auth, vault, "A.md", "two")
        later += 11.minutes
        // Copy of "two" taken by the delete; "one" was copied by the edit.
        NoteEndpoints.delete.test(auth, DeleteNote(vault._id, "A.md", two.version))
        val h = history(auth, vault, "A.md")
        assertEquals(listOf("two", "one"), h.map { contentOf(auth, vault, it) })
        assertEquals(listOf(VersionReason.Delete, VersionReason.Edit), h.map { it.reason })
    }

    @Test
    fun `renaming takes the history along`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "one")
        later += 1.minutes
        val two = write(auth, vault, "A.md", "two")
        NoteEndpoints.rename.test(auth, RenameNote(vault._id, "A.md", "Folder/B.md", two.version))
        assertEquals(emptyList(), history(auth, vault, "A.md"))
        assertEquals(listOf("one"), history(auth, vault, "Folder/B.md").map { contentOf(auth, vault, it) })
        // A rename isn't a delete.
        assertEquals(emptyList(), NoteEndpoints.recentlyDeleted.test(auth, vault._id))
    }

    @Test
    fun `big notes are stored compressed and come back the same`() = testServer {
        val (auth, vault) = setUp()
        val big = (1..2000).joinToString("\n") { "Line $it of a long note, with some words in it." }
        write(auth, vault, "Big.md", big)
        later += 1.minutes
        write(auth, vault, "Big.md", "short now")
        val stored = NoteVersion.info.table().find(Condition.Always).toList().single()
        assertTrue(stored.compressed)
        assertTrue(stored.content.length < big.length / 3)
        assertEquals(big, contentOf(auth, vault, history(auth, vault, "Big.md").single()))
    }

    @Test
    fun `restoring keeps a copy of what it replaces, however recent`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "good")
        later += 1.minutes
        val bad = write(auth, vault, "A.md", "oops") // copies "good"
        later += 5.seconds
        val good = history(auth, vault, "A.md").single()
        val restored = NoteEndpoints.restore.test(auth, RestoreVersion(vault._id, good.id, bad.version))
        assertTrue(restored.success)
        assertEquals("good", restored.note!!.content)
        assertEquals(listOf("oops", "good"), history(auth, vault, "A.md").map { contentOf(auth, vault, it) })

        // From a stale version it's a conflict, like any write.
        write(auth, vault, "A.md", "newer")
        val stale = NoteEndpoints.restore.test(auth, RestoreVersion(vault._id, good.id, bad.version))
        assertFalse(stale.success)
    }

    @Test
    fun `expired copies are cleared out`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "one")
        later += 1.minutes
        write(auth, vault, "A.md", "two")
        later += 100.days
        write(auth, vault, "A.md", "three")
        assertEquals(listOf("two"), history(auth, vault, "A.md").map { contentOf(auth, vault, it) })
    }

    @Test
    fun `nobody else can see my history`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "secret")
        later += 1.minutes
        write(auth, vault, "A.md", "new")
        val v = history(auth, vault, "A.md").single()
        val (other, otherVault) = setUp("other@test.com")
        assertFailsWith<NotFoundException> { NoteEndpoints.history.test(other, NoteHistoryRequest(vault._id, "A.md")) }
        assertFailsWith<NotFoundException> { NoteEndpoints.version.test(other, ReadVersion(vault._id, v.id)) }
        assertFailsWith<NotFoundException> { NoteEndpoints.version.test(other, ReadVersion(otherVault._id, v.id)) }
        assertFailsWith<NotFoundException> { NoteEndpoints.recentlyDeleted.test(other, vault._id) }
    }

    @Test
    fun `deleting a vault deletes its history`() = testServer {
        val (auth, vault) = setUp()
        write(auth, vault, "A.md", "one")
        later += 1.minutes
        write(auth, vault, "A.md", "two")
        assertEquals(1, NoteVersion.info.table().count(Condition.Always))
        Vault.info.table().deleteOne(condition { it._id eq vault._id })
        assertEquals(0, NoteVersion.info.table().count(Condition.Always))
    }
}
