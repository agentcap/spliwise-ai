package com.splitwiseai.app

import android.content.Context
import android.os.Build
import android.util.Log
import com.splitwiseai.assistant.InferenceSession
import com.splitwiseai.ledger.*

class LocalLlmEngine(context: Context, private val manager: ModelManager) : AutoCloseable {
    private val emulator = Build.HARDWARE in setOf("ranchu", "goldfish")
    // Android emulators use software graphics; run the model on CPU for desktop testing.
    private val session =
        InferenceSession(
            context.cacheDir,
            preferGpu = !emulator,
            cpuThreadCount =
                if (emulator) Runtime.getRuntime().availableProcessors().coerceIn(1, 8) else null,
        )

    fun stop() = session.stop()

    override fun close() = session.close()

    suspend fun ask(
        store: Ledger,
        model: ModelFile,
        text: String,
        ids: List<String>?,
        job: String,
        progress: (String, String) -> Unit,
    ): Pair<AssistantPlan, String> {
        check(manager.ready(model)) {
            "Download an AI model in Settings first. Manual workflows are ready to use."
        }
        val started = System.nanoTime()
        var loadedMs = 0L
        var firstResponseMs = 0L
        var turns = 0
        try {
            return session.ask(store, manager.file(model).path, model.name, text, ids, job,
                reducedInterface = model.toolInterface == "reduced-v2") {
                stage,
                live ->
                val elapsed = (System.nanoTime() - started) / 1_000_000
                if (stage == "Reading your instructions") {
                    loadedMs = elapsed
                    turns++
                }
                if (stage == "Working locally") turns++
                if (stage.startsWith("Generating on device") && firstResponseMs == 0L)
                    firstResponseMs = elapsed
                progress(stage, live)
            }
        } finally {
            // Timing only: never log prompts, tool arguments, or personal ledger data.
            if (BuildConfig.DEBUG)
                Log.i(
                    "LocalAiPerformance",
                    "model=${model.id} backend=${session.backend} loadMs=$loadedMs firstResponseMs=$firstResponseMs turns=$turns totalMs=${(System.nanoTime() - started) / 1_000_000}",
                )
        }
    }
}
