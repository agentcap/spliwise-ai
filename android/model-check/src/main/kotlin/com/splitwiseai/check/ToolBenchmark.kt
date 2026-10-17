package com.splitwiseai.check

import com.google.ai.edge.litertlm.*
import com.google.gson.*
import com.splitwiseai.assistant.InferenceSession
import com.splitwiseai.ledger.*
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.sql.DriverManager
import java.time.Duration
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect

private class BenchmarkDatabase : LedgerDatabase {
    private val connection = DriverManager.getConnection("jdbc:sqlite::memory:")
    private var depth = 0

    override fun rows(sql: String, vararg args: Any?): List<JsonObject> =
        connection.prepareStatement(sql).use { statement ->
            args.forEachIndexed { i, v -> statement.setObject(i + 1, v) }
            statement.executeQuery().use { result ->
                buildList {
                    while (result.next()) add(
                        JsonObject().apply {
                            repeat(result.metaData.columnCount) { i ->
                                add(
                                    result.metaData.getColumnName(i + 1),
                                    gson.toJsonTree(result.getObject(i + 1)),
                                )
                            }
                        }
                    )
                }
            }
        }

    override fun execute(sql: String, vararg args: Any?) {
        connection.prepareStatement(sql).use { statement ->
            args.forEachIndexed { i, v -> statement.setObject(i + 1, v) }
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
        } finally {
            depth--
        }
    }

    override fun close() = connection.close()
}

private class JsonSchemaTool(private val definition: JsonObject) : OpenApiTool {
    override fun getToolDescriptionJsonString() = gson.toJson(definition)

    override fun execute(paramsJsonString: String): String = error("Manual dispatch only")
}

private fun substitute(value: JsonElement, ids: Map<String, String>): JsonElement =
    when {
        value.isJsonObject ->
            JsonObject().apply {
                value.asJsonObject.entrySet().forEach { (k, v) -> add(k, substitute(v, ids)) }
            }
        value.isJsonArray ->
            JsonArray().apply { value.asJsonArray.forEach { add(substitute(it, ids)) } }
        value.isJsonPrimitive && value.asJsonPrimitive.isString ->
            JsonPrimitive(ids[value.asString] ?: value.asString)
        else -> value.deepCopy()
    }

private data class Fixture(
    val db: BenchmarkDatabase,
    val ledger: Ledger,
    val ids: Map<String, String>,
    val selected: List<String>?,
    val job: String,
)

private fun fixture(root: File, case: JsonObject): Fixture {
    val db = BenchmarkDatabase()
    val ledger = Ledger(db)
    json(File(root, "drizzle/meta/_journal.json").readText()).asJsonObject.a("entries").forEach {
        item ->
        File(root, "drizzle/${item.asJsonObject.s("tag")}.sql")
            .readText()
            .split("--> statement-breakpoint")
            .filter { it.isNotBlank() }
            .forEach { db.execute(it) }
    }
    ledger.seed()
    val ids = mutableMapOf("$" + "self" to "self")
    listOf("alex", "zara", "sam").forEach {
        ids["$$it"] =
            ledger.addPerson(
                it.replaceFirstChar { c -> c.uppercase() },
                it,
                "Friend",
                "user",
                "benchmark-$it",
            )
    }
    case.a("expenses").forEachIndexed { i, item ->
        val expense = item.asJsonObject
        val input =
            obj(
                "description" to expense.s("description", "CAFE lunch"),
                "date" to expense.s("date", "2026-10-15"),
                "amountCents" to kotlin.math.abs(expense.n("amountCents", 1200)),
                "category" to expense.s("category", "Food & Drink"),
            )
        val key = ledger.manual(input)
        if (expense.n("amountCents", 1200) < 0)
            db.execute(
                "UPDATE transactions SET amountCents=? WHERE id=?",
                expense.n("amountCents"),
                key,
            )
        ids["$" + "tx$i"] = key
        if (expense.b("finalized")) {
            ledger.quick(
                ledger.references(listOf(key)),
                SplitSpec("equal", listOf("self", ids.getValue("$" + "alex"))),
                input.s("category"),
            )
            ledger.review(ledger.references(listOf(key)), "approve")
        }
    }
    case.a("seed").forEach { raw ->
        val seed = substitute(raw, ids).asJsonObject
        val symbol = seed.s("symbol")
        val record = seed.o("record")
        val key =
            when (seed.s("kind")) {
                "trip" -> ledger.saveTrip(record)
                "rule" -> ledger.saveRule(record)
                "context" -> ledger.saveOrganization("user_context", record)
                "template" -> ledger.saveOrganization("split_templates", record)
                "repayment" -> {
                    ledger.repayment(record)
                    ""
                }
                else -> error("Unknown fixture kind")
            }
        if (symbol.isNotEmpty()) ids[symbol] = key
    }
    val selected =
        if (!case.has("selected") || case["selected"].isJsonNull) null
        else case.a("selected").map { ids.getValue(it.asString) }
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
    return Fixture(db, ledger, ids, selected, job)
}

private fun summary(f: Fixture) =
    obj(
        "people" to f.ledger.people(),
        "accounts" to f.ledger.all("SELECT * FROM accounts"),
        "balances" to
            f.ledger.dashboard().map {
                obj(
                    "personId" to it.person.s("id"),
                    "outstandingCents" to it.outstandingCents,
                    "creditCents" to it.creditCents,
                )
            },
        "scope" to
            if (f.selected == null) obj("kind" to "workspace")
            else
                obj(
                    "kind" to "selected",
                    "total" to f.selected.size,
                    "firstIds" to f.selected.take(20),
                ),
        "selectedExpenses" to f.selected?.take(20)?.map { f.ledger.tx(it) },
        "today" to "2026-10-16",
    )

private data class Turn(
    val calls: List<JsonObject>,
    val text: String,
    val output: List<JsonElement> = emptyList(),
    val inputTokens: Long = 0,
    val cachedTokens: Long = 0,
    val outputTokens: Long = 0,
    val responseId: String = "",
    val parseError: String? = null,
)

private class NativeBackend(
    model: File,
    cache: File,
    schemas: List<JsonObject>,
    private val policy: String,
) : AutoCloseable {
    val engine: Engine
    val loadMs: Long
    private val tools = schemas.map { tool(JsonSchemaTool(it)) }
    private var chat: Conversation? = null

    init {
        val start = System.nanoTime()
        engine =
            Engine(
                EngineConfig(
                    modelPath = model.path,
                    backend =
                        when (System.getenv("TOOL_BENCH_BACKEND") ?: "cpu") {
                            "cpu" -> Backend.CPU(threadCount = 6)
                            "gpu" -> Backend.GPU()
                            else -> error("Unsupported benchmark backend")
                        },
                    activationDataType =
                        when (System.getenv("TOOL_BENCH_ACTIVATION") ?: "default") {
                            "default" -> null
                            "float32" -> ActivationDataType.FLOAT32
                            "float16" -> ActivationDataType.FLOAT16
                            else -> error("Unsupported activation precision")
                        },
                    maxNumTokens = 16384,
                    cacheDir = cache.path,
                )
            )
        engine.initialize()
        loadMs = (System.nanoTime() - start) / 1_000_000
    }

    fun begin(summary: JsonObject, history: List<JsonObject>) {
        chat?.close()
        chat =
            engine.createConversation(
                ConversationConfig(
                    systemInstruction =
                        Contents.of(
                            policy + "\nCurrent workspace summary: " + gson.toJson(summary)
                        ),
                    initialMessages =
                        history.map {
                            if (it.s("role") == "user") Message.user(it.s("text"))
                            else Message.model(it.s("text"))
                        },
                    tools = tools,
                    automaticToolCalling = false,
                    samplerConfig = SamplerConfig(topK = 10, topP = 0.9, temperature = 0.2),
                    thinkingConfig =
                        ThinkingConfig(enableThinking = false, thinkingTokenBudget = 0),
                    enableSpeculativeDecoding = true,
                )
            )
    }

    suspend fun turn(prompt: String?, responses: List<JsonObject>): Turn {
        val input =
            if (prompt != null) Message.user(prompt)
            else
                Message.tool(
                    Contents.of(
                        responses.map {
                            Content.ToolResponse(
                                it.s("name"),
                                gson.fromJson(gson.toJson(it.o("response")), Any::class.java),
                            )
                        }
                    )
                )
        val calls = mutableListOf<JsonObject>()
        val output = StringBuilder()
        chat!!.sendMessageAsync(input, maxOutputToken = 1024).collect { chunk ->
            output.append(chunk.toString())
            chunk.toolCalls.forEach {
                calls += obj("name" to it.name, "arguments" to it.arguments, "call_id" to id())
            }
        }
        return Turn(calls, output.toString())
    }

    fun end() {
        chat?.close()
        chat = null
    }

    override fun close() {
        end()
        engine.close()
    }
}

private class HostedBackend(private val schemas: List<JsonObject>, private val policy: String) {
    private val reasoning = System.getenv("TOOL_BENCH_REASONING") ?: "none"
    private val maxOutput = (System.getenv("TOOL_BENCH_MAX_OUTPUT") ?: "1024").toInt()
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build()
    private val key = requireNotNull(System.getenv("OPENAI_API_KEY")) { "OPENAI_API_KEY required" }
    private val input = mutableListOf<JsonElement>()
    private var instructions = ""

    fun begin(summary: JsonObject, history: List<JsonObject>) {
        input.clear()
        instructions = policy + "\nCurrent workspace summary: " + gson.toJson(summary)
        history.forEach {
            input +=
                obj(
                    "role" to if (it.s("role") == "user") "user" else "assistant",
                    "content" to it.s("text"),
                )
        }
    }

    fun turn(prompt: String?, responses: List<JsonObject>): Turn {
        if (prompt != null) input += obj("role" to "user", "content" to prompt)
        else
            responses.forEach {
                input +=
                    obj(
                        "type" to "function_call_output",
                        "call_id" to it.s("call_id"),
                        "output" to gson.toJson(it.o("response")),
                    )
            }
        val request =
            obj(
                "model" to "gpt-6-luna",
                "instructions" to instructions,
                "input" to input,
                "tools" to
                    schemas.map {
                        obj(
                            "type" to "function",
                            "name" to it.s("name"),
                            "description" to it.s("description"),
                            "parameters" to it.o("parameters"),
                            "strict" to false,
                        )
                    },
                "tool_choice" to "auto",
                "parallel_tool_calls" to true,
                "reasoning" to obj("effort" to reasoning),
                "max_output_tokens" to maxOutput,
                "store" to false,
            )
        val response =
            client.send(
                HttpRequest.newBuilder(URI.create("https://api.openai.com/v1/responses"))
                    .timeout(Duration.ofSeconds(90))
                    .header("Authorization", "Bearer $key")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(request)))
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )
        require(response.statusCode() == 200) {
            "OpenAI HTTP ${response.statusCode()}: ${response.body().take(600)}"
        }
        val body = json(response.body()).asJsonObject
        val output = body.a("output")
        input += output
        var parseError: String? = null
        val calls =
            output
                .map { it.asJsonObject }
                .filter { it.s("type") == "function_call" }
                .map {
                    obj(
                        "name" to it.s("name"),
                        "arguments" to
                            try {
                                json(it.s("arguments"))
                            } catch (e: Exception) {
                                parseError = "Invalid or truncated tool arguments: ${e.message}"
                                obj("rawArguments" to it.s("arguments"))
                            },
                        "call_id" to it.s("call_id"),
                    )
                }
        val text =
            output
                .filter { it.asJsonObject.s("type") == "message" }
                .flatMap { it.asJsonObject.a("content") }
                .joinToString("") { it.asJsonObject.s("text") }
        val usage = body.o("usage")
        return Turn(
            calls,
            text,
            output,
            usage.n("input_tokens"),
            usage.o("input_tokens_details").n("cached_tokens"),
            usage.n("output_tokens"),
            body.s("id"),
            parseError,
        )
    }
}

/** Same full catalog, prompt, fixtures, limits and ledger dispatcher for all providers. */
fun benchmarkMain(args: Array<String>) = runBlocking {
    require(args.size >= 4) { "benchmark ROOT DATASET MODEL OUTPUT [FILTER]" }
    val root = File(args[0])
    val dataset = File(args[1])
    val model = args[2]
    val output = File(args[3])
    val filter = args.getOrNull(4).orEmpty()
    Engine.setNativeMinLogSeverity(LogSeverity.ERROR)
    val precision = System.getenv("TOOL_BENCH_ACTIVATION") ?: "default"
    val cache =
        File(
                root,
                ".tools/android/benchmark-cache" +
                    (if (precision == "default") "" else "-$precision"),
            )
            .apply { mkdirs() }
    val dispatcher = InferenceSession(cache, preferGpu = false)
    val schemas = dispatcher.toolDefinitions()
    val policy = File(root, "benchmarks/tool-calling/policy.txt").readText()
    val cases =
        json(dataset.readText())
            .asJsonObject
            .a("cases")
            .map { it.asJsonObject }
            .filter { filter.isEmpty() || Regex(filter).containsMatchIn(it.s("id")) }
    val already =
        if (output.exists())
            output
                .readLines()
                .filter { it.isNotBlank() }
                .map { json(it).asJsonObject.s("caseId") }
                .toSet()
        else emptySet()
    val native =
        if (model != "gpt-6-luna" && model != "oracle")
            NativeBackend(
                File(root, ".tools/android/models/gemma-4-${model.uppercase()}-it.litertlm"),
                cache,
                schemas,
                policy,
            )
        else null
    val hosted = if (model == "gpt-6-luna") HostedBackend(schemas, policy) else null
    File(output.parentFile, "tools.json").writeText(gson.toJson(schemas))
    val contractHash = sha256((gson.toJson(schemas) + policy + dataset.readText()).toByteArray())
    System.err.println(
        "BENCHMARK model=$model cases=${cases.size} resumed=${already.size} loadMs=${native?.loadMs ?: 0} contract=$contractHash"
    )
    try {
        for (case in cases.filter { it.s("id") !in already }) {
            val f = fixture(root, case)
            val plan = AssistantPlan()
            val source = case.s("prompt")
            val trusted =
                (case
                        .a("history")
                        .filter { it.asJsonObject.s("role") == "user" }
                        .map { it.asJsonObject.s("text") } + source)
                    .joinToString("\n")
            val trace = mutableListOf<JsonObject>()
            val initialTransactions = gson.toJson(f.ledger.transactions())
            val initialRepayments = gson.toJson(f.ledger.all("SELECT * FROM repayments"))
            val start = System.nanoTime()
            var firstTurnMs: Long? = null
            var totalInput = 0L
            var cachedInput = 0L
            var totalOutput = 0L
            var rounds = 0
            var reply = ""
            var error: String? = null
            var commit = false
            var modelInvoked = false
            try {
                if (model == "oracle") {
                    val actions = substitute(case["oracle"], f.ids).asJsonArray
                    actions.forEach { raw ->
                        val a = raw.asJsonObject
                        val response =
                            dispatcher.dispatchTool(
                                f.ledger,
                                plan,
                                a.s("name"),
                                a.o("arguments"),
                                f.selected?.toSet(),
                                trusted,
                                f.job,
                            )
                        trace +=
                            obj(
                                "name" to a.s("name"),
                                "arguments" to a.o("arguments"),
                                "response" to response,
                            )
                    }
                    reply = case.s("oracleReply", "Prepared for confirmation.")
                } else {
                    native?.begin(summary(f), case.a("history").map { it.asJsonObject })
                    hosted?.begin(summary(f), case.a("history").map { it.asJsonObject })
                    var prompt: String? = source
                    var responses = emptyList<JsonObject>()
                    var finished = false
                    withTimeout(120_000) {
                        while (!finished && rounds < 6) {
                            modelInvoked = true
                            val turn =
                                if (native != null) native.turn(prompt, responses)
                                else hosted!!.turn(prompt, responses)
                            rounds++
                            if (firstTurnMs == null)
                                firstTurnMs = (System.nanoTime() - start) / 1_000_000
                            totalInput += turn.inputTokens
                            cachedInput += turn.cachedTokens
                            totalOutput += turn.outputTokens
                            if (turn.parseError != null) {
                                trace +=
                                    obj(
                                        "name" to "__malformed_response__",
                                        "responseId" to turn.responseId,
                                        "response" to obj("error" to turn.parseError),
                                        "output" to turn.output,
                                    )
                                error(turn.parseError)
                            }
                            reply = turn.text
                            if (turn.calls.isEmpty()) {
                                finished = true
                                break
                            }
                            responses =
                                turn.calls.map { call ->
                                    val name = call.s("name")
                                    val arguments = call.o("arguments")
                                    val response =
                                        try {
                                            require(schemas.any { it.s("name") == name }) {
                                                "Unknown tool"
                                            }
                                            if (name == "finish_reply") {
                                                require(
                                                    arguments.s("outcome") != "changes_prepared" ||
                                                        plan.organization.isNotEmpty() ||
                                                        plan.requests.isNotEmpty() ||
                                                        plan.updates.isNotEmpty()
                                                ) {
                                                    "No action staged"
                                                }
                                                reply = arguments.s("message")
                                                finished = true
                                                obj("complete" to true)
                                            } else
                                                dispatcher.dispatchTool(
                                                    f.ledger,
                                                    plan,
                                                    name,
                                                    arguments,
                                                    f.selected?.toSet(),
                                                    trusted,
                                                    f.job,
                                                )
                                        } catch (e: Exception) {
                                            obj("error" to (e.message ?: e.javaClass.simpleName))
                                        }
                                    trace +=
                                        obj(
                                            "round" to rounds,
                                            "name" to name,
                                            "arguments" to arguments,
                                            "response" to response,
                                            "responseId" to turn.responseId,
                                        )
                                    if (response.s("clarification").isNotEmpty()) {
                                        reply = response.s("clarification")
                                        finished = true
                                    }
                                    obj(
                                        "name" to name,
                                        "call_id" to call.s("call_id"),
                                        "response" to response,
                                    )
                                }
                            prompt = null
                        }
                    }
                    require(finished) { "Turn limit exceeded" }
                }
                f.ledger.commitPlan(f.job, plan, trusted, f.selected?.toSet(), f.job)
                commit = true
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
            } finally {
                native?.end()
            }
            val unchanged =
                initialTransactions == gson.toJson(f.ledger.transactions()) &&
                    initialRepayments == gson.toJson(f.ledger.all("SELECT * FROM repayments"))
            val result =
                obj(
                    "caseId" to case.s("id"),
                    "category" to case.s("category"),
                    "family" to case.s("family"),
                    "model" to model,
                    "contractHash" to contractHash,
                    "datasetHash" to sha256(dataset.readBytes()),
                    "startedAt" to now(),
                    "modelInvoked" to modelInvoked,
                    "elapsedMs" to (System.nanoTime() - start) / 1_000_000,
                    "firstTurnMs" to firstTurnMs,
                    "loadMs" to (native?.loadMs ?: 0),
                    "rounds" to rounds,
                    "inputTokens" to totalInput,
                    "cachedInputTokens" to cachedInput,
                    "outputTokens" to totalOutput,
                    "plan" to plan,
                    "reply" to reply,
                    "error" to error,
                    "committed" to commit,
                    "financialStateUnchanged" to unchanged,
                    "trace" to trace,
                    "expect" to substitute(case["expect"], f.ids),
                )
            output.appendText(gson.toJson(result) + "\n")
            System.err.println(
                "CASE ${case.s("id")} model=$model ms=${result.n("elapsedMs")} calls=${trace.size} error=${error ?: "none"}"
            )
            f.db.close()
            // Access/model errors are infrastructure failures; avoid spending the entire run
            // retrying them.
            if (error?.startsWith("OpenAI HTTP") == true) error(error)
        }
    } finally {
        native?.close()
        dispatcher.close()
    }
}
