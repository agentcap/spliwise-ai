package com.splitwiseai.ledger

import com.google.gson.*
import java.math.BigInteger
import java.security.MessageDigest
import java.time.LocalDate
import java.util.UUID

val gson: Gson = GsonBuilder().disableHtmlEscaping().serializeNulls().create()

fun json(text: String): JsonElement = JsonParser.parseString(text)

fun obj(vararg fields: Pair<String, Any?>): JsonObject =
    JsonObject().apply {
        fields.forEach { (key, value) -> add(key, gson.toJsonTree(value)) }
    }

fun JsonObject.s(key: String, default: String = ""): String =
    get(key)?.takeUnless { it.isJsonNull }?.asString ?: default

fun JsonObject.n(key: String, default: Long = 0): Long =
    get(key)?.takeUnless { it.isJsonNull }?.asBigDecimal?.longValueExact() ?: default

fun JsonObject.b(key: String): Boolean = get(key)?.takeUnless { it.isJsonNull }?.asBoolean ?: false

fun JsonObject.a(key: String): List<JsonElement> =
    get(key)?.takeIf { it.isJsonArray }?.asJsonArray?.toList() ?: emptyList()

fun JsonObject.o(key: String): JsonObject =
    get(key)?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()

fun JsonObject.doc(key: String): JsonObject =
    get(key)?.let {
        if (it.isJsonNull) null
        else if (it.isJsonObject) it.asJsonObject else json(it.asString).asJsonObject
    } ?: JsonObject()

fun JsonObject.docs(key: String): List<JsonObject> =
    get(key)?.let {
        if (it.isJsonNull) null
        else (if (it.isJsonArray) it else json(it.asString)).asJsonArray.map { v -> v.asJsonObject }
    } ?: emptyList()

fun id(): String = UUID.randomUUID().toString()

fun now(): String = java.time.Instant.now().toString()

fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

fun normalized(value: String): String =
    value.trim().replace(Regex("\\s+"), " ").uppercase(java.util.Locale.ROOT)

fun date(value: String): String {
    require(Regex("\\d{4}-\\d{2}-\\d{2}").matches(value)) { "Use YYYY-MM-DD." }
    require(LocalDate.parse(value).toString() == value)
    return value
}

fun cents(value: String): Long {
    val cleaned = value.trim().replace("$", "").replace(",", "")
    require(Regex("-?\\d+(\\.\\d{1,2})?").matches(cleaned)) {
        "Enter an amount with at most two decimal places."
    }
    val amount = cleaned.toBigDecimal().movePointRight(2).longValueExact()
    require(kotlin.math.abs(amount) <= 1_000_000_000_000L) { "Amount is too large." }
    return amount
}

fun money(value: Long): String =
    java.text.NumberFormat.getCurrencyInstance(java.util.Locale.US)
        .format(value.toBigDecimal().movePointLeft(2))

data class Share(val personId: String, val amountCents: Long)

data class SplitSpec(
    val mode: String = "personal",
    val participants: List<String> = listOf("self"),
    val values: List<Long>? = null,
) {
    fun toJson(): JsonObject =
        obj("mode" to mode, "participants" to participants).apply {
            if (values != null) add("values", gson.toJsonTree(values))
        }

    companion object {
        fun from(value: JsonObject): SplitSpec =
            SplitSpec(
                value.s("mode"),
                value.a("participants").map { it.asString },
                value
                    .get("values")
                    ?.takeIf { it.isJsonArray }
                    ?.asJsonArray
                    ?.map { it.asBigDecimal.longValueExact() },
            )
    }
}

fun allocate(total: Long, ids: List<String>, weights: List<Long>): List<Share> {
    require(ids.isNotEmpty() && ids.size == weights.size && ids.distinct().size == ids.size) {
        "Choose distinct participants."
    }
    require(weights.all { it >= 0 } && weights.any { it > 0 }) { "Invalid split weights." }
    val sum = weights.fold(BigInteger.ZERO) { a, b -> a + b.toBigInteger() }
    val amount = total.toBigInteger().abs()
    val fractions = weights.map { (amount * it.toBigInteger()).divideAndRemainder(sum) }
    val parts = fractions.map { it[0].longValueExact() }.toMutableList()
    val remaining =
        (amount - parts.fold(BigInteger.ZERO) { a, b -> a + b.toBigInteger() }).intValueExact()
    val order =
        ids.indices.sortedWith(compareByDescending<Int> { fractions[it][1] }.thenBy { ids[it] })
    repeat(remaining) { parts[order[it % order.size]]++ }
    return ids.mapIndexed { i, person -> Share(person, parts[i] * if (total < 0) -1 else 1) }
}

fun split(total: Long, spec: SplitSpec): List<Share> {
    require(total in -1_000_000_000_000L..1_000_000_000_000L)
    if (spec.mode == "personal") return listOf(Share("self", total))
    require(
        spec.participants.isNotEmpty() &&
            spec.participants.distinct().size == spec.participants.size
    ) {
        "Choose distinct participants."
    }
    if (spec.mode == "equal")
        return allocate(total, spec.participants, spec.participants.map { 1L })
    val values = requireNotNull(spec.values) { "Every participant needs a value." }
    require(values.size == spec.participants.size)
    require(values.all { it in -1_000_000_000_000L..1_000_000_000_000L }) {
        "Split value is too large."
    }
    if (spec.mode == "percent") {
        require(values.all { it in 0..10000L } && values.sum() == 10000L) {
            "Percentages must total 100%."
        }
        return allocate(total, spec.participants, values)
    }
    require(spec.mode == "exact" && values.sum() == total) {
        "Exact amounts must equal the expense."
    }
    require(values.all { if (total < 0) it <= 0 else it >= 0 }) {
        "Split amounts must have the same sign as the expense."
    }
    return spec.participants.mapIndexed { i, person -> Share(person, values[i]) }
}

fun refundShares(original: List<Share>, amount: Long, previous: List<List<Share>>): List<Share> {
    require(amount < 0) { "Refund must be negative." }
    val used = -previous.flatten().sumOf { it.amountCents }
    require(-amount <= original.sumOf { it.amountCents } - used) {
        "Refund exceeds the remaining refundable amount."
    }
    return allocate(amount - used, original.map { it.personId }, original.map { it.amountCents })
        .map { share ->
            Share(
                share.personId,
                share.amountCents -
                    previous
                        .flatten()
                        .filter { it.personId == share.personId }
                        .sumOf { it.amountCents },
            )
        }
}

fun JsonObject.shares(): List<Share> =
    a("splits").map { Share(it.asJsonObject.s("personId"), it.asJsonObject.n("amountCents")) }

fun proposal(
    total: Long,
    spec: SplitSpec,
    category: String = "Uncategorized",
    source: String = "manual",
    explanation: String = "Your split",
): JsonObject =
    obj(
        "splits" to split(total, spec),
        "category" to category,
        "confidence" to "high",
        "source" to source,
        "explanation" to explanation,
        "spec" to spec.toJson(),
    )

data class BalanceExpense(
    val transactionId: String,
    val date: String,
    val description: String,
    val allocatedCents: Long,
    var refundedCents: Long = 0,
    var paidCents: Long = 0,
    var remainingCents: Long = 0,
)

data class PersonBalance(
    val person: JsonObject,
    val expenses: List<BalanceExpense>,
    val outstandingCents: Long,
    val inRangeOutstandingCents: Long,
    val creditCents: Long,
    val receivedCents: Long,
    val returnedCents: Long,
)

fun balances(
    transactions: List<JsonObject>,
    people: List<JsonObject>,
    repayments: List<JsonObject>,
    from: String = "",
    to: String = "",
): List<PersonBalance> {
    val final = transactions.filter {
        it.s("state") == "finalized" && it.doc("proposal").size() > 0
    }
    return people
        .filter { it.n("isSelf") == 0L }
        .map { person ->
            val expenses =
                final
                    .filter { it.n("amountCents") > 0 }
                    .map { tx ->
                        BalanceExpense(
                            tx.s("id"),
                            tx.s("date"),
                            tx.s("description"),
                            tx.doc("proposal")
                                .shares()
                                .firstOrNull { it.personId == person.s("id") }
                                ?.amountCents ?: 0,
                        )
                    }
                    .filter { it.allocatedCents > 0 }
                    .sortedWith(compareBy<BalanceExpense> { it.date }.thenBy { it.transactionId })
            var credit = 0L
            final
                .filter { it.n("amountCents") < 0 }
                .forEach { tx ->
                    val p = tx.doc("proposal")
                    val amount =
                        -(p.shares().firstOrNull { it.personId == person.s("id") }?.amountCents
                            ?: 0L)
                    val expense = expenses.find { it.transactionId == p.s("refundOf") }
                    if (expense == null) credit += amount
                    else {
                        val applied = minOf(amount, expense.allocatedCents - expense.refundedCents)
                        expense.refundedCents += applied
                        credit += amount - applied
                    }
                }
            val payments = repayments.filter { it.s("personId") == person.s("id") }
            val received =
                payments.filter { it.s("direction") == "received" }.sumOf { it.n("amountCents") }
            val returned =
                payments.filter { it.s("direction") == "returned" }.sumOf { it.n("amountCents") }
            var funds = credit + received - returned
            expenses.forEach { e ->
                val net = maxOf(0, e.allocatedCents - e.refundedCents)
                e.paidCents = minOf(net, maxOf(0, funds))
                e.remainingCents = net - e.paidCents
                funds -= e.paidCents
            }
            PersonBalance(
                person,
                expenses,
                expenses.sumOf { it.remainingCents } + maxOf(0, -funds),
                expenses
                    .filter {
                        (from.isEmpty() || it.date >= from) && (to.isEmpty() || it.date <= to)
                    }
                    .sumOf { it.remainingCents },
                maxOf(0, funds),
                received,
                returned,
            )
        }
}

data class ParsedRow(
    val rowNumber: Int,
    val raw: Map<String, String>,
    val date: String?,
    val postDate: String?,
    val description: String,
    val amountCents: Long?,
    val bankCategory: String,
    val kind: String,
    val fingerprint: String,
    val error: String? = null,
)

fun parseCsv(text: String): List<List<String>> {
    val result = mutableListOf<List<String>>()
    var row = mutableListOf<String>()
    val cell = StringBuilder()
    var quoted = false
    var closed = false
    var i = 0
    fun addCell() {
        row.add(cell.toString())
        cell.clear()
        closed = false
    }
    fun addRow() {
        addCell()
        if (row.any { it.isNotEmpty() }) result.add(row)
        row = mutableListOf()
    }
    val source = text.removePrefix("\uFEFF")
    while (i < source.length) {
        val c = source[i++]
        if (quoted) {
            if (c == '"') {
                if (i < source.length && source[i] == '"') {
                    cell.append('"')
                    i++
                } else {
                    quoted = false
                    closed = true
                }
            } else cell.append(c)
        } else
            when (c) {
                '"' -> {
                    require(cell.isEmpty() && !closed) { "Invalid CSV quotation marks." }
                    quoted = true
                }
                ',' -> addCell()
                '\n' -> addRow()
                '\r' -> {
                    if (i < source.length && source[i] == '\n') i++
                    addRow()
                }
                else -> {
                    require(!closed) { "Unexpected text after CSV quote." }
                    cell.append(c)
                }
            }
    }
    require(!quoted) { "Unclosed CSV quotation marks." }
    if (cell.isNotEmpty() || row.isNotEmpty() || closed) addRow()
    return result
}

fun parseStatement(content: String, format: String): List<ParsedRow> {
    require(content.toByteArray().size <= 10_000_000) { "Statements must be smaller than 10 MB." }
    require(format in listOf("amex", "chase"))
    val records = parseCsv(content)
    require(records.size in 2..50001) { "Choose a statement with 1–50,000 rows." }
    val header = records.first().map { it.trim() }
    val expected =
        if (format == "amex") listOf("Date", "Description", "Amount")
        else
            listOf(
                "Transaction Date",
                "Post Date",
                "Description",
                "Category",
                "Type",
                "Amount",
                "Memo",
            )
    require(header == expected) { "Wrong card format. Expected ${expected.joinToString()}" }
    fun bankDate(value: String): String {
        val m =
            requireNotNull(Regex("(\\d{2})/(\\d{2})/(\\d{4})").matchEntire(value.trim())) {
                "Expected MM/DD/YYYY."
            }
        return date("${m.groupValues[3]}-${m.groupValues[1]}-${m.groupValues[2]}")
    }
    return records.drop(1).mapIndexed { i, cells ->
        val raw = header.mapIndexed { n, name -> name to cells.getOrElse(n) { "" } }.toMap()
        var day: String? = null
        var posted: String? = null
        var amount: Long? = null
        var kind = "expense"
        var fingerprint = ""
        var error: String? = null
        val description = raw.getValue("Description").trim()
        try {
            require(cells.size == header.size) { "Column count does not match header." }
            day = bankDate(raw.getValue(if (format == "amex") "Date" else "Transaction Date"))
            posted = if (format == "chase") bankDate(raw.getValue("Post Date")) else null
            require(description.isNotEmpty()) { "Description is empty." }
            amount = cents(raw.getValue("Amount")) * if (format == "chase") -1 else 1
            require(amount != 0L) { "Zero-amount row." }
            val payment =
                if (format == "chase") raw["Type"]?.trim()?.lowercase() == "payment"
                else
                    Regex(
                            "^(AUTOPAY PAYMENT|MOBILE PAYMENT|ONLINE PAYMENT|PAYMENT RECEIVED)(\\s|$)",
                            RegexOption.IGNORE_CASE,
                        )
                        .containsMatchIn(description)
            kind = if (payment) "payment" else if (amount < 0) "refund" else "expense"
            fingerprint =
                sha256(
                    gson
                        .toJson(listOf(day, posted, normalized(description), amount, kind))
                        .toByteArray()
                )
        } catch (e: Exception) {
            error = e.message ?: "Invalid row."
        }
        ParsedRow(
            i + 2,
            raw,
            day,
            posted,
            description,
            amount,
            raw["Category"]?.trim() ?: "",
            kind,
            fingerprint,
            error,
        )
    }
}

interface LedgerDatabase : AutoCloseable {
    fun rows(sql: String, vararg args: Any?): List<JsonObject>

    fun execute(sql: String, vararg args: Any?)

    fun <T> transaction(work: () -> T): T
}
