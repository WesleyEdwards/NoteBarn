package com.wesleyedwards.notebarn.data

import com.lightningkite.lightningserver.BadRequestException
import com.lightningkite.lightningserver.auth.id
import com.lightningkite.lightningserver.auth.require
import com.lightningkite.lightningserver.definition.builder.ServerBuilder
import com.lightningkite.lightningserver.runtime.ServerRuntime
import com.lightningkite.lightningserver.typed.ModelInfo
import com.lightningkite.lightningserver.typed.ModelRestEndpoints
import com.lightningkite.lightningserver.typed.auth
import com.lightningkite.lightningserver.typed.modelInfo
import com.lightningkite.services.database.*
import com.wesleyedwards.notebarn.*
import com.wesleyedwards.notebarn.data.NoteEndpoints.info

object VaultEndpoints : ServerBuilder() {
    private val info: ModelInfo<User, Vault, Vault.ID> = Server.database.modelInfo(
        auth = UserAuth.require(),
        permissions = {
            ownerPerms<Vault>({ it.owner }).copy(
                updateRestrictions = updateRestrictions {
                    it.owner.cannotBeModified()
                    it.latestVersion.cannotBeModified()
                }
            )
        },
        prePermissionsForUser = {
            it.interceptCreate { vault ->
                if (vault.name.isBlank()) throw BadRequestException("A vault needs a name.")
                vault.copy(owner = auth.id, latestVersion = 0, name = vault.name.trim())
            }
        },
        signals = {
            it.postDelete { vault -> deleteVaultNotes(vault._id) }
        }
    )

    val Vault.Companion.info get() = this@VaultEndpoints.info

    val rest = path include ModelRestEndpoints(info)

    context(_: ServerRuntime)
    suspend fun deleteVaultNotes(vault: Vault.ID) {
        Note.info.table().deleteManyIgnoringOld(condition { it.vault eq vault })
        NoteVersion.info.table().deleteManyIgnoringOld(condition { it.vault eq vault })
        ShareEndpoints.vaultDeleted(vault)
        // And the attachments' bytes. Best effort: leftover files only cost storage.
        try {
            Server.files().root.then("attachments/$vault").list()?.forEach { it.delete() }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
