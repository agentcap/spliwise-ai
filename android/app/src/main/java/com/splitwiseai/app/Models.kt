package com.splitwiseai.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import com.splitwiseai.ledger.*
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.OkHttpClient
import okhttp3.Request

data class ModelFile(
    val id: String,
    val name: String,
    val filename: String,
    val url: String,
    val sha256: String,
    val size: Long,
    val license: String,
    val source: String,
    val toolInterface: String? = null,
)

data class ModelProgress(
    val id: String = "",
    val bytes: Long = 0,
    val total: Long = 0,
    val status: String = "",
    val running: Boolean = false,
)

class ModelManager(private val context: Context) {
    val models =
        context.assets.open("models.json").bufferedReader().use {
            gson.fromJson(it, Array<ModelFile>::class.java).toList()
        }
    private val directory = File(context.noBackupFilesDir, "models").apply { mkdirs() }
    private val mutable = MutableStateFlow(ModelProgress())
    val progress: StateFlow<ModelProgress> = mutable.asStateFlow()
    private val client =
        OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build()

    fun file(model: ModelFile) = File(directory, model.filename)

    fun ready(model: ModelFile): Boolean =
        file(model).length() == model.size &&
            File(directory, model.filename + ".verified").readTextOrEmpty() == model.sha256

    fun partial(model: ModelFile) = File(directory, model.filename + ".partial").length()

    fun remove(model: ModelFile) {
        file(model).delete()
        File(directory, model.filename + ".partial").delete()
        File(directory, model.filename + ".verified").delete()
    }

    suspend fun importFile(model: ModelFile, uri: Uri) = withContext(Dispatchers.IO) {
        check(!mutable.value.running) { "A model transfer is already running." }
        require(directory.usableSpace > model.size + 256_000_000) {
            "Free at least ${model.size / 1_000_000} MB plus 256 MB before importing."
        }
        val temporary = File(directory, model.filename + ".importing")
        mutable.value = ModelProgress(model.id, 0, model.size, "Importing", true)
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            var written = 0L
            checkNotNull(context.contentResolver.openInputStream(uri)) { "Unable to open model file." }.use { input ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(262144)
                    while (true) {
                        ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        written += count
                        require(written <= model.size) { "This file is not the expected model." }
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                        mutable.value = ModelProgress(model.id, written, model.size, "Importing and verifying", true)
                    }
                }
            }
            require(written == model.size) { "Model file is incomplete or is a different model." }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            require(actual == model.sha256) { "Model checksum mismatch. Choose the model supplied with this build." }
            check(temporary.renameTo(file(model))) { "Unable to save model." }
            File(directory, model.filename + ".verified").writeText(actual)
            mutable.value = ModelProgress(model.id, model.size, model.size, "Ready for offline use")
        } catch (e: Throwable) {
            mutable.value = mutable.value.copy(status = if (e is CancellationException) "Import cancelled" else e.message ?: "Import failed", running = false)
            throw e
        } finally {
            temporary.delete()
        }
    }

    suspend fun download(model: ModelFile, cellular: Boolean = false) =
        withContext(Dispatchers.IO) {
            check(!mutable.value.running) { "A model download is already running." }
            val connectivity = context.getSystemService(ConnectivityManager::class.java)
            val wifi =
                connectivity.activeNetwork?.takeIf {
                    connectivity
                        .getNetworkCapabilities(it)
                        ?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
                }
            require(cellular || wifi != null) {
                "Connect to Wi-Fi or enable mobile-data downloads."
            }
            val part = File(directory, model.filename + ".partial")
            if (part.length() > model.size) part.delete()
            require(directory.usableSpace > model.size - part.length() + 256_000_000) {
                "Free at least ${(model.size - part.length()) / 1_000_000} MB plus 256 MB before downloading."
            }
            mutable.value = ModelProgress(model.id, part.length(), model.size, "Downloading", true)
            try {
                val offset = part.length()
                val request =
                    Request.Builder()
                        .url(model.url)
                        .apply { if (offset > 0) header("Range", "bytes=$offset-") }
                        .build()
                // Bind Wi-Fi-only downloads to that network. Losing Wi-Fi must not
                // silently retry a multi-gigabyte download over mobile data.
                val transport =
                    if (cellular) client
                    else {
                        val network = requireNotNull(wifi)
                        client
                            .newBuilder()
                            .socketFactory(network.socketFactory)
                            .dns(
                                object : okhttp3.Dns {
                                    override fun lookup(hostname: String) =
                                        network.getAllByName(hostname).toList()
                                }
                            )
                            .build()
                    }
                val call = transport.newCall(request)
                val cancellation =
                    launch(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            awaitCancellation()
                        } finally {
                            call.cancel()
                        }
                    }
                try {
                    call.execute().use { response ->
                        require(response.isSuccessful) {
                            "Model download failed (${response.code}). Resume to try again."
                        }
                        val resume = response.code == 206
                        if (resume)
                            require(
                                response.header("Content-Range")?.startsWith("bytes $offset-") ==
                                    true
                            ) {
                                "Unexpected download range."
                            }
                        var written = if (resume) offset else 0L
                        RandomAccessFile(part, "rw").use { target ->
                            if (!resume) target.setLength(0)
                            target.seek(written)
                            response.body!!.byteStream().use { source ->
                                val buffer = ByteArray(262144)
                                while (true) {
                                    ensureActive()
                                    val count = source.read(buffer)
                                    if (count < 0) break
                                    target.write(buffer, 0, count)
                                    written += count
                                    require(written <= model.size) { "Unexpected model size." }
                                    mutable.value =
                                        ModelProgress(
                                            model.id,
                                            written,
                                            model.size,
                                            "Downloading",
                                            true,
                                        )
                                }
                            }
                        }
                    }
                } finally {
                    cancellation.cancel()
                }
                require(part.length() == model.size) {
                    "Download incomplete. Resume when connected."
                }
                mutable.value = mutable.value.copy(status = "Verifying download")
                val digest = MessageDigest.getInstance("SHA-256")
                part.inputStream().use { source ->
                    val buffer = ByteArray(262144)
                    while (true) {
                        ensureActive()
                        val n = source.read(buffer)
                        if (n < 0) break
                        digest.update(buffer, 0, n)
                    }
                }
                val actual = digest.digest().joinToString("") { "%02x".format(it) }
                if (actual != model.sha256) {
                    part.delete()
                    error("Model checksum mismatch. Download again.")
                }
                check(part.renameTo(file(model))) { "Unable to save model." }
                File(directory, model.filename + ".verified").writeText(model.sha256)
                mutable.value =
                    ModelProgress(model.id, model.size, model.size, "Ready for offline use")
            } catch (e: Throwable) {
                val cancelled = e is CancellationException || !currentCoroutineContext().isActive
                mutable.value =
                    mutable.value.copy(
                        status =
                            if (cancelled) "Paused — resume download"
                            else e.message ?: "Download failed",
                        running = false,
                    )
                if (cancelled && e !is CancellationException)
                    throw CancellationException("Download paused", e)
                throw e
            }
        }
}

private fun File.readTextOrEmpty(): String = if (exists()) readText() else ""
