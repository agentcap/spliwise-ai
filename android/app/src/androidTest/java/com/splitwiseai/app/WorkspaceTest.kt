package com.splitwiseai.app

import android.content.Context
import android.content.ContextWrapper
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.splitwiseai.ledger.*
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkspaceTest {
    private fun isolated(): Context {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(base.cacheDir, "storage-test-${id()}").apply { mkdirs() }
        val exports = File(base.cacheDir, "exports/test-${id()}").apply { mkdirs() }
        return object : ContextWrapper(base) {
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }

            override fun getCacheDir() = exports
        }
    }

    @Test
    fun fullWorkspaceRoundTripPreservesLedgerReceiptsAndUndo() {
        val context = isolated()
        val source = WorkspaceStorage(context)
        val s = source.ledger
        val person = s.addPerson("Synthetic Alex", "synthetic_alex")
        val expense =
            s.manual(
                obj(
                    "description" to "Synthetic lunch",
                    "amountCents" to 101,
                    "date" to "2026-01-01",
                )
            )
        s.quick(s.references(listOf(expense)), SplitSpec("equal", listOf("self", person)))
        s.review(s.references(listOf(expense)), "approve")
        s.attachment(
            expense,
            "synthetic.pdf",
            "application/pdf",
            "%PDF-1.7 Synthetic receipt".toByteArray(),
        )
        val job = id()
        s.insert(
            "jobs",
            obj(
                "id" to job,
                "kind" to "chat",
                "payload" to "{}",
                "status" to "running",
                "createdAt" to now(),
                "updatedAt" to now(),
            ),
        )
        s.insert(
            "messages",
            obj(
                "id" to id(),
                "role" to "user",
                "text" to "Synthetic history",
                "jobId" to job,
                "createdAt" to now(),
            ),
        )
        val file = source.export()
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val uri = FileProvider.getUriForFile(base, base.packageName + ".files", file)
        val target = WorkspaceStorage(isolated())
        val preview = target.preview(uri)
        assertEquals(1L, preview.n("transactions"))
        assertEquals(51L, preview.n("outstandingCents"))
        target.restore()
        assertEquals("finalized", target.ledger.tx(expense).s("state"))
        assertEquals(51L, target.ledger.dashboard().single().outstandingCents)
        assertEquals(1, target.ledger.all("SELECT id FROM attachments").size)
        assertEquals(
            "Synthetic history",
            target.ledger.one("SELECT text FROM messages")!!.s("text"),
        )
        assertEquals(
            "failed",
            target.ledger.one("SELECT status FROM jobs WHERE id=?", job)!!.s("status"),
        )
        target.ledger.undo()
        assertTrue(target.ledger.all("SELECT id FROM attachments").isEmpty())
        assertEquals(51L, target.ledger.dashboard().single().outstandingCents)
        target.ledger.db.close()
        source.ledger.db.close()
    }

    @Test
    fun rejectedWorkspaceDoesNotReplaceExistingLedger() {
        val context = isolated()
        val storage = WorkspaceStorage(context)
        storage.ledger.addPerson("Keep", "keep")
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val invalid =
            File(base.cacheDir, "exports/invalid.sqlite").apply {
                parentFile!!.mkdirs()
                writeText("not a database")
            }
        val uri = FileProvider.getUriForFile(base, base.packageName + ".files", invalid)
        assertTrue(runCatching { storage.preview(uri) }.isFailure)
        assertTrue(storage.ledger.people().any { it.s("handle") == "keep" })
        storage.ledger.db.close()
    }

    @Test
    fun importsDatabaseCreatedByRealWebMigrator() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val base = instrumentation.targetContext
        val fixture =
            File(base.cacheDir, "exports/web-workspace.sqlite").apply { parentFile!!.mkdirs() }
        instrumentation.context.assets.open("web-workspace.sqlite").use { source ->
            fixture.outputStream().use { source.copyTo(it) }
        }
        val storage = WorkspaceStorage(isolated())
        val uri = FileProvider.getUriForFile(base, base.packageName + ".files", fixture)
        val preview = storage.preview(uri)
        assertEquals(2L, preview.n("people"))
        assertEquals(1L, preview.n("transactions"))
        assertEquals(1L, preview.n("trips"))
        assertEquals(26L, preview.n("outstandingCents"))
        storage.restore()
        assertTrue(storage.ledger.people().any { it.s("handle") == "synthetic_alex" })
        assertEquals("finalized", storage.ledger.transactions().single().s("state"))
        assertEquals(1, storage.ledger.all("SELECT * FROM attachments").size)
        assertEquals(25L, storage.ledger.all("SELECT * FROM repayments").single().n("amountCents"))
        storage.ledger.undo()
        assertTrue(storage.ledger.all("SELECT * FROM attachments").isEmpty())
        assertEquals(26L, storage.ledger.dashboard().single().outstandingCents)
        storage.ledger.db.close()
    }

    @Test
    fun unexpectedDatabaseTriggerIsRejectedBeforeReplacement() {
        val storage = WorkspaceStorage(isolated())
        storage.ledger.addPerson("Keep", "keep")
        val file = storage.export()
        AndroidDatabase(file.path).use {
            it.execute("CREATE TRIGGER unexpected AFTER INSERT ON people BEGIN SELECT 1; END")
        }
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val uri = FileProvider.getUriForFile(base, base.packageName + ".files", file)
        assertTrue(runCatching { storage.preview(uri) }.isFailure)
        assertTrue(storage.ledger.people().any { it.s("handle") == "keep" })
        storage.ledger.db.close()
    }
}
