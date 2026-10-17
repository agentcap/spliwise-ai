package com.splitwiseai.app

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.JsonObject
import com.splitwiseai.ledger.*
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class WorkspaceState(
    val loading: Boolean = true,
    val error: String = "",
    val notice: String = "",
    val people: List<JsonObject> = emptyList(),
    val transactions: List<JsonObject> = emptyList(),
    val accounts: List<JsonObject> = emptyList(),
    val categories: List<JsonObject> = emptyList(),
    val trips: List<JsonObject> = emptyList(),
    val rules: List<JsonObject> = emptyList(),
    val ruleChanges: List<JsonObject> = emptyList(),
    val contexts: List<JsonObject> = emptyList(),
    val templates: List<JsonObject> = emptyList(),
    val aliases: List<JsonObject> = emptyList(),
    val payments: List<JsonObject> = emptyList(),
    val messages: List<JsonObject> = emptyList(),
    val requests: List<JsonObject> = emptyList(),
    val events: List<JsonObject> = emptyList(),
    val jobs: List<JsonObject> = emptyList(),
    val imports: List<JsonObject> = emptyList(),
    val balances: List<PersonBalance> = emptyList(),
    val settings: JsonObject = JsonObject(),
    val activeJob: String = "",
    val activity: String = "",
    val liveText: String = "",
    val workspacePreview: JsonObject? = null,
    val statement: StatementPreview? = null,
    val transfer: TransferPreview? = null,
    val imported: Pair<String, List<Reference>>? = null,
    val selectedModel: String = "e4b",
    val dark: Boolean = true,
    val olderMessages: Boolean = false,
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val context = application.applicationContext
    private val preferences = context.getSharedPreferences("mobile", 0)
    private val stateMutable =
        MutableStateFlow(
            WorkspaceState(
                selectedModel = preferences.getString("model", "e4b") ?: "e4b",
                dark = preferences.getBoolean("dark", true),
            )
        )
    val state = stateMutable.asStateFlow()
    val models = ModelManager(context)
    private val engine = LocalLlmEngine(context, models)
    private lateinit var storage: WorkspaceStorage
    private val operations = Mutex()
    private val runner = Mutex()
    private var inference: Job? = null
    private var download: Job? = null
    private var messageLimit = 200
    private val store
        get() = storage.ledger

    init {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                storage = WorkspaceStorage(context)
                refresh()
            } catch (e: Exception) {
                stateMutable.update {
                    it.copy(loading = false, error = e.message ?: "Unable to open workspace.")
                }
            }
        }
    }

    fun clearError() {
        stateMutable.update { it.copy(error = "", notice = "") }
    }

    fun clearNotice() {
        stateMutable.update { it.copy(notice = "") }
    }

    fun perform(label: String = "Saved", work: (Ledger) -> Unit) {
        viewModelScope.launch(Dispatchers.IO) {
            operations.withLock {
                try {
                    work(store)
                    refresh()
                    stateMutable.update { it.copy(notice = label) }
                } catch (e: Exception) {
                    stateMutable.update {
                        it.copy(error = e.message ?: "Unable to complete action.")
                    }
                }
            }
        }
    }

    private fun refresh() {
        val s = store
        stateMutable.update {
            it.copy(
                loading = false,
                people = s.people(),
                transactions = s.transactions(),
                accounts = s.all("SELECT * FROM accounts ORDER BY name"),
                categories = s.all("SELECT * FROM categories ORDER BY name"),
                trips = s.all("SELECT * FROM trips ORDER BY \"from\" DESC"),
                rules = s.all("SELECT * FROM rules WHERE active=1 ORDER BY title"),
                ruleChanges =
                    s.all("SELECT * FROM rule_changes WHERE status='proposed' ORDER BY rowid"),
                contexts = s.all("SELECT * FROM user_context ORDER BY updatedAt DESC"),
                templates = s.all("SELECT * FROM split_templates ORDER BY name"),
                aliases = s.all("SELECT * FROM merchant_aliases ORDER BY name"),
                payments = s.all("SELECT * FROM repayments ORDER BY date DESC,id"),
                messages =
                    s.all(
                        "SELECT * FROM (SELECT rowid,* FROM messages ORDER BY rowid DESC LIMIT ?) ORDER BY rowid",
                        messageLimit,
                    ),
                olderMessages =
                    (s.one("SELECT COUNT(*) n FROM messages")?.n("n") ?: 0) > messageLimit,
                requests =
                    s.all(
                        "SELECT * FROM assistant_requests WHERE status='pending' OR id IN(SELECT id FROM assistant_requests ORDER BY rowid DESC LIMIT 100) ORDER BY rowid"
                    ),
                events =
                    s.all(
                        "SELECT e.*,b.undoneAt FROM assistant_events e JOIN action_batches b ON b.id=e.batchId ORDER BY e.rowid DESC LIMIT 100"
                    ),
                jobs = s.all("SELECT * FROM jobs ORDER BY rowid DESC LIMIT 50"),
                imports =
                    s.all("SELECT * FROM imports WHERE status='confirmed' ORDER BY createdAt DESC"),
                balances = s.dashboard(),
                settings =
                    s.one("SELECT * FROM workspace_settings WHERE id='main'") ?: JsonObject(),
            )
        }
    }

    fun enqueue(
        text: String,
        selected: List<String>? = null,
        process: Boolean = false,
        trip: String? = null,
    ) {
        require((text.isNotBlank() || process) && text.length <= 12000)
        perform("Queued") { s ->
            val ids =
                if (trip != null)
                    s.all("SELECT id FROM transactions WHERE tripId=? AND state!='finalized'", trip)
                        .map { it.s("id") }
                else selected
            if (ids != null)
                require(ids.isNotEmpty() && ids.all { s.tx(it).s("state") != "finalized" }) {
                    "Choose unfinished expenses."
                }
            s.resolveMentions(text)
            if (!process && !ids.isNullOrEmpty()) s.saveChatContext(ids, text.trim())
            val key = id()
            s.insert(
                "jobs",
                obj(
                    "id" to key,
                    "kind" to if (process) "process" else "chat",
                    "payload" to obj("text" to text.trim(), "ids" to ids),
                    "createdAt" to now(),
                    "updatedAt" to now(),
                ),
            )
            s.insert(
                "messages",
                obj(
                    "id" to id(),
                    "role" to "user",
                    "text" to
                        if (process && text.isBlank()) "Process selected expenses" else text.trim(),
                    "jobId" to key,
                    "transactionIds" to (ids ?: emptyList<String>()),
                    "createdAt" to now(),
                ),
            )
            viewModelScope.launch { runQueue() }
        }
    }

    private suspend fun runQueue() {
        if (!runner.tryLock()) return
        try {
            while (true) {
                val job =
                    store.one(
                        "SELECT * FROM jobs WHERE status='queued' AND cancelRequested=0 ORDER BY rowid LIMIT 1"
                    ) ?: break
                val task = viewModelScope.launch(Dispatchers.IO) { runJob(job) }
                inference = task
                task.join()
                inference = null
            }
        } finally {
            runner.unlock()
            stateMutable.update { it.copy(activeJob = "", activity = "", liveText = "") }
        }
    }

    private suspend fun runJob(job: JsonObject) {
        val key = job.s("id")
        val p = job.doc("payload")
        val ids = p.get("ids")?.takeIf { it.isJsonArray }?.asJsonArray?.map { it.asString }
        val text = p.s("text")
        store.db.execute(
            "UPDATE jobs SET status='running',error='',attempts=attempts+1,updatedAt=? WHERE id=?",
            now(),
            key,
        )
        stateMutable.update { it.copy(activeJob = key, activity = "Starting", liveText = "") }
        refresh()
        val progress: (String, String) -> Unit = { activity, response ->
            stateMutable.update { it.copy(activity = activity, liveText = response) }
        }
        try {
            val model = models.models.first { it.id == state.value.selectedModel }
            var reply: String
            if (job.s("kind") == "process") {
                val targets = requireNotNull(ids)
                val start =
                    store.one("SELECT cursor FROM jobs WHERE id=?", key)!!.n("cursor").toInt()
                targets.drop(start).chunked(20).forEachIndexed { chunkIndex, chunk ->
                    currentCoroutineContext().ensureActive()
                    progress(
                        "Processing ${minOf(start + chunkIndex * 20 + 20, targets.size)} of ${targets.size}",
                        "",
                    )
                    val plan = AssistantPlan()
                    val needsModel = mutableListOf<String>()
                    chunk.forEach { txId ->
                        val t = store.tx(txId)
                        if (t.s("state") == "finalized") return@forEach
                        try {
                            val result =
                                when {
                                    t.s("instruction").isNotBlank() -> null
                                    t.n("amountCents") < 0 -> {
                                        fun merchant(v: String) =
                                            normalized(v)
                                                .replace(Regex("\\*[\\w-]+"), "")
                                                .replace(Regex("\\d+"), "")
                                                .trim()
                                        val candidates =
                                            store
                                                .transactions()
                                                .filter {
                                                    it.s("state") == "finalized" &&
                                                        it.n("amountCents") > 0 &&
                                                        it.s("accountId") == t.s("accountId") &&
                                                        it.s("date") <= t.s("date") &&
                                                        merchant(it.s("description")) ==
                                                            merchant(t.s("description"))
                                                }
                                                .filter {
                                                    runCatching {
                                                        store.linkedRefund(txId, it.s("id"))
                                                    }
                                                        .isSuccess
                                                }
                                        if (candidates.size == 1)
                                            store.linkedRefund(txId, candidates.single().s("id"))
                                        else null
                                    }
                                    t.s("tripId").isNotEmpty() ->
                                        if (
                                            store.row("trips", t.s("tripId")).s("context").isBlank()
                                        )
                                            store.tripProposal(t)
                                        else null
                                    else -> store.ruleProposal(t)
                                }
                            if (result == null) needsModel.add(txId)
                            else
                                plan.updates.add(
                                    obj(
                                        "id" to txId,
                                        "version" to t.n("version"),
                                        "state" to "ready",
                                        "proposal" to result,
                                    )
                                )
                        } catch (e: Exception) {
                            plan.updates.add(
                                obj(
                                    "id" to txId,
                                    "version" to t.n("version"),
                                    "state" to "inbox",
                                    "proposal" to null,
                                    "attention" to e.message,
                                )
                            )
                        }
                    }
                    if (needsModel.isNotEmpty() && models.ready(model)) {
                        val (ai, _) =
                            engine.ask(
                                store,
                                model,
                                "Process the selected expenses. Follow individual saved instructions, scoped context, trip context, then matching active rules. Ask a focused question if evidence is insufficient.\n$text",
                                needsModel,
                                key,
                                progress,
                            )
                        plan.updates.addAll(ai.updates)
                        plan.organization.addAll(ai.organization)
                        plan.requests.addAll(ai.requests)
                    } else
                        needsModel.forEach { txId ->
                            val t = store.tx(txId)
                            plan.updates.add(
                                obj(
                                    "id" to txId,
                                    "version" to t.n("version"),
                                    "state" to "inbox",
                                    "proposal" to null,
                                    "attention" to
                                        "No deterministic split found. Download an AI model or enter a manual split.",
                                )
                            )
                        }
                    currentCoroutineContext().ensureActive()
                    val cursor = minOf(start + (chunkIndex + 1) * 20, targets.size)
                    store.db.transaction {
                        store.commitPlan(
                            key,
                            plan,
                            trustedText(text, chunk),
                            targets.toSet(),
                            "$key:$cursor",
                        )
                        store.db.execute(
                            "UPDATE jobs SET cursor=?,progress=?,updatedAt=? WHERE id=?",
                            cursor,
                            cursor * 100 / maxOf(1, targets.size),
                            now(),
                            key,
                        )
                    }
                    refresh()
                }
                reply =
                    "Processed ${targets.size} expenses. Review the confirmation cards before applying split changes. Finalize Ready splits separately to update balances."
            } else {
                val (plan, answer) = engine.ask(store, model, text, ids, key, progress)
                currentCoroutineContext().ensureActive()
                store.commitPlan(
                    key,
                    plan,
                    trustedText(text, ids ?: emptyList()),
                    ids?.toSet(),
                    key,
                )
                reply = answer
            }
            store.db.transaction {
                store.insert(
                    "messages",
                    obj(
                        "id" to id(),
                        "role" to "assistant",
                        "text" to reply,
                        "jobId" to key,
                        "transactionIds" to (ids ?: emptyList<String>()),
                        "createdAt" to now(),
                    ),
                )
                store.db.execute(
                    "UPDATE jobs SET status='completed',progress=100,result=?,response=?,updatedAt=? WHERE id=?",
                    reply,
                    reply,
                    now(),
                    key,
                )
            }
        } catch (e: Throwable) {
            store.db.execute(
                "UPDATE jobs SET status=?,error=?,updatedAt=? WHERE id=?",
                if (e is CancellationException) "cancelled" else "failed",
                if (e is CancellationException)
                    "Stopped. Completed confirmation cards are retained."
                else e.message ?: "Model processing failed.",
                now(),
                key,
            )
        } finally {
            stateMutable.update { it.copy(activeJob = "", activity = "", liveText = "") }
            refresh()
        }
    }

    private fun trustedText(text: String, ids: List<String>): String =
        (listOf(text) +
                store
                    .all("SELECT text FROM messages WHERE role='user' ORDER BY rowid DESC LIMIT 8")
                    .map { it.s("text") } +
                ids.flatMap { store.tx(it).docs("notes").map { n -> n.s("text") } })
            .joinToString("\n")

    fun stop() {
        state.value.activeJob
            .takeIf { it.isNotEmpty() }
            ?.let { key ->
                store.db.execute("UPDATE jobs SET cancelRequested=1 WHERE id=?", key)
                engine.stop()
                inference?.cancel()
            }
    }

    fun retry(key: String) =
        perform("Resuming") { s ->
            require(
                s.one("SELECT status FROM jobs WHERE id=?", key)?.s("status") in
                    setOf("failed", "cancelled")
            )
            s.db.execute(
                "UPDATE jobs SET status='queued',cancelRequested=0,error='',updatedAt=? WHERE id=?",
                now(),
                key,
            )
            viewModelScope.launch { runQueue() }
        }

    fun cancelQueued(key: String) =
        perform("Cancelled") {
            it.db.execute(
                "UPDATE jobs SET status='cancelled',cancelRequested=1,updatedAt=? WHERE id=? AND status='queued'",
                now(),
                key,
            )
        }

    fun loadOlderMessages() = perform("") { messageLimit += 200 }

    fun toggleTheme() {
        val dark = !state.value.dark
        preferences.edit().putBoolean("dark", dark).apply()
        stateMutable.update { it.copy(dark = dark) }
    }

    fun selectModel(id: String) {
        if (state.value.activeJob.isNotEmpty()) {
            stateMutable.update { it.copy(error = "Stop processing before changing models.") }
            return
        }
        preferences.edit().putString("model", id).apply()
        stateMutable.update { it.copy(selectedModel = id) }
    }

    fun download(model: ModelFile, cellular: Boolean) {
        if (download?.isActive == true) return
        download = viewModelScope.launch {
            try {
                models.download(model, cellular)
            } catch (e: CancellationException) {
                /* Resume uses the verified partial range. */
            } catch (e: Exception) {
                stateMutable.update { it.copy(error = e.message ?: "Download failed.") }
            }
        }
    }

    fun pauseDownload() {
        download?.cancel()
    }

    fun importModel(model: ModelFile, uri: Uri) {
        if (download?.isActive == true) return
        download = viewModelScope.launch {
            var locked = false
            try {
                require(runner.tryLock()) { "Stop processing before importing a model." }
                locked = true
                require(state.value.activeJob.isEmpty()) { "Stop processing before importing a model." }
                engine.close()
                models.importFile(model, uri)
                selectModel(model.id)
                stateMutable.update { it.copy(notice = "Model imported and selected") }
            } catch (e: CancellationException) {
                /* Imports are verified from the start when retried. */
            } catch (e: Exception) {
                stateMutable.update { it.copy(error = e.message ?: "Import failed.") }
            } finally {
                if (locked) runner.unlock()
            }
        }
    }

    fun removeModel(model: ModelFile) =
        perform("Model removed") {
            require(runner.tryLock()) { "Stop processing before removing a model." }
            try {
                require(state.value.activeJob.isEmpty())
                engine.close()
                models.remove(model)
            } finally {
                runner.unlock()
            }
        }

    fun previewWorkspace(uri: Uri) =
        perform("Workspace ready to review") {
            require(state.value.activeJob.isEmpty())
            stateMutable.update { it.copy(workspacePreview = storage.preview(uri)) }
        }

    fun confirmWorkspace() =
        perform("Workspace imported") {
            require(runner.tryLock()) { "Stop processing before importing a workspace." }
            try {
                require(
                    store.one("SELECT id FROM jobs WHERE status IN ('queued','running') LIMIT 1") ==
                        null
                ) {
                    "Finish or cancel queued jobs before importing a workspace."
                }
                storage.restore()
                messageLimit = 200
                stateMutable.update { it.copy(workspacePreview = null) }
            } finally {
                runner.unlock()
            }
        }

    fun dismissWorkspace() {
        storage.discardPreview()
        stateMutable.update { it.copy(workspacePreview = null) }
    }

    fun previewStatement(uri: Uri, account: String) =
        perform("Statement ready to review") { s ->
            val bytes = readLimited(uri, 10_000_000)
            stateMutable.update {
                it.copy(
                    statement =
                        s.previewStatement(account, filename(uri), bytes.toString(Charsets.UTF_8))
                )
            }
        }

    fun confirmStatement(ack: Boolean, invalid: Boolean, keep: Set<Int>) =
        perform("Statement imported") { s ->
            val preview = requireNotNull(state.value.statement)
            val refs = s.confirmStatement(preview, ack, invalid, keep)
            stateMutable.update {
                it.copy(
                    statement = null,
                    imported = if (refs.isEmpty()) null else preview.id to refs,
                )
            }
        }

    fun finishStatement(context: String, process: Boolean, from: String, to: String) =
        perform("Import complete") { s ->
            val (key, refs) = requireNotNull(state.value.imported)
            val ids = s.finishImport(key, refs, context, process, from, to)
            stateMutable.update { it.copy(imported = null) }
            if (ids.isNotEmpty()) enqueue("", ids, true)
        }

    fun previewJson(uri: Uri) =
        perform("Review the participant and duplicate matches") { s ->
            stateMutable.update {
                it.copy(
                    transfer =
                        s.previewTransfer(readLimited(uri, 10_000_000).toString(Charsets.UTF_8))
                )
            }
        }

    fun confirmJson(people: Boolean, skips: Boolean, keep: Set<Int>) =
        perform("JSON imported for review") { s ->
            s.confirmTransfer(requireNotNull(state.value.transfer), people, skips, keep)
            stateMutable.update { it.copy(transfer = null) }
        }

    fun dismissImport() {
        stateMutable.update { it.copy(statement = null, transfer = null) }
    }

    private fun readLimited(uri: Uri, limit: Int): ByteArray =
        context.contentResolver.openInputStream(uri)!!.use { source ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(65536)
            var total = 0
            while (true) {
                val n = source.read(buffer)
                if (n < 0) break
                total += n
                require(total <= limit) { "File exceeds ${limit / 1_000_000} MB." }
                output.write(buffer, 0, n)
            }
            output.toByteArray()
        }

    private fun filename(uri: Uri): String =
        context.contentResolver
            .query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "Imported file"

    fun attach(uri: Uri, transaction: String) =
        perform("Receipt attached") {
            it.attachment(
                transaction,
                filename(uri),
                context.contentResolver.getType(uri) ?: "",
                readLimited(uri, 5_000_000),
            )
        }

    fun shareReceipt(key: String) =
        perform("Receipt ready") { s ->
            val a = s.row("attachments", key)
            share(
                writeExport(a.s("name"), java.util.Base64.getDecoder().decode(a.s("data"))),
                a.s("mime"),
            )
        }

    fun attachments(key: String, receive: (List<JsonObject>) -> Unit) =
        perform("") {
            receive(
                it.all(
                    "SELECT id,name,mime,size,createdAt FROM attachments WHERE transactionId=? ORDER BY createdAt",
                    key,
                )
            )
        }

    fun shareWorkspace(recovery: Boolean = false) =
        perform("Backup ready") {
            share(
                if (recovery) storage.exportRecovery() else storage.export(),
                "application/vnd.sqlite3",
            )
        }

    fun export(kind: String, from: String = "", to: String = "", filter: String = "") =
        perform("Export ready") { s ->
            val text =
                if (kind == "csv") s.exportCsv(from, to, filter)
                else s.exportTransfer(kind, from, to, filter)
            share(
                writeExport(
                    "splitwise-ai-$kind.${if (kind == "csv") "csv" else "json"}",
                    text.toByteArray(),
                ),
                if (kind == "csv") "text/csv" else "application/json",
            )
        }

    fun shareSettlement(person: String, from: String = "", to: String = "", trip: String = "") =
        perform("Summary ready") {
            share(
                writeExport(
                    "expense-summary.txt",
                    it.settlement(person, from, to, trip).toByteArray(),
                ),
                "text/plain",
            )
        }

    private fun writeExport(name: String, bytes: ByteArray) =
        File(context.cacheDir, "exports/${name.replace(Regex("[^\\p{L}\\p{N} ._()-]"), "_")}")
            .apply {
                parentFile!!.mkdirs()
                writeBytes(bytes)
            }

    private fun share(file: File, mime: String) {
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
        val intent =
            Intent(Intent.ACTION_SEND)
                .setType(mime)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        viewModelScope.launch(Dispatchers.Main) {
            context.startActivity(
                Intent.createChooser(intent, "Save or share")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
    }

    fun savedViews(): List<JsonObject> = runCatching {
        json(preferences.getString("views", "[]")!!).asJsonArray.map { it.asJsonObject }
    }
        .getOrDefault(emptyList())

    fun saveView(view: JsonObject) {
        val list = savedViews().filter { it.s("name") != view.s("name") } + view
        preferences.edit().putString("views", gson.toJson(list)).apply()
    }

    fun removeView(name: String) {
        preferences
            .edit()
            .putString("views", gson.toJson(savedViews().filter { it.s("name") != name }))
            .apply()
    }

    override fun onCleared() {
        download?.cancel()
        engine.stop()
        val pending = inference
        CoroutineScope(Dispatchers.IO).launch {
            pending?.cancelAndJoin()
            operations.withLock {
                runCatching { engine.close() }
                if (::storage.isInitialized) runCatching { storage.ledger.db.close() }
            }
        }
    }
}
