plugins { kotlin("jvm") }

kotlin { jvmToolchain(17) }

dependencies {
    implementation(project(":ledger"))
    implementation("com.google.code.gson:gson:2.13.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    compileOnly("com.google.ai.edge.litertlm:litertlm-jvm:0.18.0")
    testImplementation("junit:junit:4.13.2")
}
