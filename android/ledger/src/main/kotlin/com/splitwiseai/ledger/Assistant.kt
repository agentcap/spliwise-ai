package com.splitwiseai.ledger

import com.google.gson.*

data class AssistantPlan(
    val organization: MutableList<JsonObject> = mutableListOf(),
    val requests: MutableList<JsonObject> = mutableListOf(),
    val updates: MutableList<JsonObject> = mutableListOf(),
)

fun Ledger.queueRequest(job: String, kind: String, payload: JsonElement, title: String): String {
    require(kind in setOf("splits", "assignment", "expense", "repayment"))
    val copy = payload.deepCopy()
    if (kind in setOf("assignment", "expense")) {
        val p = copy.asJsonObject
        if (p.s("tripId").isNotEmpty())
            p.addProperty("tripVersion", row("trips", p.s("tripId")).n("version"))
        if (kind == "assignment")
            p.add("expenses", gson.toJsonTree(p.a("items").map { tx(it.asJsonObject.s("id")) }))
    }
    val key = id()
    insert(
        "assistant_requests",
        obj(
            "id" to key,
            "jobId" to job,
            "kind" to kind,
            "payload" to copy,
            "title" to title,
            "status" to "pending",
            "createdAt" to now(),
        ),
    )
    return key
}

fun Ledger.applyRequest(key: String) = db.transaction {
    val r = requireNotNull(one("SELECT * FROM assistant_requests WHERE id=?", key))
    if (r.s("status") == "applied") return@transaction
    require(r.s("status") == "pending") { "This card was dismissed." }
    val p = json(r.s("payload"))
    if (
        p.isJsonObject &&
            p.asJsonObject.s("tripId").isNotEmpty() &&
            p.asJsonObject.has("tripVersion")
    ) {
        require(
            row("trips", p.asJsonObject.s("tripId")).n("version") == p.asJsonObject.n("tripVersion")
        ) {
            "Trip changed. Ask for a new card."
        }
    }
    when (r.s("kind")) {
        "splits" -> saveProposals(p.asJsonArray.map { it.asJsonObject })
        "assignment" ->
            assign(
                p.asJsonObject.a("items").map {
                    Reference(it.asJsonObject.s("id"), it.asJsonObject.n("version"))
                },
                p.asJsonObject.s("tripId").ifEmpty { null },
            )
        "expense" -> manual(p.asJsonObject, key)
        "repayment" -> repayment(p.asJsonObject, key)
        else -> error("Unknown confirmation kind.")
    }
    val batch = requireNotNull(one("SELECT id FROM action_batches ORDER BY sequence DESC LIMIT 1"))
    db.execute(
        "UPDATE assistant_requests SET status='applied',batchId=? WHERE id=?",
        batch.s("id"),
        key,
    )
}

fun Ledger.finalizeRequest(key: String) = db.transaction {
    val r = requireNotNull(one("SELECT * FROM assistant_requests WHERE id=?", key))
    require(r.s("kind") == "splits" && r.s("status") == "applied")
    val batch = requireNotNull(one("SELECT * FROM action_batches WHERE id=?", r.s("batchId")))
    require(batch.s("undoneAt").isEmpty()) { "This action was undone." }
    val updates =
        json(r.s("payload")).asJsonArray.map { it.asJsonObject }.filter { it.s("state") == "ready" }
    require(updates.isNotEmpty())
    if (
        updates.all {
            val t = tx(it.s("id"))
            t.s("state") == "finalized" && t.doc("proposal") == it.o("proposal")
        }
    )
        return@transaction
    val undo = json(batch.s("undo")).asJsonArray.map { it.asJsonObject }
    val refs = updates.map { u ->
        val t = tx(u.s("id"))
        val before = requireNotNull(undo.find { it.s("id") == t.s("id") }).o("before")
        require(
            t.s("state") == "ready" &&
                t.n("version") == before.n("version") + 1 &&
                t.doc("proposal") == u.o("proposal")
        ) {
            "Expenses changed. Review their latest splits."
        }
        Reference(t.s("id"), t.n("version"))
    }
    review(refs, "approve")
}

fun Ledger.dismissRequest(key: String) {
    db.execute(
        "UPDATE assistant_requests SET status='dismissed' WHERE id=? AND status='pending'",
        key,
    )
}

fun Ledger.commitPlan(
    job: String,
    plan: AssistantPlan,
    sourceText: String,
    allowed: Set<String>?,
    step: String,
) = db.transaction {
    if (one("SELECT key FROM receipts WHERE key=?", "ai:$step") != null) return@transaction
    val status = requireNotNull(one("SELECT * FROM jobs WHERE id=?", job))
    require(status.s("status") == "running" && status.n("cancelRequested") == 0L) {
        "Job was stopped."
    }
    require(plan.organization.size <= 50 && plan.updates.size <= 100 && plan.requests.size <= 30)
    plan.updates.forEach { u ->
        require(allowed == null || u.s("id") in allowed) { "Expense outside selected scope." }
        val t = tx(u.s("id"))
        require(t.s("state") != "finalized" && t.n("version") == u.n("version")) {
            "Expense changed during processing."
        }
        require(u.s("state") in setOf("inbox", "ready"))
        require(u.s("state") != "ready" || u.o("proposal").s("confidence") == "high")
        if (u.s("context").isNotEmpty())
            require(sourceText.contains(u.s("context"))) {
                "Saved context must quote a user instruction."
            }
    }
    plan.requests.forEach { p ->
        when (p.s("kind")) {
            "assignment" ->
                p.a("items").forEach { item ->
                    val r = item.asJsonObject
                    val t = tx(r.s("id"))
                    require(
                        t.s("state") != "finalized" &&
                            t.n("version") == r.n("version") &&
                            (allowed == null || t.s("id") in allowed)
                    )
                }
            "expense" -> {
                date(p.s("date"))
                require(
                    p.s("description").trim().length in 1..200 &&
                        p.n("amountCents") in 1..1_000_000_000_000L &&
                        p.s("category").isNotBlank()
                ) {
                    "An expense requires description, date, positive amountCents and category. Put the expense name in description, not only in note."
                }
                resolveMentions(p.s("note"))
            }
            "repayment" -> {
                date(p.s("date"))
                val person =
                    one("SELECT * FROM people WHERE id=?", p.s("personId"))
                        ?: plan.organization.find {
                            it.s("kind") == "person" && it.s("id") == p.s("personId")
                        }
                require(
                    person != null &&
                        person.n("isSelf") == 0L &&
                        p.n("amountCents") in 1..1_000_000_000_000L &&
                        p.s("direction") in setOf("received", "returned")
                )
            }
            else -> error("Unsupported assistant request.")
        }
    }
    plan.organization.forEach { op ->
        val kind = op.s("kind")
        var target = op.s("id")
        when (kind) {
            "rule" ->
                when (op.s("action")) {
                    "save" -> target = saveRule(op, true, "agent")
                    "delete" -> deleteRule(target, op.n("version"), "agent")
                    "optimize" -> optimize(optimization(), "agent")
                    else -> error("Unsupported rule operation.")
                }
            "trip" ->
                if (op.s("action") == "save") target = saveTrip(op, "agent")
                else {
                    require(op.s("action") in setOf("archive", "reopen"))
                    archiveTrip(target, op.n("version"), op.s("action") == "archive", "agent")
                }
            "person" -> {
                require(
                    sourceText.contains(op.s("name"), true) ||
                        sourceText.contains("@" + op.s("handle"), true)
                ) {
                    "New people must be named by you."
                }
                target =
                    addPerson(
                        op.s("name"),
                        op.s("handle"),
                        op.s("relation"),
                        "agent",
                        target.ifEmpty { null },
                    )
            }
            "context" -> {
                if (op.s("action") == "delete")
                    removeOrganization("user_context", target, op.n("version"), "agent")
                else {
                    require(op.s("quote").isNotBlank() && sourceText.contains(op.s("quote"))) {
                        "Saved facts require an exact user quote."
                    }
                    target = saveOrganization("user_context", op, "agent")
                }
            }
            "template" -> target = saveOrganization("split_templates", op, "agent")
            "alias" -> target = saveOrganization("merchant_aliases", op, "agent")
            else -> error("Unsupported assistant operation.")
        }
        val batch = one("SELECT id FROM action_batches ORDER BY sequence DESC LIMIT 1")
        if (batch != null)
            insert(
                "assistant_events",
                obj(
                    "id" to id(),
                    "jobId" to job,
                    "kind" to kind,
                    "targetId" to target,
                    "title" to "Saved $kind",
                    "detail" to op.s("title").ifEmpty { op.s("name") },
                    "batchId" to batch.s("id"),
                    "createdAt" to now(),
                ),
            )
    }
    plan.updates.forEach { u ->
        if (u.has("proposal") && !u["proposal"].isJsonNull)
            validateProposal(tx(u.s("id")), u.o("proposal"), true)
    }
    if (plan.updates.isNotEmpty())
        queueRequest(
            job,
            "splits",
            gson.toJsonTree(plan.updates),
            "Confirm ${plan.updates.size} split changes",
        )
    plan.requests.forEach { queueRequest(job, it.s("kind"), it, "Confirm ${it.s("kind")}") }
    insert(
        "receipts",
        obj(
            "key" to "ai:$step",
            "digest" to sha256(gson.toJson(plan).toByteArray()),
            "response" to "{}",
            "createdAt" to now(),
        ),
    )
}

fun Ledger.reviewRule(key: String, approve: Boolean) = db.transaction {
    val change = row("rule_changes", key)
    require(change.s("status") == "proposed")
    val before = change.s("ruleId").takeIf { it.isNotEmpty() }?.let { row("rules", it) }
    if (before != null) require(before.n("version") == change.n("baseVersion"))
    val rule = before?.s("id") ?: id()
    batch(
        if (approve) "Approve rule" else "Reject rule",
        listOf(Change("rule_changes", key)) +
            if (approve) listOf(Change("rules", rule)) else emptyList(),
    ) {
        if (approve) {
            val d = change.doc("definition")
            checkSpec(SplitSpec.from(d.o("split")))
            if (before == null)
                insert("rules", obj("id" to rule, "title" to change.s("title"), "definition" to d))
            else
                db.execute(
                    "UPDATE rules SET title=?,definition=?,version=version+1,active=1 WHERE id=?",
                    change.s("title"),
                    gson.toJson(d),
                    rule,
                )
        }
        db.execute(
            "UPDATE rule_changes SET status=? WHERE id=?",
            if (approve) "approved" else "rejected",
            key,
        )
    }
}
