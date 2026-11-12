package com.wesleyedwards.notebarn

import com.lightningkite.lightningserver.auth.AuthRequirement
import com.lightningkite.lightningserver.auth.require
import com.lightningkite.lightningserver.cors.CorsInterceptor
import com.lightningkite.lightningserver.cors.CorsSettings
import com.lightningkite.lightningserver.definition.Runtime
import com.lightningkite.lightningserver.definition.builder.ServerBuilder
import com.lightningkite.lightningserver.definition.set
import com.lightningkite.lightningserver.files.FileSystemEndpoints
import com.lightningkite.lightningserver.files.Files
import com.lightningkite.lightningserver.http.HttpHandler
import com.lightningkite.lightningserver.http.HttpResponse
import com.lightningkite.lightningserver.http.get
import com.lightningkite.lightningserver.plainText
import com.lightningkite.lightningserver.serialization.StandardWithInternalModule
import com.lightningkite.lightningserver.serialization.registerBasicMediaTypeCoders
import com.lightningkite.lightningserver.typed.MetaEndpoints
import com.lightningkite.lightningserver.typed.sdk.module
import com.lightningkite.lightningserver.websockets.MultiplexWebSocketHandler
import com.lightningkite.lightningserver.websockets.QueryParamWebSocketHandler
import com.lightningkite.services.cache.Cache
import com.lightningkite.services.cache.dynamodb.DynamoDbCache
import com.lightningkite.services.database.Database
import com.lightningkite.services.database.jsonfile.JsonFileDatabase
import com.lightningkite.services.database.mongodb.MongoDatabase
import com.lightningkite.services.database.validation.AnnotationValidators
import com.lightningkite.services.email.EmailService
import com.lightningkite.services.email.javasmtp.JavaSmtpEmailService
import com.lightningkite.services.files.PublicFileSystem
import com.lightningkite.services.files.s3.S3PublicFileSystem
import com.wesleyedwards.notebarn.UserAuth.RoleCache.userRole
import com.wesleyedwards.notebarn.data.*

object Server : ServerBuilder() {
    override val annotationValidators: Runtime<AnnotationValidators> = Runtime {
        AnnotationValidators.StandardWithInternalModule() + AnnotationValidators.Files()
    }

    // Settings
    val cache = setting("cache", Cache.Settings())
    val database = setting("database", Database.Settings())
    val email = setting("email", EmailService.Settings())
    val cors = setting("cors", CorsSettings())
    val files = setting("files", PublicFileSystem.Settings())

    /** Where [Backups] puts the nightly database backups. Nothing serves these; keep them private. */
    val backups = setting("backups", PublicFileSystem.Settings("file://local/backups?serveUrl=backups"), optional = true)

    /**
     * Who may log in. "*" lets anyone in, which is only meant for local development: everyone who logs in gets their
     * own vaults, but this is a personal server.
     */
    val allowedEmails = setting("allowedEmails", emptyList<String>())

    /**
     * Who gets the Root role (so may use the admin endpoints, like /meta's). They may log in even if they aren't in
     * [allowedEmails]. Matched like [allowedEmails], except that "*" matches nobody.
     */
    val admins = setting("admins", emptyList<String>())

    init {
        install(CorsInterceptor(cors))
        registerBasicMediaTypeCoders()

        MongoDatabase
        JsonFileDatabase
        JavaSmtpEmailService
        S3PublicFileSystem
        DynamoDbCache

        AuthRequirement.IsSuperUser set UserAuth.require { it.userRole() >= UserRole.Root }
        AuthRequirement.IsAdmin set UserAuth.require { it.userRole() >= UserRole.Admin }
    }

    val root = path.get bind HttpHandler {
        HttpResponse.plainText("Notebarn server is running.")
    }

    // @Formatter:off
    val users =           path.path("users")     module UserEndpoints
    val authEndpoints =   path.path("auth")      module UserAuth

    val vault =           path.path("vault")     module VaultEndpoints
    val note =            path.path("note")      module NoteEndpoints
    val share =           path.path("share")     module ShareEndpoints
    val admin =           path.path("admin")     module AdminEndpoints

    /** Serves and accepts attachments' bytes when they're stored on this server's disk (local development). */
    val fileEndpoints =   path.path("files")     module FileSystemEndpoints(files)

    val backup =          path.path("backup")    bind   BackupTask

    val multiplex =       path.path("multiplex") bind   MultiplexWebSocketHandler()
    val base =            path                              bind   QueryParamWebSocketHandler()
    val meta =            path.path("meta")      module MetaEndpoints("com.wesleyedwards.notebarn", database, cache)
    // @Formatter:on
}
