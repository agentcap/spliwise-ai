package com.splitwiseai.ledger

import com.google.gson.*

data class StatementPreview(
    val id: String,
    val accountId: String,
    val filename: String,
    val rows: List<ParsedRow>,
    val duplicates: Set<Int>,
    val revision: String,
)

fun Ledger.revision(): String =
    sha256(
        gson
            .toJson(
                all("SELECT name,sql FROM sqlite_master ORDER BY name") +
                    all("SELECT id,version,state FROM transactions ORDER BY id") +
                    all("SELECT id,version,active FROM rules ORDER BY id") +
                    all("SELECT id,handle FROM people ORDER BY id") +
                    all("SELECT id,status FROM imports ORDER BY id")
            )
            .toByteArray()
    )

fun Ledger.previewStatement(
    accountId: String,
    filename: String,
    content: String,
): StatementPreview {
    require(accountId != "manual")
    val account =
        requireNotNull(one("SELECT * FROM accounts WHERE id=?", accountId)) { "Choose a card." }
    val rows = parseStatement(content, account.s("format"))
    val counts =
        all(
                "SELECT fingerprint,COUNT(*) n FROM import_rows WHERE accountId=? AND status IN ('imported','payment') GROUP BY fingerprint",
                accountId,
            )
            .associate { it.s("fingerprint") to it.n("n") }
    val seen = mutableMapOf<String, Int>()
    val duplicate =
        rows
            .filter { r ->
                val n = (seen[r.fingerprint] ?: 0) + 1
                seen[r.fingerprint] = n
                r.error == null && n <= (counts[r.fingerprint] ?: 0L)
            }
            .map { it.rowNumber }
            .toSet()
    return StatementPreview(id(), accountId, filename.take(200), rows, duplicate, revision())
}

fun Ledger.confirmStatement(
    preview: StatementPreview,
    acknowledge: Boolean,
    skipInvalid: Boolean,
    keep: Set<Int> = emptySet(),
): List<Reference> = db.transaction {
    require(revision() == preview.revision) { "Workspace changed. Preview the statement again." }
    require(acknowledge || preview.duplicates.all { it in keep }) {
        "Acknowledge skipped duplicate rows."
    }
    require(skipInvalid || preview.rows.none { it.error != null }) { "Acknowledge invalid rows." }
    require(keep.all { it in preview.duplicates })
    require(one("SELECT id FROM imports WHERE id=?", preview.id) == null) {
        "Import already completed."
    }
    insert(
        "imports",
        obj(
            "id" to preview.id,
            "accountId" to preview.accountId,
            "fileName" to preview.filename,
            "hash" to sha256(gson.toJson(preview.rows).toByteArray()),
            "status" to "confirmed",
            "preview" to "{}",
            "createdAt" to now(),
            "summary" to "Statement imported",
        ),
    )
    val created = mutableListOf<Reference>()
    var payments = 0
    var skipped = 0
    preview.rows.forEach { row ->
        val status =
            when {
                row.error != null -> "invalid"
                row.rowNumber in preview.duplicates && row.rowNumber !in keep -> "duplicate"
                row.kind == "payment" -> "payment"
                else -> "imported"
            }
        val key = id()
        insert(
            "import_rows",
            obj(
                "id" to key,
                "importId" to preview.id,
                "accountId" to preview.accountId,
                "rowNumber" to row.rowNumber,
                "fingerprint" to row.fingerprint,
                "raw" to row.raw,
                "kind" to row.kind,
                "status" to status,
            ),
        )
        if (status == "imported") {
            val txId = id()
            insert(
                "transactions",
                obj(
                    "id" to txId,
                    "accountId" to preview.accountId,
                    "importRowId" to key,
                    "date" to row.date,
                    "postDate" to row.postDate,
                    "description" to row.description,
                    "amountCents" to row.amountCents,
                    "kind" to row.kind,
                    "bankCategory" to row.bankCategory,
                    "updatedAt" to now(),
                ),
            )
            created.add(Reference(txId, 1))
        } else if (status == "payment") payments++ else skipped++
    }
    db.execute(
        "UPDATE imports SET summary=? WHERE id=?",
        "${created.size} added to Inbox · $payments card payments · $skipped skipped",
        preview.id,
    )
    created
}

fun Ledger.finishImport(
    importId: String,
    items: List<Reference>,
    context: String,
    process: Boolean,
    from: String = "",
    to: String = "",
): List<String> = db.transaction {
    require(context.length <= 4000)
    resolveMentions(context)
    if (from.isNotEmpty()) date(from)
    if (to.isNotEmpty()) date(to)
    require(from.isEmpty() || to.isEmpty() || from <= to)
    val record =
        requireNotNull(one("SELECT * FROM imports WHERE id=? AND status='confirmed'", importId))
    val preview = record.doc("preview")
    val digest = sha256(gson.toJson(listOf(context.trim(), process, from, to)).toByteArray())
    if (preview.has("completion")) {
        require(preview.o("completion").s("digest") == digest) {
            "Import context step already completed."
        }
        return@transaction emptyList()
    }
    val imported =
        all(
            "SELECT t.* FROM transactions t JOIN import_rows r ON r.id=t.importRowId WHERE r.importId=?",
            importId,
        )
    require(
        imported.size == items.size &&
            items.map { it.id }.toSet() == imported.map { it.s("id") }.toSet()
    )
    if (context.isNotBlank() || process)
        require(
            items.all { r ->
                val t = tx(r.id)
                t.n("version") == r.version && t.s("state") == "inbox"
            }
        ) {
            "Imported expenses changed."
        }
    val scoped = imported.filter {
        context.isBlank() ||
            ((from.isEmpty() || it.s("date") >= from) && (to.isEmpty() || it.s("date") <= to))
    }
    if (context.isNotBlank()) {
        require(scoped.isNotEmpty()) { "No imported expenses in this range." }
        batch(
            "Save statement context",
            scoped.map { Change("transactions", it.s("id")) },
            step = "import:$importId:context",
        ) { batch ->
            scoped.forEach { t ->
                val notes =
                    t.docs("notes") +
                        obj(
                            "id" to id(),
                            "text" to context.trim(),
                            "source" to "import",
                            "createdAt" to now(),
                        )
                db.execute(
                    "UPDATE transactions SET instruction=?,notes=?,version=version+1,batchId=?,updatedAt=? WHERE id=?",
                    context.trim(),
                    gson.toJson(notes),
                    batch,
                    now(),
                    t.s("id"),
                )
            }
        }
    }
    preview.add(
        "completion",
        obj(
            "context" to context.trim(),
            "from" to from.ifEmpty { null },
            "to" to to.ifEmpty { null },
            "savedAt" to now(),
            "affectedCount" to if (context.isBlank()) 0 else scoped.size,
            "process" to process,
            "digest" to digest,
            "summary" to record.s("summary"),
        ),
    )
    db.execute("UPDATE imports SET preview=? WHERE id=?", gson.toJson(preview), importId)
    if (process) imported.map { it.s("id") } else emptyList()
}

data class TransferPreview(
    val bundle: JsonObject,
    val people: List<JsonObject>,
    val mapping: Map<String, String>,
    val rows: List<JsonObject>,
    val revision: String,
)

fun Ledger.previewTransfer(text: String): TransferPreview {
    require(text.toByteArray().size <= 10_000_000) { "JSON uploads must be smaller than 10 MB." }
    val bundle = json(text).asJsonObject
    require(
        bundle.s("format") == "splitwise-ai" &&
            bundle.n("version") == 1L &&
            bundle.s("currency") == "USD" &&
            bundle.s("kind") in setOf("transactions", "rules")
    ) {
        "Unsupported export format, version or currency."
    }
    val sourcePeople = bundle.a("people").map { it.asJsonObject }
    require(
        sourcePeople.size in 1..5000 &&
            sourcePeople.count { it.n("isSelf") == 1L } == 1 &&
            sourcePeople.any {
                it.n("isSelf") == 1L && it.s("id") == "self" && it.s("handle") == "me"
            }
    )
    require(
        sourcePeople.map { it.s("id") }.distinct().size == sourcePeople.size &&
            sourcePeople.map { it.s("handle") }.distinct().size == sourcePeople.size
    )
    val existing = people()
    val mapping = mutableMapOf<String, String>()
    val matches = sourcePeople.map { p ->
        require(p.s("id").length in 1..200 && p.n("isSelf") in 0..1)
        require(
            p.s("name").trim().length in 1..80 &&
                Regex("[a-z][a-z0-9_]{0,39}").matches(p.s("handle"))
        )
        val match = existing.find {
            if (p.n("isSelf") == 1L) it.n("isSelf") == 1L else it.s("handle") == p.s("handle")
        }
        val key =
            match?.s("id") ?: if (existing.any { it.s("id") == p.s("id") }) id() else p.s("id")
        mapping[p.s("id")] = key
        obj(
            "source" to p,
            "target" to (match ?: p.deepCopy().apply { addProperty("id", key) }),
            "existing" to (match != null),
        )
    }
    val accounts = all("SELECT * FROM accounts").associateBy { it.s("id") }
    bundle.a("accounts").forEach {
        val a = it.asJsonObject
        require(accounts[a.s("id")]?.s("format") == a.s("format")) {
            "Add matching card account ${a.s("name")} first."
        }
    }
    fun mapSpec(spec: JsonObject): JsonObject =
        spec.deepCopy().apply {
            val ids =
                spec.a("participants").map {
                    requireNotNull(mapping[it.asString]) { "Unknown participant." }
                }
            require(ids.isNotEmpty() && ids.distinct().size == ids.size)
            add("participants", gson.toJsonTree(ids))
            val s = SplitSpec.from(this)
            require(s.mode in setOf("personal", "equal", "exact", "percent"))
            if (s.mode == "percent")
                require(
                    s.values?.size == ids.size &&
                        s.values.all { it >= 0 } &&
                        s.values.sum() == 10000L
                )
        }
    val values = bundle.a(bundle.s("kind")).map { it.asJsonObject }
    require(values.size <= if (bundle.s("kind") == "transactions") 50000 else 5000)
    require(values.map { it.s("id") }.distinct().size == values.size)
    val occurrence = mutableMapOf<String, Int>()
    val existingTx = transactions()
    fun key(t: JsonObject) =
        gson.toJson(
            listOf(
                t.s("date"),
                t.s("postDate"),
                normalized(t.s("description")),
                t.n("amountCents"),
                t.s("kind"),
            )
        )
    val existingCounts = existingTx.groupBy(::key)
    val importedIds = values.map { it.s("id") }.toSet()
    val prepared = values.mapIndexed { index, value ->
        val t = value.deepCopy()
        if (bundle.s("kind") == "rules") {
            val d = t.o("definition")
            require(t.s("title").trim().length in 1..160)
            d.add("split", mapSpec(d.o("split")))
            require(d.s("outputCategory").length in 1..80 && d.s("merchant").length <= 200)
            if (d.s("from").isNotEmpty()) date(d.s("from"))
            if (d.s("to").isNotEmpty()) date(d.s("to"))
            val match = all("SELECT * FROM rules WHERE active=1").find { it.doc("definition") == d }
            obj(
                "rowNumber" to index + 1,
                "record" to t,
                "duplicate" to (match != null),
                "existingId" to match?.s("id"),
            )
        } else {
            date(t.s("date"))
            if (t.s("postDate").isNotEmpty()) date(t.s("postDate"))
            require(
                t.n("amountCents") != 0L &&
                    t.n("amountCents") in -1_000_000_000_000L..1_000_000_000_000L &&
                    (t.n("amountCents") < 0) == (t.s("kind") == "refund")
            )
            require(
                t.s("state") in setOf("inbox", "ready", "finalized") &&
                    t.s("kind") in setOf("expense", "refund") &&
                    t.s("description").trim().length in 1..200 &&
                    t.s("id").length in 1..200
            )
            require(accounts.containsKey(t.s("accountId"))) { "Unknown card account." }
            if (t.has("proposal") && !t["proposal"].isJsonNull) {
                val p = t.o("proposal")
                val shares =
                    p.shares().map { Share(requireNotNull(mapping[it.personId]), it.amountCents) }
                require(
                    shares.size in 1..30 &&
                        shares.map { it.personId }.distinct().size == shares.size &&
                        shares.sumOf { it.amountCents } == t.n("amountCents")
                )
                require(
                    shares.all {
                        it.amountCents in -1_000_000_000_000L..1_000_000_000_000L &&
                            (if (t.n("amountCents") < 0) it.amountCents <= 0
                            else it.amountCents >= 0)
                    }
                )
                p.add("splits", gson.toJsonTree(shares))
                if (p.has("spec")) {
                    p.add("spec", mapSpec(p.o("spec")))
                    if (p.s("refundOf").isEmpty())
                        require(
                            split(t.n("amountCents"), SplitSpec.from(p.o("spec"))).toSet() ==
                                shares.toSet()
                        )
                }
                if (p.s("refundOf").isNotEmpty())
                    require(
                        p.s("refundOf") in importedIds ||
                            existingTx.any { it.s("id") == p.s("refundOf") }
                    ) {
                        "Include the original purchase for this refund."
                    }
                p.remove("ruleId")
                p.remove("ruleVersion")
                p.remove("tripId")
                p.remove("tripVersion")
            } else require(t.s("state") == "inbox") { "Reviewed transactions need allocations." }
            val hash = key(t)
            val n = (occurrence[hash] ?: 0) + 1
            occurrence[hash] = n
            val sameId = existingTx.find { it.s("id") == t.s("id") }
            require(sameId == null || key(sameId) == hash) {
                "Transaction ID collides with different financial details."
            }
            val match = sameId ?: existingCounts[hash]?.getOrNull(n - 1)
            obj(
                "rowNumber" to index + 1,
                "record" to t,
                "duplicate" to (match != null),
                "existingId" to match?.s("id"),
            )
        }
    }
    return TransferPreview(bundle, matches, mapping, prepared, revision())
}

fun Ledger.confirmTransfer(
    preview: TransferPreview,
    acknowledgePeople: Boolean,
    acknowledgeSkips: Boolean,
    keep: Set<Int> = emptySet(),
) = db.transaction {
    require(acknowledgePeople) { "Acknowledge the participant matches." }
    require(revision() == preview.revision) { "Workspace changed. Refresh the preview." }
    require(
        acknowledgeSkips ||
            preview.rows.none { it.b("duplicate") && it.n("rowNumber").toInt() !in keep }
    ) {
        "Acknowledge duplicate skips."
    }
    preview.people.filter { !it.b("existing") }.forEach { insert("people", it.o("target")) }
    val selected = preview.rows.filter { !it.b("duplicate") || it.n("rowNumber").toInt() in keep }
    if (preview.bundle.s("kind") == "rules") {
        val changes = selected.map { it to id() }
        if (changes.isNotEmpty())
            batch("Import rule proposals", changes.map { Change("rule_changes", it.second) }) {
                changes.forEach { (row, key) ->
                    val r = row.o("record")
                    insert(
                        "rule_changes",
                        obj(
                            "id" to key,
                            "ruleId" to null,
                            "title" to r.s("title"),
                            "definition" to r.o("definition"),
                            "status" to "proposed",
                            "baseVersion" to null,
                        ),
                    )
                }
            }
    } else {
        val keys =
            preview.rows.associate { row ->
                row.o("record").s("id") to
                    if (row in selected) {
                        if (row.b("duplicate")) id() else row.o("record").s("id")
                    } else row.s("existingId")
            }
        val import = id()
        val account =
            preview.bundle.a("accounts").firstOrNull()?.asJsonObject?.s("id") ?: "sapphire"
        insert(
            "imports",
            obj(
                "id" to import,
                "accountId" to account,
                "fileName" to "Transactions JSON",
                "hash" to sha256(gson.toJson(preview.bundle).toByteArray()),
                "status" to "confirmed",
                "preview" to "{}",
                "createdAt" to now(),
                "summary" to "${selected.size} JSON transactions imported for review",
            ),
        )
        selected.forEach { row ->
            val t = row.o("record")
            val source = id()
            val p = t.get("proposal")?.takeUnless { it.isJsonNull }?.asJsonObject
            if (p != null && p.s("refundOf").isNotEmpty())
                p.addProperty("refundOf", keys[p.s("refundOf")] ?: p.s("refundOf"))
            insert(
                "import_rows",
                obj(
                    "id" to source,
                    "importId" to import,
                    "accountId" to t.s("accountId"),
                    "rowNumber" to row.n("rowNumber"),
                    "fingerprint" to sha256(gson.toJson(t).toByteArray()),
                    "raw" to t.o("raw"),
                    "kind" to t.s("kind"),
                    "status" to "imported",
                ),
            )
            insert(
                "transactions",
                obj(
                    "id" to keys[t.s("id")],
                    "accountId" to t.s("accountId"),
                    "importRowId" to source,
                    "date" to t.s("date"),
                    "postDate" to t.s("postDate").ifEmpty { null },
                    "description" to t.s("description"),
                    "amountCents" to t.n("amountCents"),
                    "kind" to t.s("kind"),
                    "bankCategory" to t.s("bankCategory"),
                    "proposal" to p,
                    "state" to if (p != null && p.s("refundOf").isEmpty()) "ready" else "inbox",
                    "instruction" to t.s("instruction"),
                    "notes" to t.a("notes"),
                    "attention" to t.s("attention"),
                    "updatedAt" to now(),
                ),
            )
        }
    }
}

fun Ledger.exportTransfer(
    kind: String,
    from: String = "",
    to: String = "",
    state: String = "",
): String {
    require(kind in setOf("transactions", "rules"))
    val result =
        obj(
            "format" to "splitwise-ai",
            "version" to 1,
            "kind" to kind,
            "currency" to "USD",
            "exportedAt" to now(),
            "people" to people(),
            "accounts" to all("SELECT * FROM accounts"),
        )
    if (kind == "rules") {
        result.add(
            "rules",
            gson.toJsonTree(
                all("SELECT * FROM rules WHERE active=1").map {
                    obj(
                        "id" to it.s("id"),
                        "title" to it.s("title"),
                        "definition" to it.doc("definition"),
                        "status" to "active",
                    )
                } +
                    all("SELECT * FROM rule_changes WHERE status='proposed'").map {
                        obj(
                            "id" to it.s("id"),
                            "title" to it.s("title"),
                            "definition" to it.doc("definition"),
                            "status" to "proposed",
                        )
                    }
            ),
        )
    } else {
        val all = transactions()
        val chosen =
            all.filter {
                    (from.isEmpty() || it.s("date") >= from) &&
                        (to.isEmpty() || it.s("date") <= to) &&
                        (state.isEmpty() || it.s("state") == state)
                }
                .toMutableList()
        val purchases =
            chosen
                .map { it.doc("proposal").s("refundOf") }
                .filter { it.isNotEmpty() }
                .toMutableSet()
        purchases.addAll(chosen.map { it.s("id") })
        all.filter {
                it.s("id") in purchases ||
                    (it.s("state") == "finalized" && it.doc("proposal").s("refundOf") in purchases)
            }
            .forEach { if (chosen.none { c -> c.s("id") == it.s("id") }) chosen.add(it) }
        result.add(
            "transactions",
            gson.toJsonTree(
                chosen.map { t ->
                    t.deepCopy().apply {
                        add(
                            "proposal",
                            t.get("proposal")
                                ?.takeUnless { it.isJsonNull }
                                ?.let { t.doc("proposal") } ?: JsonNull.INSTANCE,
                        )
                        add("notes", gson.toJsonTree(t.docs("notes")))
                        add(
                            "raw",
                            one("SELECT raw FROM import_rows WHERE id=?", t.s("importRowId"))
                                ?.doc("raw") ?: JsonObject(),
                        )
                    }
                }
            ),
        )
    }
    return GsonBuilder().setPrettyPrinting().serializeNulls().create().toJson(result)
}

fun Ledger.exportCsv(from: String = "", to: String = "", state: String = ""): String {
    fun csv(text: String): String {
        val safe = if (Regex("^[\\s]*[=+@-]").containsMatchIn(text)) "'$text" else text
        return "\"${safe.replace("\"", "\"\"")}\""
    }
    return buildString {
        appendLine("Date,Description,Amount,State,Category,Allocations")
        transactions()
            .filter {
                (from.isEmpty() || it.s("date") >= from) &&
                    (to.isEmpty() || it.s("date") <= to) &&
                    (state.isEmpty() || it.s("state") == state)
            }
            .forEach { t ->
                val p = t.doc("proposal")
                appendLine(
                    listOf(
                            t.s("date"),
                            t.s("description"),
                            money(t.n("amountCents")),
                            t.s("state"),
                            p.s("category"),
                            p.shares().joinToString {
                                "${people().find { p -> p.s("id") == it.personId }?.s("name")}: ${money(it.amountCents)}"
                            },
                        )
                        .joinToString(",", transform = ::csv)
                )
            }
    }
}
