plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "sh.delo.holocene.auto"
    compileSdk = 33
    buildToolsVersion = "35.0.0"
    useLibrary("android.car")
    defaultConfig {
        applicationId = "sh.delo.holocene.auto.feasibility"
        minSdk = 33
        targetSdk = 33
        versionCode = 1
        versionName = "0.1.0-fixture"
        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
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
