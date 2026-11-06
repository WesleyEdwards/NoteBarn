package com.wesleyedwards.notebarn.data

import com.lightningkite.lightningserver.auth.id
import com.lightningkite.lightningserver.auth.require
import com.lightningkite.lightningserver.definition.builder.ServerBuilder
import com.lightningkite.lightningserver.typed.ModelRestEndpoints
import com.lightningkite.lightningserver.typed.auth
import com.lightningkite.lightningserver.typed.modelInfo
import com.lightningkite.services.database.*
import com.wesleyedwards.notebarn.*
import com.wesleyedwards.notebarn.data.VaultEndpoints.info
import com.lightningkite.lightningserver.typed.ModelInfo

object UserEndpoints : ServerBuilder() {
    private val info: ModelInfo<User, User, User.ID> = Server.database.modelInfo(
        auth = UserAuth.require(),
        permissions = {
            val self = condition<User> { it._id eq auth.id }
            ModelPermissions(
                create = Condition.Never,
                read = self,
                update = Condition.Never,
                delete = self,
            )
        },
        signals = {
            it.postDelete { user ->
                Vault.info.table().find(condition { v -> v.owner eq user._id }).collect { v -> VaultEndpoints.deleteVaultNotes(v._id) }
                Vault.info.table().deleteManyIgnoringOld(condition { v -> v.owner eq user._id })
            }
        }
    )

    val rest = path include ModelRestEndpoints(info)

    val User.Companion.info get() = this@UserEndpoints.info
}
