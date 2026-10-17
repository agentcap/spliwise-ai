plugins {
    kotlin("jvm")
    application
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation(project(":ledger"))
    implementation(project(":assistant"))
    implementation("com.google.ai.edge.litertlm:litertlm-jvm:0.18.0")
    implementation("com.google.code.gson:gson:2.13.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    implementation("org.xerial:sqlite-jdbc:3.50.3.0")
}

application {
    mainClass.set("com.splitwiseai.check.ModelCheckKt")
    applicationDefaultJvmArgs = listOf("-Xmx1g")
}
