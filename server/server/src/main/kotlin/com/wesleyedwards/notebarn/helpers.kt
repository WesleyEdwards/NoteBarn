package com.wesleyedwards.notebarn

import com.lightningkite.lightningserver.auth.id
import com.lightningkite.lightningserver.runtime.ServerRuntime
import com.lightningkite.lightningserver.typed.AuthAccess
import com.lightningkite.lightningserver.typed.auth
import com.lightningkite.services.database.*
import java.security.MessageDigest

/** Only the owner may do anything with their own records. */
context(_: ServerRuntime)
inline fun <reified T : HasOwner<*>> AuthAccess<User>.ownerPerms(
    owner: (DataClassPath<T, T>) -> DataClassPath<T, User.ID>
): ModelPermissions<T> {
    val isMine: Condition<T> = condition { owner(it).eq(this.auth.id) }
    return ModelPermissions(
        read = isMine,
        create = isMine,
        update = isMine,
        delete = isMine,
    )
}

fun sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

fun emailAllowed(allowed: List<String>, email: String): Boolean =
    allowed.any { it == "*" || it.equals(email.trim(), ignoreCase = true) }
