package com.wesleyedwards.notebarn

import com.lightningkite.lightningserver.engine.awsserverless.AwsAdapter
import com.lightningkite.services.cache.dynamodb.DynamoDbCache
import com.lightningkite.services.email.javasmtp.JavaSmtpEmailService

/** The AWS Lambda entry point for [Server]. */
class AwsHandler : AwsAdapter(Server.build()) {
    companion object {
        init {
            DynamoDbCache
            JavaSmtpEmailService
        }
    }
}
