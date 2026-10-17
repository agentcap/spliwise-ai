plugins { kotlin("jvm") }

kotlin { jvmToolchain(17) }

dependencies {
    implementation("com.google.code.gson:gson:2.13.2")
    testImplementation(kotlin("test"))
    testImplementation("org.xerial:sqlite-jdbc:3.50.3.0")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("repoRoot", rootProject.projectDir.parentFile.absolutePath)
}
