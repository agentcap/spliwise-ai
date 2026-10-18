package com.splitwiseai.check

import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.LogSeverity
import com.google.gson.JsonObject
import com.splitwiseai.assistant.InferenceSession
import com.splitwiseai.ledger.*
import java.io.File
import java.sql.DriverManager
import kotlinx.coroutines.*

private class Database : LedgerDatabase {
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

private data class Case(
    val name: String,
    val prompt: String,
    val expectation: String,
    val finalized: Boolean = false,
)

fun main(args: Array<String>) = runBlocking {
    if (args.firstOrNull() == "--serve-web") {
        webModelServer(args.drop(1).toTypedArray())
        return@runBlocking
    }
    if (args.firstOrNull() == "--benchmark") {
        benchmarkMain(args.drop(1).toTypedArray())
        return@runBlocking
    }
    require(args.size >= 2) {
        "Usage: model-check /absolute/repo /absolute/model.litertlm [case-name] [repeat-count]"
    }
    Engine.setNativeMinLogSeverity(LogSeverity.ERROR)
    val root = File(args[0])
    val model = File(args[1])
    require(model.exists())
    val cache = File(root, ".tools/android/model-cache").apply { mkdirs() }
    val cases =
        listOf(
                Case(
                    "equal",
                    "Split the selected lunch equally between @me and @alex. Category Food & Drink.",
                    "split",
                ),
                Case("ambiguous", "Split the selected expense with my friend.", "question"),
                Case(
                    "rule",
                    "Always split any merchant containing CAFE equally between @me and @alex. Use category Food & Drink. Save this as a reusable rule.",
                    "rule",
                ),
                Case("context", "Remember that @alex is my roommate.", "context"),
                Case(
                    "trip",
                    "Create a Yosemite trip from 2026-10-20 to 2026-10-23 with @me and @alex. Default split is equal.",
                    "trip",
                ),
                Case(
                    "repayment",
                    "I received $5.00 from @alex on 2026-10-15 for shared expenses. Record this repayment.",
                    "repayment",
                ),
                Case(
                    "expense",
                    "Add a cash expense: lunch costing $12.00 on 2026-10-15, category Food & Drink, no trip.",
                    "expense",
                ),
                Case(
                    "template",
                    "Save a split template named Roommates, equal between @me and @alex, category Groceries.",
                    "template",
                ),
                Case(
                    "alias",
                    "Save the merchant display name Coffee House for statement descriptions containing CAFE.",
                    "alias",
                ),
                Case(
                    "finalized",
                    "Make the selected finalized expense personal instead of shared.",
                    "immutable",
                    true,
                ),
            )
            .filter { args.size < 3 || it.name == args[2] }
            .let { selected ->
                val repeats = (args.getOrNull(3)?.toIntOrNull() ?: 1).also { require(it in 1..20) }
                List(repeats) { selected }.flatten()
            }
    var failed = 0
    InferenceSession(
            cache,
            preferGpu = System.getenv("TOOL_BENCH_BACKEND") == "gpu",
            toolTrace = { System.err.println(it) },
            cpuThreadCount = 6,
        )
        .use { engine ->
            for (case in cases) {
                val db = Database()
                val ledger = Ledger(db)
                val journal =
                    json(File(root, "drizzle/meta/_journal.json").readText())
                        .asJsonObject
                        .a("entries")
                journal.forEach { item ->
                    File(root, "drizzle/${item.asJsonObject.s("tag")}.sql")
                        .readText()
                        .split("--> statement-breakpoint")
                        .filter { it.isNotBlank() }
                        .forEach { db.execute(it) }
                }
                ledger.seed()
                val alex = ledger.addPerson("Alex", "alex", "Friend")
                ledger.addPerson("Zara", "zara", "Friend")
                ledger.addPerson("Sam", "sam", "Friend")
                val transaction =
                    ledger.manual(
                        obj(
                            "description" to "CAFE lunch",
                            "date" to "2026-10-15",
                            "amountCents" to 1200,
                            "category" to "Food & Drink",
                        )
                    )
                if (case.finalized) {
                    ledger.quick(
                        ledger.references(listOf(transaction)),
                        SplitSpec("equal", listOf("self", alex)),
                    )
                    ledger.review(ledger.references(listOf(transaction)), "approve")
                }
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
                val start = System.nanoTime()
                var first = 0L
                try {
                    val scope =
                        if (case.expectation in setOf("split", "question", "immutable"))
                            listOf(transaction)
                        else null
                    val (plan, reply) =
                        withTimeout(180_000) {
                            engine.ask(ledger, model.path, model.name, case.prompt, scope, job,
                                reducedInterface = System.getenv("TOOL_BENCH_REDUCED_INTERFACE") == "1") {
                                _,
                                text ->
                                if (text.isNotBlank() && first == 0L) first = System.nanoTime()
                            }
                        }
                    println(
                        gson.toJson(
                            obj(
                                "phase" to "generated",
                                "case" to case.name,
                                "plan" to plan,
                                "reply" to reply,
                            )
                        )
                    )
                    ledger.commitPlan(job, plan, case.prompt, scope?.toSet(), job)
                    when (case.expectation) {
                        "split" -> {
                            require(
                                plan.organization.isEmpty() &&
                                    plan.requests.isEmpty() &&
                                    plan.updates.size == 1 &&
                                    plan.updates.single().o("proposal").s("category") ==
                                        "Food & Drink" &&
                                    plan.updates.single().o("proposal").shares().toSet() ==
                                        setOf(Share("self", 600), Share(alex, 600))
                            )
                            require(ledger.tx(transaction).s("state") == "inbox")
                        }
                        "question" ->
                            require(
                                plan.updates.none { it.s("state") == "ready" } &&
                                    reply.contains("?")
                            )
                        "immutable" ->
                            require(
                                plan.updates.isEmpty() &&
                                    ledger.tx(transaction).s("state") == "finalized"
                            )
                        "expense",
                        "repayment" -> {
                            val action = plan.requests.single { it.s("kind") == case.expectation }
                            require(action.s("date") == "2026-10-15")
                            if (case.expectation == "expense") {
                                require(
                                    action.n("amountCents") == 1200L &&
                                        action.s("description").contains("lunch", true) &&
                                        action.s("category") == "Food & Drink"
                                )
                            } else
                                require(
                                    action.n("amountCents") == 500L &&
                                        action.s("personId") == alex &&
                                        action.s("direction") == "received"
                                )
                            require(
                                ledger.transactions().size == 1 &&
                                    ledger.all("SELECT * FROM repayments").isEmpty()
                            )
                        }
                        else -> {
                            val action =
                                plan.organization.single { it.s("kind") == case.expectation }
                            when (case.expectation) {
                                "rule" -> {
                                    val definition = action.o("definition")
                                    require(
                                        definition.s("merchant") == "CAFE" &&
                                            definition.s("outputCategory") == "Food & Drink"
                                    )
                                    require(
                                        SplitSpec.from(definition.o("split")) ==
                                            SplitSpec("equal", listOf("self", alex))
                                    )
                                }
                                "context" ->
                                    require(
                                        action.s("text").contains("roommate", true) &&
                                            action.s("quote").isNotBlank() &&
                                            case.prompt.contains(action.s("quote"))
                                    )
                                "trip" ->
                                    require(
                                        action.s("from") == "2026-10-20" &&
                                            action.s("to") == "2026-10-23" &&
                                            SplitSpec.from(action.o("split"))
                                                .participants
                                                .toSet() == setOf("self", alex)
                                    )
                                "template" ->
                                    require(
                                        action.s("name") == "Roommates" &&
                                            action.s("category") == "Groceries" &&
                                            SplitSpec.from(action.o("spec")).participants.toSet() ==
                                                setOf("self", alex)
                                    )
                                "alias" ->
                                    require(
                                        action.s("pattern") == "CAFE" &&
                                            action.s("name") == "Coffee House"
                                    )
                            }
                        }
                    }
                    println(
                        gson.toJson(
                            obj(
                                "case" to case.name,
                                "passed" to true,
                                "seconds" to (System.nanoTime() - start) / 1_000_000_000.0,
                                "firstTextMs" to
                                    if (first == 0L) null else (first - start) / 1_000_000,
                                "backend" to engine.backend,
                                "plan" to plan,
                                "reply" to reply,
                            )
                        )
                    )
                } catch (e: Throwable) {
                    failed++
                    engine.stop()
                    println(
                        gson.toJson(
                            obj(
                                "case" to case.name,
                                "passed" to false,
                                "backend" to engine.backend,
                                "error" to e.message,
                                "seconds" to (System.nanoTime() - start) / 1_000_000_000.0,
                            )
                        )
                    )
                } finally {
                    db.close()
                }
            }
        }
    check(failed == 0) { "$failed real-model scenarios failed." }
}
