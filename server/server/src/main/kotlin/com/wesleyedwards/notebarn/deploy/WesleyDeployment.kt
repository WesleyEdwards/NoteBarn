package com.wesleyedwards.notebarn.deploy

import com.lightningkite.lightningserver.cors.CorsSettings
import com.lightningkite.lightningserver.definition.loggingSettings
import com.lightningkite.lightningserver.definition.secretBasis
import com.lightningkite.lightningserver.definition.telemetrySettings
import com.lightningkite.lightningserver.engine.awsserverless.AwsAdapter
import com.lightningkite.lightningserver.terraform.EncryptedFileSecretSource
import com.lightningkite.lightningserver.terraform.PasswordFetcher
import com.lightningkite.lightningserver.terraform.SecretSource
import com.lightningkite.lightningserver.terraform.awsserverless.TerraformAwsServerlessDomainBuilder
import com.lightningkite.lightningserver.terraform.generated
import com.lightningkite.services.LoggingSettings
import com.lightningkite.services.cache.dynamodb.awsDynamoDb
import com.lightningkite.services.data.toEmailAddress
import com.lightningkite.services.database.mongodb.mongodbAtlasFree
import com.lightningkite.services.email.javasmtp.awsSesDomainConfiguration
import com.lightningkite.services.email.javasmtp.awsSesSmtp
import com.lightningkite.services.files.s3.awsS3Bucket
import com.lightningkite.services.telemetry.TelemetryBackend
import com.lightningkite.services.terraform.AwsVpc
import com.lightningkite.services.terraform.TerraformProvider
import com.lightningkite.services.terraform.TerraformProviderImport
import com.lightningkite.services.terraform.byVariable
import com.lightningkite.services.terraform.direct
import com.wesleyedwards.notebarn.AwsHandler
import com.wesleyedwards.notebarn.Server
import io.github.oshai.kotlinlogging.Level
import kotlinx.serialization.json.JsonObject
import software.amazon.awssdk.regions.Region
import java.io.File
import java.util.Properties
import kotlin.reflect.KClass
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes


/**
 * Wesley's own deployment of Notebarn, at api.notebarn.a.wesleyedwards.xyz.
 *
 * To run your own, copy this object and change its domain, buckets, Atlas org and contact email.
 */
object WesleyDeployment : TerraformAwsServerlessDomainBuilder<Server>(Server) {

    override val handler: KClass<out AwsAdapter> = AwsHandler::class

    override val displayName = "Notebarn"
    override val terraformRoot: File = File("server/terraform/wesley")

    override val storageBucket = "wesleyedwards-terraform"
    override val storageBucketPath: String = "notebarn/server/prod"

    override val domain = "api.notebarn.a.wesleyedwards.xyz"
    override val domainZone = "a.wesleyedwards.xyz"
    override val region = Region.US_WEST_2!!

    override val timeout: Duration = 5.minutes
    override val monthlyBudgetUsd: Double get() = 3.toDouble()

    override val debug = false
    override val emergencyContact = "wesleyutahedwards@gmail.com".toEmailAddress()

    override val secretsSource: SecretSource = EncryptedFileSecretSource(
        file = File("./wesley-aws-settings"),
        name = "Settings",
        passwordFetcher = object : PasswordFetcher() {
            override fun read(prompt: String, verify: (String) -> Unit): String {
                val properties = Properties()
                File("local.properties").takeIf { it.exists() }?.reader()?.use { properties.load(it) }
                val password = properties.getProperty("DEPLOYMENT_SETTINGS_KEY")?.trim()?.takeIf { it.isNotEmpty() }
                    ?: return super.read(prompt, verify)
                try {
                    verify(password)
                } catch (e: Exception) {
                    throw IllegalStateException("DEPLOYMENT_SETTINGS_KEY in local.properties is wrong: ${e.message}", e)
                }
                return password
            }
        }
    )

    override val applicationVpc: AwsVpc = AwsVpc.None

    override fun Server.settings() {
        require(TerraformProviderImport.mongodbAtlas)
        require(TerraformProvider(TerraformProviderImport.mongodbAtlas, null, JsonObject(emptyMap())))

        cache.awsDynamoDb()
        cors.direct(
            CorsSettings(
                limitToDomains = listOf("*"),
                limitToHeaders = listOf("*"),
                limitToMethods = listOf("*"),
                allowCredentials = false,
                exposedHeaders = listOf(),
                forbidOnMatchFail = true,
            )
        )
        database.mongodbAtlasFree(orgId = "66ecfbd6502ea64cc85d1d5c")
        email.awsSesSmtp(awsSesDomainConfiguration("email", emergencyContact))
        files.awsS3Bucket(signedUrlDuration = 12.hours)
        // Claude: a signed-URL duration is what makes the library's bucket private.
        backups.awsS3Bucket(signedUrlDuration = 1.hours, forceDestroy = false)
        secretBasis.generated()
        telemetrySettings.direct(TelemetryBackend.Settings())
        allowedEmails.byVariable()
        admins.byVariable()

        emit("errorAlarms") {
            "resource.aws_cloudwatch_metric_alarm.lambda_errors" {
                "alarm_name" - "${projectPrefix}_lambda_errors"
                "alarm_description" - "Notebarn's Lambda crashed or timed out"
                "namespace" - "AWS/Lambda"
                "metric_name" - "Errors"
                "dimensions" { "FunctionName" - expression("aws_lambda_function.main.function_name") }
                "statistic" - "Sum"
                "period" - 3600
                "evaluation_periods" - 1
                "threshold" - 1
                "comparison_operator" - "GreaterThanOrEqualToThreshold"
                "treat_missing_data" - "notBreaching"
                "alarm_actions" - listOf(expression("aws_sns_topic.emergency.arn"))
            }
            "resource.aws_cloudwatch_metric_alarm.http_5xx" {
                "alarm_name" - "${projectPrefix}_http_5xx"
                "alarm_description" - "Notebarn's API answered with server errors"
                "namespace" - "AWS/ApiGateway"
                "metric_name" - "5xx"
                "dimensions" { "ApiId" - expression("aws_apigatewayv2_api.http.id") }
                "statistic" - "Sum"
                "period" - 3600
                "evaluation_periods" - 1
                "threshold" - 3
                "comparison_operator" - "GreaterThanOrEqualToThreshold"
                "treat_missing_data" - "notBreaching"
                "alarm_actions" - listOf(expression("aws_sns_topic.emergency.arn"))
            }
        }

        loggingSettings.direct(
            LoggingSettings(
                default = LoggingSettings.ContextSettings(
                    filePattern = null,
                    toConsole = true,
                    level = Level.DEBUG,
                    additive = false
                ),
                logger = mapOf(
                    "org.mongodb" to LoggingSettings.ContextSettings(
                        filePattern = null,
                        toConsole = false,
                        level = Level.INFO,
                        additive = false
                    ),
                    "software.amazon.awssdk" to LoggingSettings.ContextSettings(
                        filePattern = null,
                        toConsole = false,
                        level = Level.INFO,
                        additive = false
                    ),
                    "io.netty" to LoggingSettings.ContextSettings(
                        filePattern = null,
                        toConsole = false,
                        level = Level.INFO,
                        additive = false
                    ),
                    "com.lightningkite.lightningserver.metrics" to LoggingSettings.ContextSettings(
                        filePattern = null,
                        toConsole = false,
                        level = Level.INFO,
                        additive = false
                    ),
                )
            )
        )
    }

    /** Edits the deployment's settings (credentials, allowed emails) in its encrypted settings file. */
    object EditSettings {
        @JvmStatic
        fun main(vararg args: String) = editVars()
    }

    object Deploy {
        @JvmStatic
        fun main(vararg args: String) {
            ProcessBuilder("./gradlew", "server:lambda").inheritIO().start().waitFor()
            println("Deploying Notebarn...")
            deploy(true)
        }
    }
}
