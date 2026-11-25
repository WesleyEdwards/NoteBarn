package com.wesleyedwards.notebarn

import com.lightningkite.kotlinercli.cli
import com.lightningkite.lightningserver.InternalLightningServerApi
import com.lightningkite.lightningserver.engine.netty.NettyEngine
import com.lightningkite.lightningserver.runtime.Execution
import com.lightningkite.lightningserver.runtime.Invocation
import com.lightningkite.lightningserver.runtime.execute
import com.lightningkite.lightningserver.settings.loadFromFile
import com.lightningkite.services.kfile.KFile
import com.wesleyedwards.notebarn.data.Backups
import io.github.oshai.kotlinlogging.KotlinLogging
import kotlinx.coroutines.runBlocking
import java.io.File
import kotlin.time.Clock
import kotlin.time.TimeSource

private val logger = KotlinLogging.logger("com.wesleyedwards.notebarn")

private lateinit var settingsFile: KFile

fun setup(settings: String = "settings.json") {
    settingsFile = KFile(settings)
}

private var engine: NettyEngine? = null

fun engine(setup: NettyEngine.() -> Unit) {
    engine?.let {
        setup(it)
        return
    }

    val before = TimeSource.Monotonic.markNow()
    val built = Server.build()
    logger.info { "Server built in ${before.elapsedNow()}" }

    engine = NettyEngine(built, Clock.System).apply {
        settings.loadFromFile(settingsFile, internalSerializersModule)
        logger.info { "Settings loaded in ${before.elapsedNow()}" }
        runBlocking {
            settings.ready()
        }
        setup()
    }
}

fun serve(): Unit = engine { start() }

fun sdk() = engine {}

/** Loads a nightly backup (a `.json.gz` file) into the settings' database, which must be empty. */
@OptIn(InternalLightningServerApi::class)
fun restore(backup: String) = engine {
    runBlocking {
        // Claude: a script has no request behind it; Execution.Direct is the library's sanctioned hole for that.
        execute("restore", Invocation.Unrequested(Execution.Direct(Execution.ID.generate()))) {
            Backups.restore(File(backup).readBytes())
        }
    }
    logger.info { "Restored $backup" }
}

fun main(vararg args: String) = cli(
    arguments = args,
    setup = ::setup,
    available = listOf(
        ::serve,
        ::sdk,
        ::restore,
    ),
    useInteractive = true,
)
