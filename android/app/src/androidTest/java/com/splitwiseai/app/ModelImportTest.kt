package com.splitwiseai.app

import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ModelImportTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun model(bytes: ByteArray) = ModelFile(
        id = "test-import-${UUID.randomUUID()}", name = "Import test",
        filename = "test-import-${UUID.randomUUID()}.litertlm", url = "",
        sha256 = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) },
        size = bytes.size.toLong(), license = "Test fixture", source = "Synthetic test fixture",
        toolInterface = "reduced-v2",
    )

    @Test fun verifiedModelCanBeImportedWithoutNetwork() = runBlocking {
        val bytes = "Synthetic model fixture".toByteArray()
        val model = model(bytes)
        val manager = ModelManager(context)
        val source = File.createTempFile("model-import-", ".bin", context.cacheDir)
        try {
            source.writeBytes(bytes)
            manager.importFile(model, Uri.fromFile(source))
            assertTrue(manager.ready(model))
            assertArrayEquals(bytes, manager.file(model).readBytes())
            assertFalse(manager.progress.value.running)
        } finally {
            manager.remove(model)
            source.delete()
        }
    }

    @Test fun corruptImportPreservesPreviouslyVerifiedModel() = runBlocking {
        val bytes = "Synthetic model fixture".toByteArray()
        val model = model(bytes)
        val manager = ModelManager(context)
        val source = File.createTempFile("model-import-", ".bin", context.cacheDir)
        try {
            source.writeBytes(bytes)
            manager.importFile(model, Uri.fromFile(source))
            source.writeBytes(bytes.copyOf().also { it[0] = (it[0] + 1).toByte() })
            try {
                manager.importFile(model, Uri.fromFile(source))
                fail("Corrupt model accepted")
            } catch (_: IllegalArgumentException) { }
            assertTrue(manager.ready(model))
            assertArrayEquals(bytes, manager.file(model).readBytes())
            assertFalse(File(manager.file(model).path + ".importing").exists())
        } finally {
            manager.remove(model)
            source.delete()
        }
    }

    @Test fun wrongSizeNeverBecomesReady() = runBlocking {
        val bytes = "Synthetic model fixture".toByteArray()
        val model = model(bytes)
        val manager = ModelManager(context)
        val source = File.createTempFile("model-import-", ".bin", context.cacheDir)
        try {
            for (size in listOf(bytes.size - 1, bytes.size + 1)) {
                source.writeBytes(bytes.copyOf(size))
                try {
                    manager.importFile(model, Uri.fromFile(source))
                    fail("Wrong model size accepted")
                } catch (_: IllegalArgumentException) { }
                assertFalse(manager.ready(model))
                assertFalse(File(manager.file(model).path + ".importing").exists())
            }
        } finally {
            manager.remove(model)
            source.delete()
        }
    }
}
