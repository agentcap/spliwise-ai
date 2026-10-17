package com.splitwiseai.ledger

import com.google.gson.*

data class Reference(val id: String, val version: Long)

data class Change(val table: String, val id: String)

class Ledger(val db: LedgerDatabase) {
    private val tables =
        setOf(
            "transactions",
            "rules",
            "rule_changes",
            "repayments",
            "trips",
            "split_templates",
            "merchant_aliases",
            "attachments",
            "user_context",
            "people",
        )

    fun all(sql: String, vararg args: Any?) = db.rows(sql, *args)

    fun one(sql: String, vararg args: Any?) = all(sql, *args).firstOrNull()

    fun row(table: String, key: String): JsonObject =
        requireNotNull(
            one("SELECT * FROM \"${table.also { require(it in tables) }}\" WHERE id=?", key)
        ) {
            "Record no longer exists."
        }

    fun people() = all("SELECT * FROM people ORDER BY isSelf DESC,name,id")

    fun transactions() = all("SELECT * FROM transactions ORDER BY date,id")

    fun tx(key: String) = row("transactions", key)

    fun references(ids: List<String>) = ids.map { Reference(it, tx(it).n("version")) }

    fun dashboard(from: String = "", to: String = "") =
        balances(transactions(), people(), all("SELECT * FROM repayments"), from, to)

    fun seed() = db.transaction {
        db.execute(
            "INSERT OR IGNORE INTO people(id,name,handle,relation,isSelf) VALUES('self','Me','me','You',1)"
        )
        listOf(
                Triple("sapphire", "Chase Sapphire", "chase"),
                Triple("amex", "American Express", "amex"),
                Triple("prime", "Chase Prime", "chase"),
            )
            .forEach {
                db.execute(
                    "INSERT OR IGNORE INTO accounts(id,name,format) VALUES(?,?,?)",
                    it.first,
                    it.second,
                    it.third,
                )
            }
        db.execute(
            "INSERT OR IGNORE INTO accounts(id,name,format) VALUES('manual','Cash and manual','amex')"
        )
        listOf(
                "Food & Drink",
                "Groceries",
                "Automotive",
                "Bills & Utilities",
                "Entertainment",
                "Fees & Adjustments",
                "Gas",
                "Health & Wellness",
                "Personal",
                "Professional Services",
                "Shopping",
                "Travel",
                "Uncategorized",
            )
            .forEach {
                db.execute(
                    "INSERT OR IGNORE INTO categories(id,name) VALUES(?,?)",
                    it.lowercase().replace(Regex("[^a-z0-9]+"), "-"),
                    it,
                )
            }
        db.execute(
            "INSERT OR IGNORE INTO workspace_settings(id,timezone) VALUES('main','America/Los_Angeles')"
        )
    }

    fun insert(table: String, value: JsonObject) {
        require(
            table in
                tables +
                    setOf(
                        "imports",
                        "import_rows",
                        "jobs",
                        "messages",
                        "assistant_events",
                        "assistant_requests",
                        "receipts",
                        "data_transfers",
                    )
        )
        val keys = value.keySet().toList()
        require(keys.all { Regex("[a-zA-Z][a-zA-Z0-9_]*").matches(it) })
        db.execute(
            "INSERT INTO \"$table\" (${keys.joinToString { "\"$it\"" }}) VALUES (${keys.joinToString { "?" }})",
            *keys.map { sqlValue(value[it]) }.toTypedArray(),
        )
    }

    private fun sqlValue(value: JsonElement?): Any? =
        when {
            value == null || value.isJsonNull -> null
            !value.isJsonPrimitive -> gson.toJson(value)
            value.asJsonPrimitive.isNumber -> value.asBigDecimal.longValueExact()
            value.asJsonPrimitive.isBoolean -> if (value.asBoolean) 1 else 0
            else -> value.asString
        }

    fun <T> batch(
        label: String,
        changes: List<Change>,
        actor: String = "user",
        step: String? = null,
        work: (String) -> T,
    ): T? = db.transaction {
        if (step != null && one("SELECT id FROM action_batches WHERE stepKey=?", step) != null)
            return@transaction null
        val undo =
            changes.distinct().map {
                require(it.table in tables)
                obj(
                    "table" to it.table,
                    "id" to it.id,
                    "before" to one("SELECT * FROM \"${it.table}\" WHERE id=?", it.id),
                )
            }
        val key = id()
        val result = work(key)
        db.execute(
            "INSERT INTO action_batches(id,label,actor,undo,createdAt,stepKey) VALUES(?,?,?,?,?,?)",
            key,
            label,
            actor,
            gson.toJson(undo),
            now(),
            step,
        )
        result
    }

    fun undo(): String = db.transaction {
        val last =
            requireNotNull(
                one(
                    "SELECT * FROM action_batches WHERE undoneAt IS NULL ORDER BY sequence DESC LIMIT 1"
                )
            ) {
                "Nothing to undo."
            }
        val entries = json(last.s("undo")).asJsonArray.map { it.asJsonObject }
        entries.reversed().forEach { entry ->
            val table = entry.s("table")
            require(table in tables) { "Invalid undo record." }
            val key = entry.s("id")
            val before = entry.get("before")
            if (before == null || before.isJsonNull) {
                if (table == "people") {
                    val used =
                        transactions().any {
                            it.doc("proposal").shares().any { s -> s.personId == key }
                        } ||
                            all("SELECT * FROM rules WHERE active=1").any {
                                it.doc("definition").o("split").a("participants").any { p ->
                                    p.asString == key
                                }
                            } ||
                            all("SELECT * FROM trips").any {
                                json(it.s("participants")).asJsonArray.any { p ->
                                    p.asString == key
                                }
                            } ||
                            all("SELECT * FROM split_templates").any {
                                it.doc("spec").a("participants").any { p -> p.asString == key }
                            } ||
                            one("SELECT id FROM repayments WHERE personId=?", key) != null ||
                            one("SELECT id FROM user_context WHERE personId=?", key) != null
                    require(!used) { "This person is used by saved records." }
                }
                db.execute("DELETE FROM \"$table\" WHERE id=?", key)
            } else {
                val value = before.asJsonObject.deepCopy()
                if (
                    table in
                        setOf(
                            "transactions",
                            "trips",
                            "split_templates",
                            "merchant_aliases",
                            "user_context",
                        )
                ) {
                    value.addProperty(
                        "version",
                        maxOf(
                            value.n("version"),
                            one("SELECT version FROM \"$table\" WHERE id=?", key)?.n("version")
                                ?: 0,
                        ) + 1,
                    )
                }
                val exists = one("SELECT id FROM \"$table\" WHERE id=?", key) != null
                if (!exists) insert(table, value)
                else {
                    val keys = value.keySet().filter { it != "id" }
                    require(keys.all { Regex("[a-zA-Z][a-zA-Z0-9_]*").matches(it) })
                    db.execute(
                        "UPDATE \"$table\" SET ${keys.joinToString { "\"$it\"=?" }} WHERE id=?",
                        *(keys.map { sqlValue(value[it]) } + key).toTypedArray(),
                    )
                }
            }
        }
        entries
            .filter { it.s("table") == "transactions" }
            .forEach { entry ->
                val before = entry.o("before")
                val p = before.doc("proposal")
                val oldTrip =
                    entries
                        .find { it.s("table") == "trips" && it.s("id") == p.s("tripId") }
                        ?.o("before")
                if (oldTrip != null && p.n("tripVersion") == oldTrip.n("version")) {
                    val trip = row("trips", p.s("tripId"))
                    p.addProperty("tripVersion", trip.n("version"))
                    db.execute(
                        "UPDATE transactions SET proposal=? WHERE id=?",
                        gson.toJson(p),
                        entry.s("id"),
                    )
                }
            }
        db.execute("UPDATE action_batches SET undoneAt=? WHERE id=?", now(), last.s("id"))
        last.s("label")
    }

    fun addPerson(
        name: String,
        handle: String,
        relation: String = "",
        actor: String = "user",
        preferredId: String? = null,
    ): String {
        require(name.trim().length in 1..80 && Regex("[a-z][a-z0-9_]{0,39}").matches(handle)) {
            "Use a name and unique lowercase @handle."
        }
        require(relation.length <= 100)
        val key = preferredId ?: id()
        if (actor == "agent")
            batch("Add person", listOf(Change("people", key)), actor) {
                insert(
                    "people",
                    obj(
                        "id" to key,
                        "name" to name.trim(),
                        "handle" to handle,
                        "relation" to relation,
                        "isSelf" to 0,
                    ),
                )
            }
        else
            insert(
                "people",
                obj(
                    "id" to key,
                    "name" to name.trim(),
                    "handle" to handle,
                    "relation" to relation,
                    "isSelf" to 0,
                ),
            )
        return key
    }

    fun resolveMentions(text: String): List<String> =
        Regex("@([a-zA-Z][a-zA-Z0-9_]*)")
            .findAll(text)
            .map { m ->
                requireNotNull(people().find { it.s("handle") == m.groupValues[1].lowercase() }) {
                        "Unknown person ${m.value}. Add that person first."
                    }
                    .s("id")
            }
            .toList()
            .distinct()

    fun checkSpec(spec: SplitSpec) {
        require(spec.mode in setOf("personal", "equal", "exact", "percent"))
        val participants = if (spec.mode == "personal") listOf("self") else spec.participants
        require(
            participants.isNotEmpty() &&
                participants.size <= 30 &&
                participants.distinct().size == participants.size
        )
        require(participants.all { p -> people().any { it.s("id") == p } }) {
            "Unknown participant."
        }
        when (spec.mode) {
            "exact" ->
                require(
                    spec.values?.size == participants.size &&
                        spec.values.all { it in 0..1_000_000_000_000L }
                )
            "percent" -> {
                require(spec.values?.size == participants.size && spec.values.all { it >= 0 })
                require(spec.values.sum() == 10000L) { "Percentages must total 100%." }
            }
        }
    }

    fun validateProposal(tx: JsonObject, p: JsonObject, finalizing: Boolean = false) {
        require(
            p.s("category").trim().length in 1..80 &&
                p.s("confidence") in setOf("high", "medium", "low")
        )
        val shares = p.shares()
        require(tx.n("amountCents") in -1_000_000_000_000L..1_000_000_000_000L)
        require(
            shares.isNotEmpty() &&
                shares.map { it.personId }.distinct().size == shares.size &&
                shares.size <= 30
        )
        shares.forEach { s ->
            require(s.amountCents in -1_000_000_000_000L..1_000_000_000_000L)
            require(people().any { it.s("id") == s.personId }) { "Unknown split participant." }
            require(if (tx.n("amountCents") < 0) s.amountCents <= 0 else s.amountCents >= 0)
        }
        require(shares.sumOf { it.amountCents } == tx.n("amountCents")) {
            "Split must total the expense."
        }
        if (finalizing && p.s("ruleId").isNotEmpty()) {
            val r = row("rules", p.s("ruleId"))
            require(r.n("active") == 1L && r.n("version") == p.n("ruleVersion")) {
                "Rule changed. Generate a new split."
            }
        }
        if (finalizing && p.s("tripId").isNotEmpty()) {
            val t = row("trips", p.s("tripId"))
            require(
                t.s("status") == "active" &&
                    t.n("version") == p.n("tripVersion") &&
                    tx.s("tripId") == t.s("id")
            ) {
                "Trip changed. Generate a new split."
            }
        }
        if (p.s("refundOf").isNotEmpty()) {
            val original = tx(p.s("refundOf"))
            require(
                tx.n("amountCents") < 0 &&
                    original.n("amountCents") > 0 &&
                    original.s("state") == "finalized"
            ) {
                "Link to a finalized purchase."
            }
            val previous =
                transactions()
                    .filter {
                        it.s("id") != tx.s("id") &&
                            it.s("state") == "finalized" &&
                            it.doc("proposal").s("refundOf") == original.s("id")
                    }
                    .map { it.doc("proposal").shares() }
            val expected =
                refundShares(original.doc("proposal").shares(), tx.n("amountCents"), previous)
            require(expected.all { shares.contains(it) } && expected.size == shares.size) {
                "Linked refunds must reverse the original allocation."
            }
        }
    }

    fun saveProposals(updates: List<JsonObject>, actor: String = "user") {
        require(
            updates.size in 1..100 && updates.map { it.s("id") }.distinct().size == updates.size
        )
        batch(
            "Prepare ${updates.size} splits",
            updates.map { Change("transactions", it.s("id")) },
            actor,
        ) { batch ->
            updates.forEach { u ->
                val t = tx(u.s("id"))
                require(t.s("state") != "finalized" && t.n("version") == u.n("version")) {
                    "Expense changed. Refresh this proposal."
                }
                val p = u.get("proposal")?.takeUnless { it.isJsonNull }?.asJsonObject
                require(u.s("state") in setOf("inbox", "ready")) { "AI cannot finalize expenses." }
                if (p != null) validateProposal(t, p, true)
                require(
                    u.s("state") != "ready" ||
                        (p != null && (actor == "user" || p.s("confidence") == "high"))
                )
                val notes = note(t, u.s("context"), "chat")
                db.execute(
                    "UPDATE transactions SET state=?,proposal=?,attention=?,notes=?,version=version+1,batchId=?,updatedAt=? WHERE id=?",
                    u.s("state"),
                    p?.let { gson.toJson(it) },
                    u.s("attention"),
                    gson.toJson(notes),
                    batch,
                    now(),
                    t.s("id"),
                )
            }
        }
    }

    private fun note(tx: JsonObject, text: String, source: String): List<JsonObject> {
        val notes = tx.docs("notes")
        if (text.isBlank() || notes.any { it.s("text") == text.trim() }) return notes
        require(text.length <= 12000)
        return notes +
            obj("id" to id(), "text" to text.trim(), "source" to source, "createdAt" to now())
    }

    fun saveChatContext(ids: List<String>, text: String) {
        require(ids.size in 1..1000 && ids.distinct().size == ids.size)
        require(text.isNotBlank() && text.length <= 12000)
        ids.forEach {
            require(tx(it).s("state") != "finalized") {
                "Finalized expenses cannot receive chat context."
            }
        }
        batch(
            "Save chat context for ${ids.size} expenses",
            ids.map { Change("transactions", it) },
        ) { batch ->
            ids.forEach { key ->
                db.execute(
                    "UPDATE transactions SET notes=?,version=version+1,batchId=?,updatedAt=? WHERE id=?",
                    gson.toJson(note(tx(key), text, "chat")),
                    batch,
                    now(),
                    key,
                )
            }
        }
    }

    fun review(items: List<Reference>, action: String, instruction: String = "") {
        require(items.size in 1..1000 && items.distinctBy { it.id }.size == items.size)
        require(action in setOf("approve", "reject", "reopen", "correct"))
        resolveMentions(instruction)
        if (action == "correct") require(instruction.trim().length in 1..4000)
        batch("$action ${items.size} expenses", items.map { Change("transactions", it.id) }) { batch
            ->
            items.forEach { item ->
                val t = tx(item.id)
                require(t.n("version") == item.version) { "Expense changed. Refresh." }
                if (action == "approve") {
                    require(t.s("state") == "ready") { "Only Ready expenses can be finalized." }
                    validateProposal(t, t.doc("proposal"), true)
                    db.execute(
                        "INSERT OR IGNORE INTO categories(id,name) VALUES(?,?)",
                        id(),
                        t.doc("proposal").s("category"),
                    )
                } else if (action == "reopen") require(t.s("state") == "finalized")
                else require(t.s("state") != "finalized") { "Reopen finalized expenses first." }
                val state =
                    when (action) {
                        "approve" -> "finalized"
                        "reopen" -> "ready"
                        else -> "inbox"
                    }
                db.execute(
                    "UPDATE transactions SET state=?,proposal=?,instruction=?,notes=?,attention=?,version=version+1,batchId=?,updatedAt=? WHERE id=?",
                    state,
                    if (action in setOf("reject", "correct")) null
                    else t.get("proposal")?.takeUnless { it.isJsonNull }?.asString,
                    if (action == "correct") instruction.trim() else t.s("instruction"),
                    gson.toJson(
                        if (action == "correct") note(t, instruction, "instruction")
                        else t.docs("notes")
                    ),
                    if (action == "correct") "" else t.s("attention"),
                    batch,
                    now(),
                    item.id,
                )
            }
        }
    }

    fun quick(items: List<Reference>, spec: SplitSpec, category: String = "Uncategorized") {
        saveProposals(
            items.map { r ->
                val t = tx(r.id)
                obj(
                    "id" to r.id,
                    "version" to r.version,
                    "state" to "ready",
                    "proposal" to proposal(t.n("amountCents"), spec, category),
                )
            }
        )
    }

    fun manual(input: JsonObject, request: String = id()): String = db.transaction {
        one("SELECT * FROM receipts WHERE key=?", "manual:$request")?.let {
            require(it.s("digest") == sha256(gson.toJson(input).toByteArray())) {
                "This request ID was already used for another expense."
            }
            return@transaction it.doc("response").s("id")
        }
        require(
            input.s("description").trim().length in 1..200 &&
                input.n("amountCents") in 1..1_000_000_000_000L
        )
        date(input.s("date"))
        resolveMentions(input.s("note"))
        if (input.s("tripId").isNotEmpty())
            require(row("trips", input.s("tripId")).s("status") == "active")
        db.execute(
            "INSERT OR IGNORE INTO accounts(id,name,format) VALUES('manual','Cash and manual','amex')"
        )
        val import = id()
        val source = id()
        val key = id()
        insert(
            "imports",
            obj(
                "id" to import,
                "accountId" to "manual",
                "fileName" to "Manual expense",
                "hash" to request,
                "status" to "confirmed",
                "preview" to "{}",
                "createdAt" to now(),
                "summary" to "Manual expense",
            ),
        )
        insert(
            "import_rows",
            obj(
                "id" to source,
                "importId" to import,
                "accountId" to "manual",
                "rowNumber" to 1,
                "fingerprint" to request,
                "raw" to "{}",
                "kind" to "expense",
                "status" to "imported",
            ),
        )
        batch("Add expense", listOf(Change("transactions", key))) {
            insert(
                "transactions",
                obj(
                    "id" to key,
                    "accountId" to "manual",
                    "importRowId" to source,
                    "source" to "manual",
                    "date" to input.s("date"),
                    "description" to input.s("description").trim(),
                    "amountCents" to input.n("amountCents"),
                    "kind" to "expense",
                    "bankCategory" to input.s("category", "Uncategorized"),
                    "tripId" to input.s("tripId").ifEmpty { null },
                    "notes" to
                        gson.toJson(
                            if (input.s("note").isNotEmpty())
                                listOf(
                                    obj(
                                        "id" to id(),
                                        "text" to input.s("note"),
                                        "source" to "instruction",
                                        "createdAt" to now(),
                                    )
                                )
                            else emptyList<JsonObject>()
                        ),
                    "updatedAt" to now(),
                ),
            )
        }
        insert(
            "receipts",
            obj(
                "key" to "manual:$request",
                "digest" to sha256(gson.toJson(input).toByteArray()),
                "response" to obj("id" to key),
                "createdAt" to now(),
            ),
        )
        key
    }

    fun repayment(input: JsonObject, request: String = id()) = db.transaction {
        one("SELECT * FROM receipts WHERE key=?", "repayment:$request")?.let {
            require(it.s("digest") == sha256(gson.toJson(input).toByteArray())) {
                "This request ID was already used for another repayment."
            }
            return@transaction
        }
        val p = row("people", input.s("personId"))
        require(p.n("isSelf") == 0L)
        require(
            input.n("amountCents") in 1..1_000_000_000_000L &&
                input.s("direction") in setOf("received", "returned")
        )
        date(input.s("date"))
        if (input.s("direction") == "returned")
            require(
                input.n("amountCents") <=
                    dashboard().first { it.person.s("id") == p.s("id") }.creditCents
            ) {
                "Return no more than available credit."
            }
        val key = id()
        batch("Record repayment", listOf(Change("repayments", key))) {
            insert(
                "repayments",
                obj(
                    "id" to key,
                    "personId" to p.s("id"),
                    "date" to input.s("date"),
                    "amountCents" to input.n("amountCents"),
                    "direction" to input.s("direction"),
                    "note" to input.s("note"),
                ),
            )
        }
        insert(
            "receipts",
            obj(
                "key" to "repayment:$request",
                "digest" to sha256(gson.toJson(input).toByteArray()),
                "response" to obj("id" to key),
                "createdAt" to now(),
            ),
        )
    }

    fun assign(items: List<Reference>, tripId: String?) {
        require(items.size in 1..1000 && items.distinctBy { it.id }.size == items.size)
        if (tripId != null)
            require(row("trips", tripId).s("status") == "active") { "Reopen the trip first." }
        batch("Assign trip", items.map { Change("transactions", it.id) }) { batch ->
            items.forEach { r ->
                require(tx(r.id).n("version") == r.version) { "Expense changed." }
                db.execute(
                    "UPDATE transactions SET tripId=?,proposal=CASE WHEN state='finalized' THEN proposal ELSE NULL END,state=CASE WHEN state='finalized' THEN state ELSE 'inbox' END,version=version+1,batchId=?,updatedAt=? WHERE id=?",
                    tripId,
                    batch,
                    now(),
                    r.id,
                )
            }
        }
    }

    fun saveTrip(input: JsonObject, actor: String = "user"): String {
        require(input.s("name").trim().length in 1..100)
        date(input.s("from"))
        date(input.s("to"))
        require(input.s("from") <= input.s("to"))
        val spec = SplitSpec.from(input.o("split"))
        checkSpec(spec)
        resolveMentions(input.s("context"))
        val old =
            if (input.s("id").isNotEmpty()) one("SELECT * FROM trips WHERE id=?", input.s("id"))
            else null
        if (old != null) require(old.n("version") == input.n("version")) { "Trip changed." }
        val key = old?.s("id") ?: input.s("id").ifEmpty { id() }
        val affected =
            if (old != null && actor == "user")
                all("SELECT id FROM transactions WHERE tripId=? AND state!='finalized'", key)
            else emptyList()
        batch(
            "Save trip ${input.s("name")}",
            listOf(Change("trips", key)) + affected.map { Change("transactions", it.s("id")) },
            actor,
        ) { batch ->
            if (old == null)
                insert(
                    "trips",
                    obj(
                        "id" to key,
                        "name" to input.s("name"),
                        "destination" to input.s("destination"),
                        "from" to input.s("from"),
                        "to" to input.s("to"),
                        "participants" to spec.participants,
                        "split" to spec.toJson(),
                        "context" to input.s("context"),
                        "createdAt" to now(),
                    ),
                )
            else
                db.execute(
                    "UPDATE trips SET name=?,destination=?,\"from\"=?,\"to\"=?,participants=?,split=?,context=?,version=version+1 WHERE id=?",
                    input.s("name"),
                    input.s("destination"),
                    input.s("from"),
                    input.s("to"),
                    gson.toJson(spec.participants),
                    gson.toJson(spec.toJson()),
                    input.s("context"),
                    key,
                )
            affected.forEach {
                db.execute(
                    "UPDATE transactions SET state='inbox',proposal=NULL,attention='Trip changed. Generate a new split.',version=version+1,batchId=?,updatedAt=? WHERE id=?",
                    batch,
                    now(),
                    it.s("id"),
                )
            }
        }
        return key
    }

    fun archiveTrip(key: String, version: Long, archive: Boolean, actor: String = "user") {
        require(row("trips", key).n("version") == version)
        require(
            !archive ||
                one("SELECT id FROM transactions WHERE tripId=? AND state!='finalized'", key) ==
                    null
        ) {
            "Finalize every assigned expense before archiving."
        }
        batch(if (archive) "Archive trip" else "Reopen trip", listOf(Change("trips", key)), actor) {
            db.execute(
                "UPDATE trips SET status=?,version=version+1 WHERE id=?",
                if (archive) "archived" else "active",
                key,
            )
        }
    }

    fun tripProposal(t: JsonObject): JsonObject {
        val trip = row("trips", t.s("tripId"))
        require(trip.s("status") == "active")
        return proposal(
                t.n("amountCents"),
                SplitSpec.from(trip.doc("split")),
                t.s("bankCategory").ifEmpty { "Travel" },
                "trip",
                "Trip default: ${trip.s("name")}",
            )
            .apply {
                addProperty("tripId", trip.s("id"))
                addProperty("tripVersion", trip.n("version"))
            }
    }

    fun saveRule(input: JsonObject, active: Boolean = true, actor: String = "user"): String {
        val d = input.doc("definition")
        checkSpec(SplitSpec.from(d.o("split")))
        require(
            input.s("title").trim().length in 1..160 &&
                d.s("merchant").length <= 200 &&
                d.s("outputCategory").length in 1..80
        )
        require(
            d.a("merchantAliases").size <= 199 &&
                d.a("merchantAliases").all { it.asString.trim().length in 1..200 }
        )
        if (d.s("from").isNotEmpty()) date(d.s("from"))
        if (d.s("to").isNotEmpty()) date(d.s("to"))
        require(d.s("from").isEmpty() || d.s("to").isEmpty() || d.s("from") <= d.s("to"))
        if (d.s("accountId").isNotEmpty())
            require(one("SELECT id FROM accounts WHERE id=?", d.s("accountId")) != null)
        val old =
            input
                .s("id")
                .takeIf { it.isNotEmpty() }
                ?.let { one("SELECT * FROM rules WHERE id=?", it) }
        require(old != null || input.n("version") == 0L) { "Rule no longer exists." }
        if (old != null) require(old.n("version") == input.n("version")) { "Rule changed." }
        val duplicate =
            all("SELECT * FROM rules WHERE active=1").find {
                canonicalRule(it.doc("definition")) == canonicalRule(d) &&
                    it.s("id") != old?.s("id")
            }
        if (duplicate != null && old == null && active) return duplicate.s("id")
        val key = old?.s("id") ?: input.s("id").ifEmpty { id() }
        batch("Save rule ${input.s("title")}", listOf(Change("rules", key)), actor) {
            if (old == null)
                insert(
                    "rules",
                    obj(
                        "id" to key,
                        "title" to input.s("title"),
                        "definition" to d,
                        "active" to if (active) 1 else 0,
                    ),
                )
            else
                db.execute(
                    "UPDATE rules SET title=?,definition=?,active=?,version=version+1 WHERE id=?",
                    input.s("title"),
                    gson.toJson(d),
                    if (active) 1 else 0,
                    key,
                )
        }
        return key
    }

    fun deleteRule(key: String, version: Long, actor: String = "user") {
        require(row("rules", key).n("version") == version)
        val affected =
            if (actor == "user")
                transactions().filter {
                    it.s("state") != "finalized" && it.doc("proposal").s("ruleId") == key
                }
            else emptyList()
        batch(
            "Delete rule",
            listOf(Change("rules", key)) + affected.map { Change("transactions", it.s("id")) },
            actor,
        ) { batch ->
            db.execute("UPDATE rules SET active=0,version=version+1 WHERE id=?", key)
            affected.forEach {
                db.execute(
                    "UPDATE transactions SET state='inbox',proposal=NULL,version=version+1,batchId=?,updatedAt=? WHERE id=?",
                    batch,
                    now(),
                    it.s("id"),
                )
            }
        }
    }

    private fun patterns(d: JsonObject): List<String> =
        if (d.s("merchant").isBlank()) emptyList()
        else
            (listOf(d.s("merchant")) + d.a("merchantAliases").map { it.asString })
                .map(::normalized)
                .distinct()
                .sorted()

    private fun canonicalSpec(d: JsonObject): String {
        val s = SplitSpec.from(d)
        return gson.toJson(
            listOf(
                s.mode,
                s.participants
                    .mapIndexed { i, p -> listOf(p, s.values?.getOrNull(i)) }
                    .sortedBy { it[0].toString() },
            )
        )
    }

    private fun outcome(d: JsonObject) = d.s("outputCategory") + canonicalSpec(d.o("split"))

    private fun scope(d: JsonObject) =
        gson.toJson(
            listOf(
                patterns(d).isNotEmpty(),
                d.s("accountId"),
                d.s("category").lowercase(),
                d.s("from"),
                d.s("to"),
            )
        )

    private fun canonicalRule(d: JsonObject) =
        gson.toJson(listOf(patterns(d), scope(d), outcome(d)))

    fun ruleProposal(tx: JsonObject): JsonObject? {
        val alias =
            all("SELECT * FROM merchant_aliases")
                .filter { normalized(tx.s("description")).contains(normalized(it.s("pattern"))) }
                .map { it.s("name") }
        val merchant = normalized(tx.s("description") + " " + alias.joinToString(" "))
        val matches =
            all("SELECT * FROM rules WHERE active=1 ORDER BY rowid").filter { rule ->
                val d = rule.doc("definition")
                (patterns(d).isEmpty() || patterns(d).any { merchant.contains(it) }) &&
                    (d.s("accountId").isEmpty() || d.s("accountId") == tx.s("accountId")) &&
                    (d.s("category").isEmpty() ||
                        d.s("category").equals(tx.s("bankCategory"), true)) &&
                    (d.s("from").isEmpty() || tx.s("date") >= d.s("from")) &&
                    (d.s("to").isEmpty() || tx.s("date") <= d.s("to"))
            }
        fun score(rule: JsonObject): Int {
            val d = rule.doc("definition")
            return (if (d.s("from").isNotEmpty() || d.s("to").isNotEmpty()) 4 else 0) +
                (if (d.s("accountId").isNotEmpty()) 2 else 0) +
                (if (d.s("category").isNotEmpty()) 1 else 0) +
                (if (patterns(d).isNotEmpty()) 1 else 0)
        }
        val max = matches.maxOfOrNull(::score) ?: return null
        val best = matches.filter { score(it) == max }
        require(best.map { outcome(it.doc("definition")) }.distinct().size == 1) {
            "Conflicting rules: ${best.joinToString { it.s("title") }}. Which should apply?"
        }
        val r = best.first()
        val d = r.doc("definition")
        return proposal(
                tx.n("amountCents"),
                SplitSpec.from(d.o("split")),
                d.s("outputCategory"),
                "rule",
                r.s("title"),
            )
            .apply {
                addProperty("ruleId", r.s("id"))
                addProperty("ruleVersion", r.n("version"))
            }
    }

    fun optimization(): List<List<JsonObject>> =
        all("SELECT * FROM rules WHERE active=1 ORDER BY id")
            .groupBy { scope(it.doc("definition")) + outcome(it.doc("definition")) }
            .values
            .filter { it.size > 1 }

    fun optimize(
        expected: List<List<JsonObject>>,
        actor: String = "user",
        expectedRevision: String? = null,
    ) = db.transaction {
        if (expectedRevision != null)
            require(revision() == expectedRevision) {
                "Workspace changed. Refresh the cleanup preview."
            }
        expected.flatten().forEach {
            require(row("rules", it.s("id")).n("version") == it.n("version")) {
                "Rules changed. Refresh the preview."
            }
        }
        val ruleIds = expected.flatten().map { it.s("id") }.toSet()
        val affected =
            if (actor == "user")
                transactions().filter {
                    it.s("state") != "finalized" && it.doc("proposal").s("ruleId") in ruleIds
                }
            else emptyList()
        batch(
            "Optimize rules",
            expected.flatten().map { Change("rules", it.s("id")) } +
                affected.map { Change("transactions", it.s("id")) },
            actor,
        ) { batch ->
            expected.forEach { group ->
                val keep = group.first()
                val d = keep.doc("definition")
                val alternatives =
                    group.flatMap { patterns(it.doc("definition")) }.distinct().sorted()
                d.addProperty("merchant", alternatives.firstOrNull() ?: "")
                d.add("merchantAliases", gson.toJsonTree(alternatives.drop(1)))
                db.execute(
                    "UPDATE rules SET definition=?,version=version+1 WHERE id=?",
                    gson.toJson(d),
                    keep.s("id"),
                )
                group.drop(1).forEach {
                    db.execute("UPDATE rules SET active=0,version=version+1 WHERE id=?", it.s("id"))
                }
                affected
                    .filter { t -> group.any { it.s("id") == t.doc("proposal").s("ruleId") } }
                    .forEach { t ->
                        val p = t.doc("proposal")
                        val old = group.first { it.s("id") == p.s("ruleId") }
                        if (p.n("ruleVersion") == old.n("version")) {
                            p.addProperty("ruleId", keep.s("id"))
                            p.addProperty("ruleVersion", keep.n("version") + 1)
                            db.execute(
                                "UPDATE transactions SET proposal=?,version=version+1,batchId=?,updatedAt=? WHERE id=?",
                                gson.toJson(p),
                                batch,
                                now(),
                                t.s("id"),
                            )
                        } else
                            db.execute(
                                "UPDATE transactions SET proposal=NULL,state='inbox',attention='Rule changed. Generate a new split.',version=version+1,batchId=?,updatedAt=? WHERE id=?",
                                batch,
                                now(),
                                t.s("id"),
                            )
                    }
            }
        }
    }

    fun saveOrganization(table: String, input: JsonObject, actor: String = "user"): String {
        require(table in setOf("split_templates", "merchant_aliases", "user_context"))
        val old =
            input
                .s("id")
                .takeIf { it.isNotEmpty() }
                ?.let { one("SELECT * FROM \"$table\" WHERE id=?", it) }
        if (old != null) require(input.n("version") == old.n("version")) { "Record changed." }
        val key = old?.s("id") ?: input.s("id").ifEmpty { id() }
        val value =
            when (table) {
                "split_templates" -> {
                    checkSpec(SplitSpec.from(input.doc("spec")))
                    require(input.s("name").length in 1..100)
                    obj(
                        "name" to input.s("name"),
                        "spec" to input.doc("spec"),
                        "category" to input.s("category", "Uncategorized"),
                    )
                }
                "merchant_aliases" -> {
                    require(
                        input.s("pattern").trim().length in 1..200 &&
                            input.s("name").trim().length in 1..100
                    )
                    obj("pattern" to input.s("pattern").trim(), "name" to input.s("name").trim())
                }
                else -> {
                    require(input.s("title").length in 1..160 && input.s("text").length in 1..4000)
                    if (input.s("personId").isNotEmpty()) row("people", input.s("personId"))
                    if (input.s("tripId").isNotEmpty()) row("trips", input.s("tripId"))
                    if (input.s("from").isNotEmpty()) date(input.s("from"))
                    if (input.s("to").isNotEmpty()) date(input.s("to"))
                    obj(
                        "title" to input.s("title"),
                        "text" to input.s("text"),
                        "quote" to input.s("quote"),
                        "personId" to input.s("personId").ifEmpty { null },
                        "tripId" to input.s("tripId").ifEmpty { null },
                        "from" to input.s("from").ifEmpty { null },
                        "to" to input.s("to").ifEmpty { null },
                        "createdAt" to (old?.s("createdAt") ?: now()),
                        "updatedAt" to now(),
                    )
                }
            }
        batch("Save ${table.replace('_', ' ')}", listOf(Change(table, key)), actor) {
            value.addProperty("version", (old?.n("version") ?: 0) + 1)
            if (old == null) {
                value.addProperty("id", key)
                insert(table, value)
            } else {
                val keys = value.keySet().toList()
                db.execute(
                    "UPDATE \"$table\" SET ${keys.joinToString { "\"$it\"=?" }} WHERE id=?",
                    *(keys.map { sqlValue(value[it]) } + key).toTypedArray(),
                )
            }
        }
        return key
    }

    fun removeOrganization(table: String, key: String, version: Long, actor: String = "user") {
        require(
            table in setOf("split_templates", "merchant_aliases", "user_context", "attachments")
        )
        val r = row(table, key)
        if (table != "attachments") require(r.n("version") == version)
        batch("Remove ${table.replace('_', ' ')}", listOf(Change(table, key)), actor) {
            db.execute("DELETE FROM \"$table\" WHERE id=?", key)
        }
    }

    fun linkedRefund(refund: String, original: String): JsonObject {
        val t = tx(refund)
        val source = tx(original)
        require(
            t.s("state") != "finalized" &&
                source.s("state") == "finalized" &&
                source.n("amountCents") > 0
        )
        val previous =
            transactions()
                .filter {
                    it.s("state") == "finalized" && it.doc("proposal").s("refundOf") == original
                }
                .map { it.doc("proposal").shares() }
        return obj(
            "splits" to refundShares(source.doc("proposal").shares(), t.n("amountCents"), previous),
            "category" to source.doc("proposal").s("category"),
            "source" to "refund",
            "confidence" to "high",
            "explanation" to "Reverse the accepted purchase allocation",
            "refundOf" to original,
        )
    }

    fun attachment(transactionId: String, name: String, mime: String, bytes: ByteArray): String {
        tx(transactionId)
        require(bytes.size in 1..5_000_000)
        require(all("SELECT id FROM attachments WHERE transactionId=?", transactionId).size < 10)
        val detected =
            when {
                bytes
                    .take(8)
                    .toByteArray()
                    .contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)) -> "image/png"
                bytes.size >= 3 &&
                    bytes[0] == (-1).toByte() &&
                    bytes[1] == (-40).toByte() &&
                    bytes[2] == (-1).toByte() -> "image/jpeg"
                bytes.take(5).toByteArray().toString(Charsets.US_ASCII) == "%PDF-" ->
                    "application/pdf"
                else -> ""
            }
        require(detected.isNotEmpty() && detected == mime) {
            "Choose a PNG, JPEG or PDF with matching contents."
        }
        val key = id()
        batch("Attach receipt", listOf(Change("attachments", key))) {
            insert(
                "attachments",
                obj(
                    "id" to key,
                    "transactionId" to transactionId,
                    "name" to name.replace(Regex("[^\\p{L}\\p{N} ._()-]"), "_").take(120),
                    "mime" to mime,
                    "size" to bytes.size,
                    "data" to java.util.Base64.getEncoder().encodeToString(bytes),
                    "createdAt" to now(),
                ),
            )
        }
        return key
    }

    fun settlement(person: String, from: String = "", to: String = "", trip: String = ""): String {
        val b = dashboard(from, to).first { it.person.s("id") == person }
        val ids =
            if (trip.isEmpty()) null
            else all("SELECT id FROM transactions WHERE tripId=?", trip).map { it.s("id") }.toSet()
        val expenses =
            b.expenses.filter {
                (from.isEmpty() || it.date >= from) &&
                    (to.isEmpty() || it.date <= to) &&
                    (ids == null || it.transactionId in ids)
            }
        return buildString {
            appendLine("Expense summary for ${b.person.s("name")}")
            appendLine(
                "Currently unpaid from selected expenses: ${money(expenses.sumOf { it.remainingCents })}"
            )
            expenses
                .filter { it.remainingCents > 0 }
                .forEach {
                    appendLine("${it.date} · ${it.description}: ${money(it.remainingCents)}")
                }
            appendLine(
                "All-time outstanding: ${money(b.outstandingCents)} · Available credit: ${money(b.creditCents)}"
            )
        }
    }
}
