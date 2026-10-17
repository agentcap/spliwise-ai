package com.splitwiseai.ledger

import com.google.gson.*
import java.io.File
import java.sql.DriverManager
import kotlin.test.*

class TestDatabase : LedgerDatabase {
    private val db = DriverManager.getConnection("jdbc:sqlite::memory:")
    private var depth = 0

    init {
        execute("PRAGMA foreign_keys=ON")
    }

    override fun rows(sql: String, vararg args: Any?): List<JsonObject> =
        db.prepareStatement(sql).use { statement ->
            args.forEachIndexed { i, v -> statement.setObject(i + 1, v) }
            statement.executeQuery().use { rows ->
                buildList {
                    while (rows.next()) add(
                        JsonObject().apply {
                            repeat(rows.metaData.columnCount) { i ->
                                add(
                                    rows.metaData.getColumnName(i + 1),
                                    gson.toJsonTree(rows.getObject(i + 1)),
                                )
                            }
                        }
                    )
                }
            }
        }

    override fun execute(sql: String, vararg args: Any?) {
        db.prepareStatement(sql).use { statement ->
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

    override fun close() {
        db.close()
    }
}

fun testLedger(): Ledger {
    val db = TestDatabase()
    val root = File(System.getProperty("repoRoot"))
    val journal =
        json(File(root, "drizzle/meta/_journal.json").readText()).asJsonObject.a("entries")
    db.execute(
        "CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,hash text NOT NULL,created_at numeric)"
    )
    journal.forEach { item ->
        val entry = item.asJsonObject
        val sql = File(root, "drizzle/${entry.s("tag")}.sql").readText()
        sql.split("--> statement-breakpoint").filter { it.isNotBlank() }.forEach { db.execute(it) }
        db.execute(
            "INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)",
            sha256(sql.toByteArray()),
            entry.n("when"),
        )
    }
    return Ledger(db).also { it.seed() }
}

class ParityTest {
    private val fixture = json(javaClass.getResource("/parity.json")!!.readText()).asJsonObject

    @Test
    fun allocationsMatchWebLedger() {
        fixture.a("allocations").forEach { item ->
            val t = item.asJsonObject
            assertEquals(
                t.a("expected").map {
                    Share(it.asJsonObject.s("personId"), it.asJsonObject.n("amountCents"))
                },
                allocate(
                    t.n("total"),
                    t.a("ids").map { it.asString },
                    t.a("weights").map { it.asLong },
                ),
            )
        }
    }

    @Test
    fun refundsMatchWebLedger() {
        fixture.a("refunds").forEach { item ->
            val t = item.asJsonObject
            fun shares(a: List<JsonElement>): List<Share> = a.map {
                Share(it.asJsonObject.s("personId"), it.asJsonObject.n("amountCents"))
            }
            assertEquals(
                shares(t.a("expected")),
                refundShares(
                    shares(t.a("original")),
                    t.n("amount"),
                    t.a("previous").map { shares(it.asJsonArray.toList()) },
                ),
            )
        }
    }

    @Test
    fun balancesMatchWebLedger() {
        fixture.a("balanceCases").forEach { item ->
            val t = item.asJsonObject
            val actual =
                balances(
                    t.a("transactions").map { it.asJsonObject },
                    t.a("people").map { it.asJsonObject },
                    t.a("repayments").map { it.asJsonObject },
                    t.s("from"),
                    t.s("to"),
                )
            actual.zip(t.a("expected")).forEach { (a, e) ->
                val v = e.asJsonObject
                assertEquals(v.n("outstandingCents"), a.outstandingCents)
                assertEquals(v.n("inRangeOutstandingCents"), a.inRangeOutstandingCents)
                assertEquals(v.n("creditCents"), a.creditCents)
                assertEquals(v.a("expenses"), gson.toJsonTree(a.expenses).asJsonArray.toList())
            }
        }
    }

    @Test
    fun statementFingerprintsMatchWebLedger() {
        fixture.a("statements").forEach { item ->
            val t = item.asJsonObject
            val actual = parseStatement(t.s("text"), t.s("format"))
            actual.zip(t.a("expected")).forEach { (a, e) ->
                val v = e.asJsonObject
                assertEquals(v.s("fingerprint"), a.fingerprint)
                assertEquals(v.s("description"), a.description)
                assertEquals(v.s("kind"), a.kind)
                assertEquals(v.has("error"), a.error != null)
            }
        }
    }

    @Test
    fun rejectsInvalidMoneyAndCsv() {
        listOf("NaN", "1e3", "1.001", "1000000000000.01").forEach { assertFails { cents(it) } }
        assertFails { parseCsv("a,b\n\"unterminated,b") }
        assertFails { split(100, SplitSpec("percent", listOf("self", "alex"), listOf(5000, 4000))) }
        assertFails { allocate(2, listOf("self", "self"), listOf(1, 1)) }
    }
}

class LedgerTest {
    private lateinit var s: Ledger
    private lateinit var alex: String

    @BeforeTest
    fun setup() {
        s = testLedger()
        alex = s.addPerson("Alex", "alex")
    }

    @AfterTest
    fun teardown() {
        s.db.close()
    }

    private fun expense(amount: Long = 101, day: String = "2026-01-01") =
        s.manual(
            obj(
                "description" to "Cafe",
                "amountCents" to amount,
                "date" to day,
                "category" to "Food & Drink",
                "note" to "",
            )
        )

    private fun ready(key: String) {
        s.quick(s.references(listOf(key)), SplitSpec("equal", listOf("self", alex)))
    }

    private fun finalize(key: String) {
        ready(key)
        s.review(s.references(listOf(key)), "approve")
    }

    private fun job(): String {
        val key = id()
        s.insert(
            "jobs",
            obj(
                "id" to key,
                "kind" to "chat",
                "payload" to "{}",
                "status" to "running",
                "createdAt" to now(),
                "updatedAt" to now(),
            ),
        )
        return key
    }

    @Test
    fun onlyFinalizedAffectBalancesAndUndoPersistsVersions() {
        val key = expense()
        ready(key)
        assertEquals(0, s.dashboard().single().outstandingCents)
        s.review(s.references(listOf(key)), "approve")
        assertEquals(51, s.dashboard().single().outstandingCents)
        val v = s.tx(key).n("version")
        s.undo()
        assertEquals("ready", s.tx(key).s("state"))
        assertTrue(s.tx(key).n("version") > v)
        assertEquals(0, s.dashboard().single().outstandingCents)
    }

    @Test
    fun staleBulkReviewIsAtomic() {
        val a = expense()
        val b = expense()
        ready(a)
        ready(b)
        val refs = s.references(listOf(a, b))
        s.review(listOf(refs[1]), "reject")
        assertFails { s.review(refs, "approve") }
        assertEquals("ready", s.tx(a).s("state"))
        assertEquals(0, s.dashboard().single().outstandingCents)
    }

    @Test
    fun confirmationAndFinalizationAreSeparateAndIdempotent() {
        val key = expense()
        val job = job()
        val plan = AssistantPlan()
        plan.updates.add(
            obj(
                "id" to key,
                "version" to 1,
                "state" to "ready",
                "proposal" to proposal(101, SplitSpec("equal", listOf("self", alex))),
            )
        )
        s.commitPlan(job, plan, "", setOf(key), job)
        assertEquals("inbox", s.tx(key).s("state"))
        val card = s.one("SELECT * FROM assistant_requests")!!.s("id")
        s.applyRequest(card)
        s.applyRequest(card)
        assertEquals(0, s.dashboard().single().outstandingCents)
        s.finalizeRequest(card)
        s.finalizeRequest(card)
        assertEquals(51, s.dashboard().single().outstandingCents)
        s.undo()
        assertFails { s.finalizeRequest(card) }
    }

    @Test
    fun finalizedAndOutOfScopeProposalsCannotApply() {
        val key = expense()
        finalize(key)
        val job = job()
        val plan = AssistantPlan()
        plan.updates.add(
            obj(
                "id" to key,
                "version" to s.tx(key).n("version"),
                "state" to "inbox",
                "proposal" to null,
            )
        )
        assertFails { s.commitPlan(job, plan, "", setOf(key), job) }
        assertEquals("finalized", s.tx(key).s("state"))
    }

    @Test
    fun cancelledJobCannotSaveOrganization() {
        val j = job()
        s.db.execute("UPDATE jobs SET cancelRequested=1 WHERE id=?", j)
        val p = AssistantPlan()
        p.organization.add(
            obj(
                "kind" to "context",
                "action" to "save",
                "title" to "Fact",
                "text" to "Alex is a friend",
                "quote" to "Alex is a friend",
            )
        )
        assertFails { s.commitPlan(j, p, "Alex is a friend", null, j) }
        assertEquals(0, s.all("SELECT * FROM user_context").size)
    }

    @Test
    fun invalidLaterActionRollsBackEarlierOrganization() {
        val j = job()
        val p = AssistantPlan()
        p.organization.add(
            obj(
                "kind" to "context",
                "action" to "save",
                "title" to "Fact",
                "text" to "Alex is a friend",
                "quote" to "Alex is a friend",
            )
        )
        p.organization.add(obj("kind" to "unsupported"))
        assertFails { s.commitPlan(j, p, "Alex is a friend", null, j) }
        assertEquals(0, s.all("SELECT * FROM user_context").size)
    }

    @Test
    fun factsRequireTrustedQuotes() {
        val j = job()
        val p = AssistantPlan()
        p.organization.add(
            obj(
                "kind" to "context",
                "action" to "save",
                "title" to "Fact",
                "text" to "secret",
                "quote" to "merchant text",
            )
        )
        assertFails { s.commitPlan(j, p, "User instruction", null, j) }
        assertEquals(0, s.all("SELECT * FROM user_context").size)
    }

    @Test
    fun scopedChatRetainsUserWordsWithoutChangingAllocationsAndCanUndo() {
        val key = expense()
        ready(key)
        val before = s.tx(key)
        s.saveChatContext(listOf(key), "This lunch was with @alex.")
        val after = s.tx(key)
        assertEquals(before.doc("proposal"), after.doc("proposal"))
        assertEquals("ready", after.s("state"))
        assertEquals(before.n("version") + 1, after.n("version"))
        assertEquals("This lunch was with @alex.", after.docs("notes").single().s("text"))
        s.undo()
        assertTrue(s.tx(key).docs("notes").isEmpty())
        finalize(key)
        assertFails { s.saveChatContext(listOf(key), "Another note") }
    }

    @Test
    fun stagedNewPersonCanBeUsedInSamePlanWithoutLeakingValidationWrites() {
        val key = expense()
        val j = job()
        val person = id()
        val plan = AssistantPlan()
        plan.organization +=
            obj("kind" to "person", "id" to person, "name" to "Sam", "handle" to "sam")
        plan.updates +=
            obj(
                "id" to key,
                "version" to 1,
                "state" to "ready",
                "proposal" to proposal(101, SplitSpec("equal", listOf("self", person))),
            )
        assertFails {
            s.db.transaction {
                s.commitPlan(j, plan, "Split with @sam", setOf(key), "simulation")
                error("rollback simulation")
            }
        }
        assertTrue(s.people().none { it.s("id") == person })
        assertTrue(s.all("SELECT * FROM assistant_requests").isEmpty())
        s.commitPlan(j, plan, "Split with @sam", setOf(key), j)
        assertTrue(s.people().any { it.s("id") == person })
        s.applyRequest(s.one("SELECT id FROM assistant_requests")!!.s("id"))
        assertEquals(
            setOf("self", person),
            s.tx(key).doc("proposal").shares().map { it.personId }.toSet(),
        )
    }

    @Test
    fun integerCentsRejectFractionalAndOverflowAmounts() {
        assertFails { obj("amount" to 1.5).n("amount") }
        assertFails { split(Long.MIN_VALUE, SplitSpec()) }
        val key = expense()
        val bundle = json(s.exportTransfer("transactions")).asJsonObject
        bundle.a("transactions").first().asJsonObject.apply {
            addProperty("kind", "refund")
            addProperty("amountCents", Long.MIN_VALUE)
        }
        assertFails { s.previewTransfer(gson.toJson(bundle)) }
        assertEquals(101L, s.tx(key).n("amountCents"))
    }

    @Test
    fun repaymentsUseOldestExpensesAndBoundReturnedCredit() {
        val a = expense(100, "2026-01-01")
        val b = expense(100, "2026-02-01")
        finalize(a)
        finalize(b)
        s.repayment(
            obj(
                "personId" to alex,
                "date" to "2026-03-01",
                "amountCents" to 75,
                "direction" to "received",
            )
        )
        assertEquals(listOf(0L, 25L), s.dashboard().single().expenses.map { it.remainingCents })
        assertFails {
            s.repayment(
                obj(
                    "personId" to alex,
                    "date" to "2026-03-01",
                    "amountCents" to 1,
                    "direction" to "returned",
                )
            )
        }
    }

    @Test
    fun manualAndRepaymentRetriesDoNotDuplicateAfterUndo() {
        val input = obj("description" to "Cash", "amountCents" to 100, "date" to "2026-01-01")
        val a = s.manual(input, "request")
        s.undo()
        assertEquals(a, s.manual(input, "request"))
        assertTrue(s.transactions().isEmpty())
    }

    @Test
    fun duplicateOccurrencesAndPaymentsArePreserved() {
        val text =
            "Date,Description,Amount\n01/01/2026,Cafe,1.00\n01/01/2026,Cafe,1.00\n01/02/2026,AUTOPAY PAYMENT,-2.00\n"
        val p = s.previewStatement("amex", "first", text)
        assertEquals(0, p.duplicates.size)
        assertEquals(2, s.confirmStatement(p, false, false).size)
        val q = s.previewStatement("amex", "second", text)
        assertEquals(3, q.duplicates.size)
        assertFails { s.confirmStatement(q, false, false) }
        assertEquals(0, s.confirmStatement(q, true, false).size)
        assertEquals(2, s.transactions().size)
        assertEquals(1, s.all("SELECT * FROM import_rows WHERE status='payment'").size)
    }

    @Test
    fun statementPreviewInvalidatesAndInvalidRowsNeedAcknowledgement() {
        val p =
            s.previewStatement(
                "amex",
                "first",
                "Date,Description,Amount\n02/30/2026,Invalid,2.00\n01/01/2026,Good,1.00\n",
            )
        assertFails { s.confirmStatement(p, false, false) }
        assertEquals(1, s.confirmStatement(p, false, true).size)
        assertFails { s.confirmStatement(p, true, true) }
    }

    @Test
    fun importContextIsScopedRetrySafeAndUndoable() {
        val p =
            s.previewStatement(
                "amex",
                "first",
                "Date,Description,Amount\n01/01/2026,Cafe,1.00\n02/01/2026,Cafe,1.00\n",
            )
        val refs = s.confirmStatement(p, false, false)
        s.finishImport(p.id, refs, "Trip with @alex", false, "2026-01-01", "2026-01-31")
        assertEquals(1, s.transactions().count { it.s("instruction").isNotBlank() })
        s.finishImport(p.id, refs, "Trip with @alex", false, "2026-01-01", "2026-01-31")
        s.undo()
        assertTrue(s.transactions().all { it.s("instruction").isBlank() })
        assertEquals(2, s.transactions().size)
    }

    @Test
    fun tripEditsInvalidateUnfinishedButPreserveFinalized() {
        val a = expense()
        val b = expense()
        val t =
            s.saveTrip(
                obj(
                    "name" to "Trip",
                    "from" to "2026-01-01",
                    "to" to "2026-01-03",
                    "split" to SplitSpec("equal", listOf("self", alex)).toJson(),
                )
            )
        s.assign(s.references(listOf(a, b)), t)
        ready(a)
        finalize(b)
        val trip = s.row("trips", t)
        trip.addProperty("name", "New name")
        s.saveTrip(trip.apply { add("split", doc("split")) })
        assertEquals("inbox", s.tx(a).s("state"))
        assertEquals("finalized", s.tx(b).s("state"))
        assertFails { s.archiveTrip(t, s.row("trips", t).n("version"), true) }
    }

    @Test
    fun tripChangeInvalidatesConfirmationBeforeAnyAssignment() {
        val a = expense()
        val t =
            s.saveTrip(
                obj(
                    "name" to "Trip",
                    "from" to "2026-01-01",
                    "to" to "2026-01-02",
                    "split" to SplitSpec().toJson(),
                )
            )
        val card =
            s.queueRequest(
                job(),
                "assignment",
                obj("items" to s.references(listOf(a)), "tripId" to t),
                "Assign",
            )
        s.archiveTrip(t, 1, true)
        assertFails { s.applyRequest(card) }
        assertEquals("", s.tx(a).s("tripId"))
    }

    @Test
    fun receiptsValidateContentAndDeletionIsUndoable() {
        val a = expense()
        val file =
            s.attachment(a, "receipt.pdf", "application/pdf", "%PDF-1.7 synthetic".toByteArray())
        assertFails { s.attachment(a, "wrong.png", "image/png", "%PDF-1.7".toByteArray()) }
        s.removeOrganization("attachments", file, 0)
        s.undo()
        assertEquals(1, s.all("SELECT id FROM attachments").size)
    }

    @Test
    fun rulesRespectScopeAndRejectStaleFinalization() {
        val a = expense()
        val r =
            s.saveRule(
                obj(
                    "title" to "Cafe",
                    "definition" to
                        obj(
                            "merchant" to "Cafe",
                            "split" to SplitSpec("equal", listOf("self", alex)).toJson(),
                            "outputCategory" to "Food",
                        ),
                )
            )
        val p = s.ruleProposal(s.tx(a))!!
        s.saveProposals(listOf(obj("id" to a, "version" to 1, "state" to "ready", "proposal" to p)))
        val rule = s.row("rules", r)
        rule.add("definition", rule.doc("definition"))
        rule.addProperty("title", "Updated")
        s.saveRule(rule)
        assertFails { s.review(s.references(listOf(a)), "approve") }
    }

    @Test
    fun jsonRoundTripMapsHandlesAndRequiresReapproval() {
        val a = expense()
        finalize(a)
        val exported = s.exportTransfer("transactions")
        testLedger().db.use { db ->
            val target = Ledger(db)
            val person = target.addPerson("Different name", "alex", "Keep relation")
            val p = target.previewTransfer(exported)
            target.confirmTransfer(p, true, true)
            assertEquals("Different name", target.row("people", person).s("name"))
            assertEquals("ready", target.transactions().single().s("state"))
            assertEquals(0, target.dashboard().single().outstandingCents)
            target.review(target.references(target.transactions().map { it.s("id") }), "approve")
            assertEquals(51, target.dashboard().single().outstandingCents)
        }
    }

    @Test
    fun jsonPreviewIsStaleAfterWorkspaceMutation() {
        val a = expense()
        val p = s.previewTransfer(s.exportTransfer("transactions"))
        expense()
        assertFails { s.confirmTransfer(p, true, true) }
        assertEquals(2, s.transactions().size)
    }

    @Test
    fun settlementIncludesLaterRepayments() {
        val a = expense(100)
        finalize(a)
        s.repayment(
            obj(
                "personId" to alex,
                "date" to "2026-03-01",
                "amountCents" to 25,
                "direction" to "received",
            )
        )
        assertTrue(s.settlement(alex, "2026-01-01", "2026-01-31").contains("$0.25"))
    }
}
