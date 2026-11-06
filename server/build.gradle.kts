plugins {
    alias(libs.plugins.kotlinJvm) apply false
    alias(libs.plugins.shadow) apply false
}

buildscript {
    repositories {
        mavenLocal()
        maven("https://lightningkite-maven.s3.us-west-2.amazonaws.com")
        google()
        mavenCentral()
    }
}

allprojects {
    repositories {
        group = "com.wesleyedwards.notebarn"
        mavenLocal()
        maven("https://lightningkite-maven.s3.us-west-2.amazonaws.com")
        google()
        mavenCentral()
    }
}
