package com.wesleyedwards.notebarn.data

import com.lightningkite.lightningserver.definition.builder.ServerBuilder
import com.lightningkite.lightningserver.http.get
import com.lightningkite.lightningserver.typed.ApiHttpHandler
import com.lightningkite.services.database.mongodb.MongoDatabase
import com.wesleyedwards.notebarn.*
import com.wesleyedwards.notebarn.UserAuth.RoleCache.userRole
import com.wesleyedwards.notebarn.data.NoteEndpoints.info
import com.wesleyedwards.notebarn.data.ShareEndpoints.info
import com.wesleyedwards.notebarn.data.UserEndpoints.info
import com.wesleyedwards.notebarn.data.VaultEndpoints.info
import com.lightningkite.lightningserver.auth.require
import org.bson.Document

object AdminEndpoints : ServerBuilder() {
    val stats = path.path("stats").get bind ApiHttpHandler(
        summary = "Admin Stats",
        description = "Counts of everything in the database and how much storage it uses. Only for admins.",
        auth = UserAuth.require { it.userRole() >= UserRole.Root },
        implementation = { _: Unit ->
            val db = Server.database()
            AdminStats(
                users = User.info.baseTable().count(),
                vaults = Vault.info.baseTable().count(),
                notes = Note.info.baseTable().count(),
                noteVersions = NoteVersion.info.baseTable().count(),
                shares = Share.info.baseTable().count(),
                storage = if (db is MongoDatabase) {
                    val s = db.database.runCommand(Document("dbStats", 1))
                    DatabaseStorage(
                        dataSize = (s["dataSize"] as Number).toLong(),
                        indexSize = (s["indexSize"] as Number).toLong(),
                        storageSize = (s["storageSize"] as Number).toLong(),
                    )
                } else null,
            )
        }
    )
}
