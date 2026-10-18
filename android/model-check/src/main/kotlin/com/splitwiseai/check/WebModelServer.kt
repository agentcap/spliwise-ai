package com.splitwiseai.check

import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.LogSeverity
import com.google.gson.JsonObject
import com.splitwiseai.assistant.InferenceSession
import com.splitwiseai.ledger.*
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.sql.DriverManager
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import kotlinx.coroutines.*

private class WebSnapshot : LedgerDatabase {
    private val connection = DriverManager.getConnection("jdbc:sqlite::memory:")
    private var depth = 0
    override fun rows(sql: String, vararg args: Any?): List<JsonObject> =
        connection.prepareStatement(sql).use { statement ->
            args.forEachIndexed { i, value -> statement.setObject(i + 1, value) }
            statement.executeQuery().use { result ->
                buildList {
                    while (result.next()) add(JsonObject().apply {
                        repeat(result.metaData.columnCount) { i ->
                            add(result.metaData.getColumnName(i + 1), gson.toJsonTree(result.getObject(i + 1)))
                        }
                    })
                }
            }
        }
    override fun execute(sql: String, vararg args: Any?) {
        connection.prepareStatement(sql).use { statement ->
            args.forEachIndexed { i, value -> statement.setObject(i + 1, value) }
            statement.execute()
        }
    }
    override fun <T> transaction(work: () -> T): T {
        val outer = depth == 0
        if (outer) execute("BEGIN IMMEDIATE")
        depth++
        try {
            val result = work()
            if (outer) execute("COMMIT")
            return result
        } catch (e: Throwable) {
            if (outer) execute("ROLLBACK")
            throw e
        } finally { depth-- }
    }
    override fun close() = connection.close()
}

private val snapshotTables = setOf(
    "people", "accounts", "categories", "imports", "transactions", "rules", "rule_changes",
    "repayments", "trips", "split_templates", "merchant_aliases", "attachments", "user_context",
    "messages", "workspace_settings", "ledger_revision",
)
private const val mobileModelHash = "035b5fb51f5f7a48634c3ebb6bb64725beb0dfe7a7ad72f6cde90750884690de"

/** Loopback-only inference. Each request uses an in-memory copy, never a live web database. */
fun webModelServer(args: Array<String>) {
    require(args.size == 4) { "Usage: --serve-web ROOT MODEL TOKEN_FILE PORT" }
    val root = File(args[0])
    val model = File(args[1])
    val token = File(args[2]).readText().trim()
    require(token.length >= 32)
    val hash = MessageDigest.getInstance("SHA-256")
    model.inputStream().use { input ->
        val buffer = ByteArray(1024 * 1024)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            hash.update(buffer, 0, count)
        }
    }
    require(hash.digest().joinToString("") { "%02x".format(it) } == mobileModelHash) { "Wrong fine-tuned model." }
    Engine.setNativeMinLogSeverity(LogSeverity.ERROR)
    val session = InferenceSession(File(root, ".tools/finetune/web-model/cache").apply { mkdirs() },
        preferGpu = System.getenv("FINETUNED_MODEL_BACKEND") == "gpu", speculativeDecoding = false,
        cpuThreadCount = 6)
    val gate = Semaphore(1)
    var activeId = ""
    var activeJob: Job? = null
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", args[3].toInt()), 8)
    val executor = Executors.newFixedThreadPool(3)
    server.executor = executor
    fun respond(exchange: HttpExchange, code: Int, body: JsonObject) {
        val bytes = gson.toJson(body).toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", "application/json")
        exchange.responseHeaders.set("Cache-Control", "no-store")
        exchange.sendResponseHeaders(code, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
    server.createContext("/") { exchange ->
        try {
            val authorization = exchange.requestHeaders.getFirst("Authorization") ?: ""
            if (!MessageDigest.isEqual(authorization.toByteArray(), "Bearer $token".toByteArray())) {
                respond(exchange, 401, obj("error" to "Unauthorized"))
            } else if (exchange.requestMethod == "GET" && exchange.requestURI.path == "/health") {
                respond(exchange, 200, obj("model" to "gemma-v2", "sha256" to mobileModelHash, "ready" to true))
            } else if (exchange.requestMethod == "DELETE" && exchange.requestURI.path.startsWith("/infer/")) {
                synchronized(gate) {
                    if (exchange.requestURI.path.removePrefix("/infer/") == activeId) {
                        session.stop()
                        activeJob?.cancel()
                    }
                }
                respond(exchange, 200, obj("cancelled" to true))
            } else if (exchange.requestMethod != "POST" || exchange.requestURI.path != "/infer") {
                respond(exchange, 404, obj("error" to "Not found"))
            } else if (!gate.tryAcquire()) {
                respond(exchange, 503, obj("error" to "The fine-tuned model is busy. Try again shortly."))
            } else {
                try {
                    val bytes = exchange.requestBody.readNBytes(64 * 1024 * 1024 + 1)
                    require(bytes.size <= 64 * 1024 * 1024) { "Workspace is too large for local inference." }
                    val body = json(String(bytes, Charsets.UTF_8)).asJsonObject
                    val text = body.s("text")
                    require(text.length in 1..20000)
                    val requestId = body.s("requestId")
                    require(requestId.matches(Regex("[a-zA-Z0-9-]{1,100}")))
                    WebSnapshot().use { db ->
                        val journal = json(File(root, "drizzle/meta/_journal.json").readText()).asJsonObject
                        journal.a("entries").forEach { entry ->
                            File(root, "drizzle/${entry.asJsonObject.s("tag")}.sql").readText()
                                .split("--> statement-breakpoint").filter { it.isNotBlank() }
                                .forEach { db.execute(it) }
                        }
                        db.transaction {
                            for ((table, value) in body.o("tables").entrySet()) {
                                require(table in snapshotTables)
                                val columns = db.rows("PRAGMA table_info(\"$table\")").map { it.s("name") }.toSet()
                                db.execute("DELETE FROM \"$table\"")
                                for (item in value.asJsonArray) {
                                    val row = item.asJsonObject
                                    require(row.size() > 0 && row.keySet().all { it in columns })
                                    val names = row.keySet().toList()
                                    val values: List<Any?> = names.map { name ->
                                        val v = row[name]
                                        when {
                                            v.isJsonNull -> null
                                            v.asJsonPrimitive.isBoolean -> if (v.asBoolean) 1 else 0
                                            v.asJsonPrimitive.isNumber -> v.asBigDecimal
                                            else -> v.asString
                                        }
                                    }
                                    db.execute("INSERT INTO \"$table\" (${names.joinToString(",") { "\"$it\"" }}) VALUES(${names.joinToString(",") { "?" }})", *values.toTypedArray())
                                }
                            }
                        }
                        val ledger = Ledger(db)
                        val job = id()
                        ledger.insert("jobs", obj("id" to job, "kind" to "chat", "status" to "running",
                            "payload" to "{}", "createdAt" to now(), "updatedAt" to now()))
                        val ids = body.get("ids")?.takeUnless { it.isJsonNull }?.asJsonArray?.map { it.asString }
                        val result = runBlocking {
                            synchronized(gate) { activeId = requestId; activeJob = coroutineContext[Job] }
                            withTimeout(180000) {
                                session.ask(ledger, model.path, "Fine-tuned Gemma E2B", text, ids, job,
                                    reducedInterface = true) { _, _ -> }
                            }
                        }
                        respond(exchange, 200, obj("plan" to result.first, "message" to result.second))
                    }
                } finally {
                    synchronized(gate) { activeId = ""; activeJob = null }
                    gate.release()
                }
            }
        } catch (_: Exception) {
            runCatching { respond(exchange, 500, obj("error" to "Local inference failed. Try a shorter request or restart the local model service.")) }
        } finally { exchange.close() }
    }
    Runtime.getRuntime().addShutdownHook(Thread {
        server.stop(0)
        activeJob?.cancel()
        session.close()
        executor.shutdownNow()
    })
    server.start()
    println("Fine-tuned web model ready on 127.0.0.1:${args[3]}")
}
