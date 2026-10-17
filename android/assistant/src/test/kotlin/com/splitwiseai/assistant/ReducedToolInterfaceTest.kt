package com.splitwiseai.assistant

import com.splitwiseai.ledger.*
import org.junit.Assert.*
import org.junit.Test

class ReducedToolInterfaceTest {
    private val fixtures = javaClass.getResourceAsStream("/gemma-v2-parity.json")!!
        .bufferedReader().use { json(it.readText()).asJsonObject }

    @Test fun androidMatchesTheMeasuredInterface() {
        val schemas = fixtures.a("schemas").map { it.asJsonObject }
        assertEquals(fixtures.s("expectedPolicy"), ReducedToolInterface.policy(fixtures.s("policy")))
        fixtures.a("views").forEach { value ->
            val row = value.asJsonObject
            assertEquals(row.get("expected"), gson.toJsonTree(ReducedToolInterface.schemas(
                schemas, row.s("text"), row.getAsJsonObject("summary"))))
        }
        fixtures.a("translations").forEach { value ->
            val row = value.asJsonObject
            assertEquals(row.get("expected"), ReducedToolInterface.arguments(row.s("name"),
                row.getAsJsonObject("arguments"), row.getAsJsonObject("summary"),
                row.a("responses").map { it.asJsonObject }, row.s("text")))
        }
    }

    @Test fun invalidMonetaryPrecisionNeverReachesTheLedger() {
        listOf("1.001", "NaN", "Infinity", "999999999999999999999999").forEach { amount ->
            try {
                ReducedToolInterface.arguments("prepare_expense", obj("amount" to amount),
                    obj(), emptyList(), "Record an expense")
                fail("Invalid amount accepted: $amount")
            } catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun amountsAndSharesCannotConflictWithNativeUnits() {
        listOf(obj("amount" to 12, "amountCents" to 1200),
            obj("mode" to "percent", "shares" to listOf(100), "values" to listOf(10000)),
            obj("mode" to "equal", "shares" to listOf(100))).forEach { args ->
            try {
                ReducedToolInterface.arguments("propose_split", args, obj(), emptyList(), "Split")
                fail("Conflicting units accepted")
            } catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun bundledPolicyIsAvailableToAndroidAndDesktop() {
        val policy = javaClass.getResourceAsStream("/gemma-v2-policy.txt")!!
            .bufferedReader().use { it.readText() }
        assertEquals(fixtures.s("policy"), policy)
    }
}
