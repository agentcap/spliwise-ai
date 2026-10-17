package com.splitwiseai.app

import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.splitwiseai.ledger.*
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in native Android inference, using synthetic ledger records in isolated storage. */
class DesktopModelTest {
    @Test
    fun nativeModelPreparesCorrectSplit() =
        runBlocking<Unit> {
            assumeTrue(InstrumentationRegistry.getArguments().getString("desktopAiSmoke") == "true")
            val base = InstrumentationRegistry.getInstrumentation().targetContext
            val root = File(base.cacheDir, "desktop-model-${id()}")
            val isolated =
                object : ContextWrapper(base) {
                    override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
                }
            val storage = WorkspaceStorage(isolated)
            val ledger = storage.ledger
            val alex = ledger.addPerson("Alex", "alex", "Friend")
            val expense =
                ledger.manual(
                    obj(
                        "description" to "CAFE lunch",
                        "amountCents" to 1200,
                        "date" to "2026-10-15",
                        "category" to "Food & Drink",
                    )
                )
            val multiple =
                InstrumentationRegistry.getArguments().getString("desktopMultiple") == "true"
            val extra =
                if (multiple)
                    ledger.manual(
                        obj(
                            "description" to "Coffee",
                            "amountCents" to 1001,
                            "date" to "2026-10-15",
                            "category" to "Food & Drink",
                        )
                    )
                else null
            val selected = listOfNotNull(expense, extra)
            val job = id()
            ledger.insert(
                "jobs",
                obj(
                    "id" to job,
                    "kind" to "chat",
                    "status" to "running",
                    "payload" to "{}",
                    "createdAt" to now(),
                    "updatedAt" to now(),
                ),
            )
            val manager = ModelManager(base)
            val model = manager.models.first { it.id == "e4b" }
            assertTrue("Load the local model into the emulator first", manager.ready(model))
            val general =
                InstrumentationRegistry.getArguments().getString("desktopGeneral") == "true"
            val prompt =
                if (general)
                    "Please split the selected lunch equally between @me and @alex. Category Food & Drink."
                else if (multiple)
                    "Split these expenses equally between @me and @alex. Category Food & Drink."
                else
                    "Split the selected lunch equally between @me and @alex. Category Food & Drink."
            val repeats =
                InstrumentationRegistry.getArguments()
                    .getString("desktopRepeats", "1")
                    .toInt()
                    .coerceIn(1, 3)
            try {
                LocalLlmEngine(base, manager).use { engine ->
                    repeat(repeats) { iteration ->
                        val start = System.nanoTime()
                        val (plan, reply) =
                            withTimeout(240_000) {
                                engine.ask(ledger, model, prompt, selected, job) { status, _ ->
                                    android.util.Log.i("DesktopModelTest", status)
                                }
                            }
                        assertEquals(selected.size, plan.updates.size)
                        assertEquals(
                            setOf(Share("self", 600), Share(alex, 600)),
                            plan.updates
                                .single { it.s("id") == expense }
                                .o("proposal")
                                .shares()
                                .toSet(),
                        )
                        if (extra != null)
                            assertEquals(
                                setOf(Share("self", 500), Share(alex, 501)),
                                plan.updates
                                    .single { it.s("id") == extra }
                                    .o("proposal")
                                    .shares()
                                    .toSet(),
                            )
                        if (iteration == repeats - 1)
                            ledger.commitPlan(job, plan, prompt, selected.toSet(), job)
                        assertEquals("inbox", ledger.tx(expense).s("state"))
                        assertTrue(ledger.dashboard().all { it.outstandingCents == 0L })
                        android.util.Log.i(
                            "DesktopModelTest",
                            "PASS: iteration=${iteration + 1}; selected=${selected.size}; general=$general; correct split amounts, confirmation pending; seconds=${(System.nanoTime() - start) / 1_000_000_000}; reply=$reply",
                        )
                    }
                }
            } finally {
                ledger.db.close()
            }
        }
}
