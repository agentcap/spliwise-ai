package com.splitwiseai.assistant

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.splitwiseai.ledger.*
import java.math.BigDecimal
import java.util.Locale

/** Android port of the frozen v2 interface. Semantic decisions remain with the model. */
internal object ReducedToolInterface {
    private val routes = linkedMapOf(
        "propose_split" to "split|divid|allocat|portions?|shares?|half|halves|percent|%|personal|mine|belongs?|receipts?|purchases?|charges?",
        "search_transactions" to "find|search|locate|unfinished|receipts?|purchases?|charges?|expenses?",
        "lookup_context" to "rules?|polic|trips?|templates?|saved|remember|notes?|facts?|forget|erase|retire|archive|reopen",
        "save_rule" to "rules?|polic|recurr|ongoing|always|every|automati|future|whenever",
        "save_user_fact" to "remember|notes?|facts?|retain|context|access code|keep in mind|relationship|roommate|colleague|lives?|allerg|prefer",
        "delete_saved_item" to "delete|remove|erase|forget|retire|discard",
        "optimize_rules" to "optimi|deduplic|redundan|clean up|cleanup|consolidat",
        "manage_trip" to "trips?|destination|archive|reopen|vacation|journey",
        "add_person" to "new person|new contact|new colleague|add .*@|create .*person|introduce|register",
        "save_template" to "templates?|preset",
        "save_alias" to "alias|display|merchant name|label|rename|readable|call .* as|show .* as",
        "prepare_assignment" to "assign|attach|detach|membership|place .*in|move .*trip|remove .*trip",
        "prepare_expense" to "cash|manual|out.of.pocket|expense card|purchase card|record .*paid|spent",
        "prepare_repayment" to "repay|paid me|received|sent me|return .*credit|credit .*return|refund .*credit",
    ).mapValues { Regex(it.value) }

    fun names(userText: String, selected: Boolean): Set<String> {
        val text = userText.lowercase(Locale.ROOT)
        val result = mutableSetOf("finish_reply", "request_clarification")
        routes.forEach { (name, pattern) -> if (pattern.containsMatchIn(text)) result += name }
        if (selected) {
            result += "propose_split"
            if (!Regex("find|search|locate|unfinished|workspace|outside").containsMatchIn(text))
                result -= "search_transactions"
        }
        return result
    }

    fun policy(original: String): String = original
        .replace("Amounts are USD integer cents.", "Workspace amounts are USD integer cents. In tools enter amount in dollars, and shares in dollars for exact mode or percentages for percent mode.")
        .replace("exact values are cents; percent values are basis points totaling 10000.", "For tools use shares in dollars for exact mode, or percentages totaling 100 for percent mode.")
        .replace("Omit values for personal/equal.", "Omit shares for personal/equal.")
        .replace("propose_split requires a real ID and current version.", "propose_split requires a real ID, unless exactly one expense is selected. The application supplies current versions from visible records.") +
        "\nExperimental interface: version and versions are supplied by the application from records already shown to you. Never guess an ID. You may use exact @handles for people. Use amount (dollars) instead of amountCents, and shares instead of values. The application converts units and the ledger calculates equal/percentage allocations. For propose_split, category defaults to the visible expense category and explanation defaults to your latest user instruction. Choose the requested people, scope, action, and finish outcome yourself. Only exposed tools are available."

    fun schemas(original: List<JsonObject>, userText: String, summary: JsonObject): List<JsonObject> {
        val selected = summary.a("selectedExpenses")
        val keep = names(userText, selected.size > 0)
        return original.filter { it.s("name") in keep }.map { source ->
            val row = source.deepCopy()
            val p = row.getAsJsonObject("parameters")
            val props = p.getAsJsonObject("properties")
            var required = p.a("required").map { it.asString }.filter { it !in setOf("version", "versions") }
            props.remove("version")
            props.remove("versions")
            if (props.has("amountCents")) {
                props.remove("amountCents")
                props.add("amount", obj("type" to "number", "description" to "USD dollars, for example 12.34."))
                required = required.map { if (it == "amountCents") "amount" else it }
            }
            if (props.has("values")) {
                props.remove("values")
                props.add("shares", obj("type" to "array", "items" to obj("type" to "number"),
                    "description" to "Parallel to participants: USD dollars in exact mode; percentages totaling 100 in percent mode. Omit for equal/personal."))
            }
            if (row.s("name") in setOf("search_transactions", "lookup_context"))
                required = required.filter { it != "offset" }
            if (row.s("name") == "propose_split") {
                required = required.filter { it !in setOf("category", "explanation") }
                if (selected.size == 1) required = required.filter { it != "transactionId" }
            }
            p.add("required", gson.toJsonTree(required))
            row.addProperty("description", row.s("description")
                .replace("Values are integer cents for exact mode, basis points totaling 10000 for percent.", "Use shares in dollars for exact mode or percentages totaling 100 for percent mode.")
                .replace("Use the latest expense version.", "The application supplies the observed current version.")
                .replace("transactionIds and versions must be parallel arrays from the ledger.", "Use transactionIds from the visible ledger; the application supplies their versions.")
                .replace("using its latest ID and version from lookup_context.", "using its ID from lookup_context; the application supplies its observed version."))
            row
        }
    }

    fun arguments(name: String, original: JsonObject, summary: JsonObject,
                  responses: List<JsonObject>, userText: String): JsonObject {
        val a = original.deepCopy()
        val records = mutableMapOf<String, JsonObject>()
        fun walk(value: JsonElement) {
            if (value.isJsonObject) {
                val row = value.asJsonObject
                if (row.get("id")?.let { it.isJsonPrimitive && it.asJsonPrimitive.isString } == true &&
                    row.get("version")?.let { it.isJsonPrimitive && it.asJsonPrimitive.isNumber &&
                        it.asBigDecimal.stripTrailingZeros().scale() <= 0 } == true)
                    records[row.s("id")] = row
                row.entrySet().forEach { walk(it.value) }
            } else if (value.isJsonArray) value.asJsonArray.forEach { walk(it) }
        }
        walk(summary)
        responses.forEach { walk(it) }
        fun hundred(value: JsonElement): Long = try {
            BigDecimal(value.asString).movePointRight(2).longValueExact()
        } catch (e: Exception) {
            throw IllegalArgumentException("Amounts and percentages must have at most two decimal places")
        }
        fun default(key: String, value: JsonElement) { if (!a.has(key)) a.add(key, value.deepCopy()) }
        if (a.has("amount")) {
            require(!a.has("amountCents")) { "Use only amount, not amountCents" }
            a.addProperty("amountCents", hundred(a.remove("amount")))
        }
        if (a.has("shares")) {
            require(a.s("mode") in setOf("percent", "exact")) { "shares requires exact or percent mode" }
            require(!a.has("values")) { "Use only shares, not values" }
            a.add("values", gson.toJsonTree(a.remove("shares").asJsonArray.map { hundred(it) }))
        }
        if (name in setOf("search_transactions", "lookup_context") && !a.has("offset")) a.addProperty("offset", 0)
        if (name == "propose_split") {
            val selected = summary.a("selectedExpenses")
            if (a.s("transactionId").isEmpty() && selected.size == 1)
                a.addProperty("transactionId", selected[0].asJsonObject.s("id"))
            records[a.s("transactionId")]?.let { record ->
                default("version", record.get("version"))
                if (!a.has("category")) a.addProperty("category", record.s("bankCategory").ifEmpty { record.s("category") })
            }
            if (!a.has("explanation")) a.addProperty("explanation", userText)
        }
        if (name == "request_clarification") records[a.s("transactionId")]?.let { default("version", it.get("version")) }
        records[a.s("id")]?.let { default("version", it.get("version")) }
        if (name == "prepare_assignment" && !a.has("versions")) {
            val ids = a.a("transactionIds").map { it.asString }
            if (ids.isNotEmpty() && ids.all { it in records })
                a.add("versions", gson.toJsonTree(ids.map { records.getValue(it).n("version") }))
        }
        return a
    }
}
