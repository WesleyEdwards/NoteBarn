plugins {
    alias(libs.plugins.kotlinJvm)
    alias(libs.plugins.serialization)
    alias(libs.plugins.ksp)
    application
    id("com.github.johnrengelman.shadow") version "8.1.1"
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
    // For some reason, libraries are pulling in different versions of netty
    implementation(enforcedPlatform("io.netty:netty-bom:4.1.100.Final"))

    api(libs.kotliner.cli)
    api(libs.comLightningKite.services.database)
    api(libs.comLightningKite.services.database.jsonfile)
    api(libs.comLightningKite.services.database.mongodb)
    api(libs.comLightningKite.lightningServer.core)
    api(libs.comLightningKite.lightningServer.typed)
    api(libs.comLightningKite.lightningServer.files)
    api(libs.comLightningKite.lightningServer.sessions)
    api(libs.comLightningKite.lightningServer.sessions.email)
    implementation(libs.comLightningKite.services.email.javasmtp)
    implementation(libs.comLightningKite.services.files.s3)
    implementation(libs.comLightningKite.lightningServer.engine.netty)

    implementation(libs.comLightningKite.lightningServer.engine.aws)

    ksp(libs.comLightningKite.services.database.processor)

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

tasks.create("generateSdk", JavaExec::class.java) {
    group = "deploy"
    classpath(sourceSets.main.get().runtimeClasspath)
    mainClass.set("com.wesleyedwards.notebarn.MainKt")
    args(settingsArgs() + "sdk")
    workingDir(project.rootDir)
}
tasks.create("serve", JavaExec::class.java) {
    group = "application"
    classpath(sourceSets.main.get().runtimeClasspath)
    mainClass.set("com.wesleyedwards.notebarn.MainKt")
    args(settingsArgs() + "serve")
    workingDir(project.rootDir)
}

tasks.register<Sync>("lambda") {
    group = "deploy"
    this.destinationDir = project.buildDir.resolve("dist/lambda")
    val jarTask = tasks.getByName("jar")
    dependsOn(jarTask)
    val output = jarTask.outputs.files.find { it.extension == "jar" }!!
    from(zipTree(output))
    into("lib") {
        from(configurations.runtimeClasspath)
    }
}
