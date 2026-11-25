plugins {
    alias(libs.plugins.kotlinJvm)
    alias(libs.plugins.serialization)
    alias(libs.plugins.ksp)
    application
    alias(libs.plugins.shadow)
}


group = "com.wesleyedwards.notebarn"
version = "1.0-SNAPSHOT"


application {
    mainClass.set("com.wesleyedwards.notebarn.MainKt")
}


tasks.jar {
    manifest {
        attributes("Main-Class" to "com.wesleyedwards.notebarn.MainKt")
    }
}
tasks.shadowJar {
    isZip64 = true
    mergeServiceFiles()
    exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA")
    archiveClassifier.set("") // replaces the normal jar
    manifest {
        attributes(
            "Main-Class" to application.mainClass.get()
        )
    }
}


dependencies {
    // AWS SDK's Apache HTTP client uses this at runtime, but its transitive
    // dependency is not present in the resolved classpath.
    implementation("commons-logging:commons-logging:1.3.5")
    // For AdminEndpoints' dbStats. database-mongodb uses it without exposing it; keep the version it uses.
    implementation("org.mongodb:mongodb-driver-kotlin-coroutine:5.12.0")

    api(libs.kotliner.cli)
    api(sa.database)
    api(sa.database.jsonfile)
    api(sa.database.mongodb)
    api(ls.core)
    api(ls.typed)
    api(ls.files)
    api(ls.sessions)
    api(ls.sessions.email)
    implementation(sa.email.javasmtp)
    implementation(sa.files.s3)
    implementation(ls.engine.netty)
    implementation(ls.engine.aws.serverless)

    ksp(sa.database.processor)

    testImplementation(kotlin("test"))
}

kotlin {
    sourceSets.main {
        kotlin.srcDir("build/generated/ksp/main/kotlin")
    }
    compilerOptions {
        optIn.add("kotlin.time.ExperimentalTime")
        optIn.add("kotlin.uuid.ExperimentalUuidApi")
        freeCompilerArgs.add("-Xcontext-parameters")
    }
}

tasks.named<JavaExec>("run") {
    standardInput = System.`in`
}
java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

tasks.getByName<Zip>("distZip"){
    archiveFileName.set("server.zip")
}
/** `-Psettings=settings.sandbox.json` picks another settings file than settings.json. */
fun settingsArgs(): List<String> = (findProperty("settings") as String?)?.let { listOf("--settings", it) } ?: emptyList()

tasks.register<JavaExec>("generateSdk") {
    group = "deploy"
    classpath(sourceSets.main.get().runtimeClasspath)
    mainClass.set("com.wesleyedwards.notebarn.MainKt")
    args(settingsArgs() + "sdk")
    workingDir(project.rootDir)
}
tasks.register<JavaExec>("serve") {
    group = "application"
    classpath(sourceSets.main.get().runtimeClasspath)
    mainClass.set("com.wesleyedwards.notebarn.MainKt")
    args(settingsArgs() + "serve")
    workingDir(project.rootDir)
}

tasks.register<Sync>("lambda") {
    group = "deploy"
    destinationDir = layout.buildDirectory.dir("dist/lambda").get().asFile
    val jarTask = tasks.getByName("jar")
    dependsOn(jarTask)
    val output = jarTask.outputs.files.find { it.extension == "jar" }!!
    from(zipTree(output))
    into("lib") {
        from(configurations.runtimeClasspath)
    }
}
