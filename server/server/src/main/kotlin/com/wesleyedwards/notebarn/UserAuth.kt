package com.wesleyedwards.notebarn

import com.lightningkite.lightningserver.ForbiddenException
import com.lightningkite.lightningserver.NotFoundException
import com.lightningkite.lightningserver.auth.*
import com.lightningkite.lightningserver.definition.builder.ServerBuilder
import com.lightningkite.lightningserver.runtime.ServerRuntime
import com.lightningkite.lightningserver.sessions.AuthEndpoints
import com.lightningkite.lightningserver.sessions.proofs.EmailProofEndpoints
import com.lightningkite.lightningserver.sessions.proofs.PinHandler
import com.lightningkite.lightningserver.sessions.proofs.proofMethods
import com.lightningkite.lightningserver.typed.AuthAccess
import com.lightningkite.lightningserver.typed.auth
import com.lightningkite.lightningserver.typed.sdk.module
import com.lightningkite.services.data.toEmailAddress
import com.lightningkite.services.database.*
import com.lightningkite.services.email.Email
import com.lightningkite.services.email.EmailAddressWithName
import com.wesleyedwards.notebarn.data.UserEndpoints.info
import kotlinx.serialization.KSerializer
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant


object UserAuth : PrincipalType<User, User.ID>, ServerBuilder() {
    override val subjectSerializer: KSerializer<User> = User.serializer()
    override val idSerializer: KSerializer<User.ID> = User.ID.serializer()

    context(server: ServerRuntime)
    override suspend fun fetch(id: User.ID): User = User.info.table().get(id) ?: throw NotFoundException()

    context(server: ServerRuntime)
    override suspend fun fetchByProperty(property: String, value: String): User? = when (property) {
        "email" -> {
            if (!emailAllowed(Server.allowedEmails(), value)) throw ForbiddenException("This email isn't allowed to log in.")
            User.info.table().run {
                findOne(condition { it.email eq value.toEmailAddress() })
                    ?: insertOne(User(email = value.toEmailAddress()))
            }
        }

        else -> super.fetchByProperty(property, value)
    }

    override val precache: List<AuthCacheKey<User, *>> = listOf(RoleCache)

    object RoleCache : AuthCacheKey<User, UserRole> {
        override val id: String = "role"
        override val serializer: KSerializer<UserRole> = kotlinx.serialization.serializer()
        override val expireAfter: Duration = 5.minutes

        context(_: ServerRuntime)
        override suspend fun calculate(input: Authentication<User>): UserRole = input.fetch().role

        context(_: ServerRuntime)
        suspend fun Authentication<User>.userRole() = get(RoleCache)

        context(_: ServerRuntime)
        suspend fun AuthAccess<User>.userRole() = auth.userRole()
    }

    private val proofs = path.path("proof")

    // Digits, since mail apps (Gmail's "Copy code", iOS autofill) look for numeric codes.
    val pins = PinHandler(Server.cache, "pins", availableCharacters = ('0'..'9').toList())

    context(_: ServerRuntime)
    private fun codeEmail(to: String, pin: String): Email {
        // Checked here so no code is ever emailed to an address that couldn't use it.
        if (!emailAllowed(Server.allowedEmails(), to)) throw ForbiddenException("This email isn't allowed to log in.")
        val minutes = pins.expiration.inWholeMinutes
        return Email(
            subject = "Your Notebarn code is $pin",
            to = listOf(EmailAddressWithName(to)),
            html = """
                <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:24px auto;color:#222">
                  <p>Enter this code to log in to Notebarn as $to:</p>
                  <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:24px 0">$pin</p>
                  <p style="color:#666">It expires in $minutes minutes. Didn't request it? You can ignore this email.</p>
                </div>
            """.trimIndent(),
            plainText = "Your Notebarn code is $pin\n\nIt expires in $minutes minutes. Didn't request it? You can ignore this email.",
        )
    }

    val email = proofs.path("email") include EmailProofEndpoints(
        pin = pins,
        email = Server.email,
        emailTemplate = { to, pin -> codeEmail(to, pin) },
    )

    val session = path.path("session") include SessionEndpoints()

    class SessionEndpoints : AuthEndpoints<User, User.ID>(
        principal = UserAuth,
        database = Server.database,
        cache = Server.cache,
    ) {
        context(server: ServerRuntime)
        override suspend fun requiredProofStrengthFor(subject: User): Int {
            val methods = server.proofMethods.filter { it.established(UserAuth, subject) }
            return if (methods.size > 1) 20 else 10
        }

        // Sessions never expire: the phone and the Obsidian plugin should stay logged in.
        context(server: ServerRuntime)
        override suspend fun sessionExpiration(subject: User): Instant? = null

        context(server: ServerRuntime)
        override suspend fun sessionStaleAfter(subject: User): Duration? = null
    }
}
