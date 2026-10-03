plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseKeystorePath = providers.environmentVariable("HOLOCENE_AUTO_RELEASE_KEYSTORE")
val releaseKeystorePassword = providers.environmentVariable("HOLOCENE_AUTO_RELEASE_KEYSTORE_PASSWORD")
val releaseKeyAlias = providers.environmentVariable("HOLOCENE_AUTO_RELEASE_KEY_ALIAS")
val releaseKeyPassword = providers.environmentVariable("HOLOCENE_AUTO_RELEASE_KEY_PASSWORD")
val releaseSigningInputs = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
)
val releaseSigningConfigured = releaseSigningInputs.all { it.isPresent && it.get().isNotBlank() }

android {
    namespace = "sh.delo.holocene.auto"
    compileSdk = 35
    buildToolsVersion = "35.0.0"
    useLibrary("android.car")
    defaultConfig {
        applicationId = "sh.delo.holocene.auto.feasibility"
        minSdk = 33
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0-internal"
        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
    }
    signingConfigs {
        create("release") {
            if (releaseSigningConfigured) {
                storeFile = File(releaseKeystorePath.get())
                storePassword = releaseKeystorePassword.get()
                keyAlias = releaseKeyAlias.get()
                keyPassword = releaseKeyPassword.get()
            }
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = if (releaseSigningConfigured) signingConfigs.getByName("release") else null
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        abortOnError = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

val verifyReleaseSigning = tasks.register("verifyReleaseSigning") {
    doLast {
        val missing = listOf(
            "HOLOCENE_AUTO_RELEASE_KEYSTORE" to releaseKeystorePath,
            "HOLOCENE_AUTO_RELEASE_KEYSTORE_PASSWORD" to releaseKeystorePassword,
            "HOLOCENE_AUTO_RELEASE_KEY_ALIAS" to releaseKeyAlias,
            "HOLOCENE_AUTO_RELEASE_KEY_PASSWORD" to releaseKeyPassword,
        )
            .filter { it.second.orNull.isNullOrBlank() }
            .map { it.first }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Release signing is incomplete. Missing: ${missing.joinToString(", ")}. " +
                    "Run apps/auto/tools/build_release_bundle.sh or provide all four environment values.",
            )
        }
        val keystore = File(releaseKeystorePath.get())
        if (!keystore.isAbsolute) {
            throw GradleException("HOLOCENE_AUTO_RELEASE_KEYSTORE must be an absolute path.")
        }
        if (!keystore.isFile) {
            throw GradleException("HOLOCENE_AUTO_RELEASE_KEYSTORE does not exist: $keystore")
        }
    }
}

listOf("assembleRelease", "bundleRelease").forEach { taskName ->
    tasks.matching { it.name == taskName }.configureEach {
        dependsOn(verifyReleaseSigning)
    }
}
