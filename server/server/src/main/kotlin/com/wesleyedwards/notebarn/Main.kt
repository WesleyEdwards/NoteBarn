package com.wesleyedwards.notebarn

import com.lightningkite.kotlinercli.cli
import com.lightningkite.lightningserver.engine.netty.NettyEngine
import com.lightningkite.lightningserver.settings.loadFromFile
import com.lightningkite.services.files.s3.S3PublicFileSystem
import com.lightningkite.services.kfile.KFile
import io.github.oshai.kotlinlogging.KotlinLogging
import kotlinx.coroutines.runBlocking
import kotlin.time.Clock
import kotlin.time.TimeSource

private val logger = KotlinLogging.logger("com.wesleyedwards.notebarn")

private lateinit var settingsFile: KFile

fun setup(settings: String = "settings.json") {
    S3PublicFileSystem
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

fun main(vararg args: String) = cli(
    arguments = args,
    setup = ::setup,
    available = listOf(
        ::serve,
        ::sdk,
    ),
    useInteractive = true,
)
