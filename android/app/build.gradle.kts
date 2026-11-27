import java.util.Properties
import org.gradle.api.tasks.PathSensitivity
import org.gradle.process.CommandLineArgumentProvider
plugins { id("com.android.application"); id("org.jetbrains.kotlin.plugin.compose"); id("com.chaquo.python") }
val robolectricSdkConfigs = listOf("8.0.0_r4-robolectric-r1-i7", "9-robolectric-4913185-2-i7", "13-robolectric-9030017-i7", "15-robolectric-12650502-i7").associateWith { version ->
    configurations.detachedConfiguration(dependencies.create("org.robolectric:android-all-instrumented:$version")).apply { isTransitive = false }
}
val robolectricDepsProps = layout.buildDirectory.file("generated/robolectric/robolectric-deps.properties")
val prepareRobolectricSdkProperties by tasks.registering {
    robolectricSdkConfigs.forEach { (version, config) ->
        inputs.files(config).withPropertyName("robolectricSdk_$version").withPathSensitivity(PathSensitivity.NONE)
    }
    outputs.file(robolectricDepsProps)
    val resolvedFiles = robolectricSdkConfigs.mapValues { (_, config) -> config.elements }
    doLast {
        val props = Properties()
        for ((version, elements) in resolvedFiles) {
            props["org.robolectric:android-all-instrumented:$version"] = elements.get().single().asFile.absolutePath
        }
        val outFile = robolectricDepsProps.get().asFile
        outFile.parentFile.mkdirs()
        outFile.outputStream().use { props.store(it, null) }
    }
}
android {
    namespace = "dev.supermd.studio"
    compileSdk { version = release(37) }
    defaultConfig { applicationId = "dev.supermd.studio"; minSdk = 26; targetSdk = 36; versionCode = 1059; versionName = "0.6.34"; ndk { abiFilters += (System.getenv("SUPERMD_ABIS") ?: "arm64-v8a").split(',') }; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    signingConfigs {
        create("distribution") {
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
            val path = System.getenv("SUPERMD_KEYSTORE")
            if (path != null) { storeFile = file(path); storePassword = System.getenv("SUPERMD_STORE_PASSWORD"); keyAlias = System.getenv("SUPERMD_KEY_ALIAS"); keyPassword = System.getenv("SUPERMD_KEY_PASSWORD") }
        }
    }
    buildTypes {
        release { isMinifyEnabled = true; isShrinkResources = true; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"); signingConfig = if (System.getenv("SUPERMD_KEYSTORE") != null) signingConfigs.getByName("distribution") else null }
    }
    // Compress native libraries for the normal download. Keep aligned ELF files;
    // Android extracts them at installation, rather than inflating APK size.
    packaging { jniLibs { useLegacyPackaging = true }; resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
    lint { error += "ObsoleteSdkInt" }
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.dependsOn(prepareRobolectricSdkProperties)
            it.jvmArgumentProviders.add(CommandLineArgumentProvider {
                listOf("-Drobolectric-deps.properties=${robolectricDepsProps.get().asFile.absolutePath}")
            })
        }
    }
}
kotlin { jvmToolchain(17) }
chaquopy { defaultConfig { version = "3.13"; System.getenv("SUPERMD_BUILD_PYTHON")?.let { buildPython(it) }; pip { install("numpy"); install("matplotlib==3.8.4") } } }
dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation(platform("androidx.compose:compose-bom:2025.09.00"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3:1.5.0-alpha29")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.3")
    implementation("androidx.documentfile:documentfile:1.1.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.caverock:androidsvg-aar:1.4")
    implementation("androidx.window:window:1.4.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation(platform("androidx.compose:compose-bom:2025.09.00"))
    testImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
