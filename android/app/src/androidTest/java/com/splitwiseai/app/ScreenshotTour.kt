package com.splitwiseai.app

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonObject
import com.splitwiseai.ledger.*
import java.io.File
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Opt-in visual tour. Uses a separate application context and synthetic ledger only. */
class ScreenshotTour {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var vm: AppViewModel
    private lateinit var output: File
    private val manifest = mutableListOf<JsonObject>()
    private var generation by mutableIntStateOf(0)
    private var transform by mutableStateOf<(WorkspaceState) -> WorkspaceState>({ it })
    private var overlay by mutableStateOf<(@Composable (WorkspaceState) -> Unit)?>(null)
    private lateinit var alex: String
    private lateinit var maya: String
    private lateinit var trip: String
    private lateinit var lunch: String
    private lateinit var refund: String
    private lateinit var purchase: String
    private lateinit var csv: String
    private lateinit var statement: StatementPreview
    private lateinit var transfer: TransferPreview
    private lateinit var imported: Pair<String, List<Reference>>
    private lateinit var rule: JsonObject
    private lateinit var context: JsonObject
    private lateinit var template: JsonObject
    private lateinit var alias: JsonObject

    private class GalleryApplication(base: Context) : Application() {
        private val suffix = "ui-tour-${id()}"
        private val privateRoot = File(base.cacheDir, suffix)
        private val exportRoot = File(base.cacheDir, "exports/$suffix")

        init {
            attachBaseContext(base)
        }

        override fun getApplicationContext(): Context = this

        override fun getNoBackupFilesDir() = File(privateRoot, "private").apply { mkdirs() }

        override fun getCacheDir() = exportRoot.apply { mkdirs() }

        override fun getSharedPreferences(name: String, mode: Int) =
            super.getSharedPreferences("$suffix-$name", mode)
    }

    private fun seed(s: Ledger) {
        alex = s.addPerson("Alex Chen", "alex", "Roommate")
        maya = s.addPerson("Maya Patel", "maya", "Friend")
        trip =
            s.saveTrip(
                obj(
                    "name" to "Yosemite weekend",
                    "destination" to "Yosemite National Park",
                    "from" to "2026-10-09",
                    "to" to "2026-10-12",
                    "split" to SplitSpec("equal", listOf("self", alex, maya)).toJson(),
                    "context" to
                        "Cabin and groceries shared equally with @alex and @maya. My hiking gear is personal.",
                )
            )
        csv =
            """
            Transaction Date,Post Date,Description,Category,Type,Amount,Memo
            10/09/2026,10/10/2026,YOSEMITE VALLEY LODGE,Travel,Sale,-487.20,
            10/10/2026,10/11/2026,MOUNTAIN CAFE,Food & Drink,Sale,-46.80,
            10/10/2026,10/11/2026,TRAIL MARKET,Groceries,Sale,-84.55,
            10/11/2026,10/12/2026,SHELL FUEL,Gas,Sale,-63.40,
            10/11/2026,10/12/2026,UBER TRIP,Travel,Sale,-24.60,
            10/12/2026,10/13/2026,MOUNTAIN CAFE,Food & Drink,Sale,-28.50,
            10/13/2026,10/14/2026,WHOLE FOODS MARKET,Groceries,Sale,-96.42,
            10/14/2026,10/15/2026,REI OUTDOOR GEAR,Shopping,Sale,-79.95,
            10/15/2026,10/15/2026,BLUE BOTTLE COFFEE,Food & Drink,Sale,-12.40,
            10/15/2026,10/15/2026,UBER TRIP,Travel,Sale,-18.75,
            10/15/2026,10/15/2026,REI OUTDOOR GEAR,Shopping,Return,19.99,
            10/15/2026,10/15/2026,AUTOMATIC PAYMENT,,Payment,300.00,
            """
                .trimIndent()
        val preview = s.previewStatement("sapphire", "Chase Sapphire · October.csv", csv)
        val refs = s.confirmStatement(preview, true, true)
        s.finishImport(
            preview.id,
            refs,
            "October expenses. Yosemite charges from October 9–12 were shared with @alex and @maya.",
            false,
        )
        fun named(name: String) = s.transactions().first { it.s("description") == name }.s("id")
        val lodge = named("YOSEMITE VALLEY LODGE")
        lunch = named("MOUNTAIN CAFE")
        purchase = named("REI OUTDOOR GEAR")
        refund = s.transactions().first { it.n("amountCents") < 0 }.s("id")
        val groceries = named("TRAIL MARKET")
        val fuel = named("SHELL FUEL")
        s.assign(s.references(listOf(lodge, lunch, groceries, fuel)), trip)
        listOf(lodge, groceries, fuel).forEach { key ->
            s.quick(
                s.references(listOf(key)),
                SplitSpec("equal", listOf("self", alex, maya)),
                if (key == groceries) "Groceries" else "Travel",
            )
            s.review(s.references(listOf(key)), "approve")
        }
        s.quick(s.references(listOf(purchase)), SplitSpec(), "Shopping")
        s.review(s.references(listOf(purchase)), "approve")
        s.quick(
            s.references(listOf(lunch)),
            SplitSpec("equal", listOf("self", alex, maya)),
            "Food & Drink",
        )
        s.saveChatContext(
            listOf(lunch),
            "This was lunch with @alex and @maya during our Yosemite trip.",
        )
        s.repayment(
            obj(
                "personId" to alex,
                "date" to "2026-10-14",
                "amountCents" to 7500,
                "direction" to "received",
                "note" to "Thanks for organizing Yosemite!",
            )
        )
        s.repayment(
            obj(
                "personId" to maya,
                "date" to "2026-10-14",
                "amountCents" to 25000,
                "direction" to "received",
                "note" to "Trip expenses and next week's groceries",
            )
        )
        s.attachment(
            lunch,
            "Mountain Cafe receipt.pdf",
            "application/pdf",
            "%PDF-1.7 Sample receipt for UI review".toByteArray(),
        )
        val ruleId =
            s.saveRule(
                obj(
                    "title" to "Household groceries",
                    "definition" to
                        obj(
                            "merchant" to "WHOLE FOODS",
                            "split" to SplitSpec("equal", listOf("self", alex)).toJson(),
                            "outputCategory" to "Groceries",
                        ),
                )
            )
        s.saveRule(
            obj(
                "title" to "Shared grocery run",
                "definition" to
                    obj(
                        "merchant" to "TRADER JOE",
                        "split" to SplitSpec("equal", listOf("self", alex)).toJson(),
                        "outputCategory" to "Groceries",
                    ),
            )
        )
        rule = s.row("rules", ruleId)
        val fact =
            s.saveOrganization(
                "user_context",
                obj(
                    "title" to "Household sharing",
                    "text" to "Alex is my roommate. We share household groceries equally.",
                    "quote" to "@alex is my roommate; we split household groceries equally.",
                    "personId" to alex,
                ),
            )
        context = s.row("user_context", fact)
        val templateId =
            s.saveOrganization(
                "split_templates",
                obj(
                    "name" to "Weekend crew",
                    "spec" to SplitSpec("equal", listOf("self", alex, maya)).toJson(),
                    "category" to "Food & Drink",
                ),
            )
        template = s.row("split_templates", templateId)
        val aliasId =
            s.saveOrganization(
                "merchant_aliases",
                obj("pattern" to "MOUNTAIN CAFE", "name" to "Mountain Café"),
            )
        alias = s.row("merchant_aliases", aliasId)
        val oldTrip =
            s.saveTrip(
                obj(
                    "name" to "Lake Tahoe",
                    "destination" to "Lake Tahoe",
                    "from" to "2026-08-14",
                    "to" to "2026-08-16",
                    "split" to SplitSpec("equal", listOf("self", alex)).toJson(),
                )
            )
        s.archiveTrip(oldTrip, s.row("trips", oldTrip).n("version"), true)
        val j = id()
        s.insert(
            "jobs",
            obj(
                "id" to j,
                "kind" to "chat",
                "payload" to "{}",
                "status" to "running",
                "createdAt" to now(),
                "updatedAt" to now(),
            ),
        )
        val plan = AssistantPlan()
        plan.updates +=
            obj(
                "id" to lunch,
                "version" to s.tx(lunch).n("version"),
                "state" to "ready",
                "proposal" to
                    proposal(
                        s.tx(lunch).n("amountCents"),
                        SplitSpec("equal", listOf("self", alex, maya)),
                        "Food & Drink",
                        "instruction",
                        "Lunch shared equally among the three Yosemite travelers.",
                    ),
            )
        s.commitPlan(j, plan, "Split Yosemite lunch equally with @alex and @maya.", setOf(lunch), j)
        s.insert(
            "messages",
            obj(
                "id" to id(),
                "role" to "user",
                "text" to "Split Yosemite lunch equally with @alex and @maya.",
                "jobId" to j,
                "createdAt" to now(),
            ),
        )
        s.insert(
            "messages",
            obj(
                "id" to id(),
                "role" to "assistant",
                "text" to
                    "I've prepared the lunch split: **$15.60 each** for you, Alex and Maya. Confirm the change below, then finalize when you're ready.",
                "jobId" to j,
                "createdAt" to now(),
            ),
        )
        s.db.execute("UPDATE jobs SET status='completed' WHERE id=?", j)
        val failed = id()
        s.insert(
            "jobs",
            obj(
                "id" to failed,
                "kind" to "process",
                "status" to "failed",
                "payload" to "{}",
                "error" to
                    "Processing was interrupted. Your saved work is safe; resume when ready.",
                "createdAt" to now(),
                "updatedAt" to now(),
            ),
        )
        statement =
            s.previewStatement(
                "sapphire",
                "New statement.csv",
                csv + "\n10/32/2026,10/15/2026,UNKNOWN MERCHANT,Shopping,Sale,-9.99,\n",
            )
        transfer = s.previewTransfer(s.exportTransfer("transactions"))
        imported = preview.id to s.references(refs.map { it.id })
    }

    private fun state() = vm.state.value

    private fun settle() {
        compose.waitForIdle()
        compose.runOnIdle {
            (compose.activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .hideSoftInputFromWindow(compose.activity.window.decorView.windowToken, 0)
        }
        Thread.sleep(220)
    }

    private fun click(text: String, substring: Boolean = false) {
        val matcher =
            hasText(text, substring = substring) or
                hasContentDescription(text, substring = substring)
        if (
            text == "Suggest expenses" &&
                compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isEmpty()
        ) {
            compose.onAllNodesWithContentDescription("Trip options").onFirst().performClick()
            settle()
        }
        compose.onAllNodes(matcher, useUnmergedTree = true).onFirst().performClick()
        settle()
    }

    private fun scroll(text: String, substring: Boolean = false) {
        val matcher =
            hasText(text, substring = substring) or
                hasContentDescription(text, substring = substring)
        if (compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            compose.onAllNodes(hasScrollToNodeAction()).onFirst().performScrollToNode(matcher)
        }
        compose.onAllNodes(matcher, useUnmergedTree = true).onFirst().performScrollTo()
        settle()
    }

    private fun reset() {
        compose.runOnIdle {
            overlay = null
            transform = { it }
            generation++
        }
        settle()
    }

    private fun page(name: String) {
        reset()
        when (name) {
            "Assistant" -> Unit
            "Review",
            "People",
            "Trips",
            "More" -> click(name)
            else -> {
                click("More")
                scroll(name)
                click(name)
            }
        }
    }

    private fun shot(slug: String, title: String, section: String, caption: String = "") {
        settle()
        val filename = "${(manifest.size + 1).toString().padStart(2, '0')}-$slug.png"
        val screenshot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(output, filename).outputStream().use {
            screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        screenshot.recycle()
        manifest +=
            obj("file" to filename, "title" to title, "section" to section, "caption" to caption)
        File(output, "manifest.json").writeText(gson.toJson(manifest))
    }

    private fun editor(kind: String, record: JsonObject?, title: String, section: String) {
        compose.runOnIdle {
            overlay = { s -> EditorDialog(Editor(kind, record), s, { overlay = null }) {} }
        }
        shot("$kind-form", title, section)
        compose.runOnIdle { overlay = null }
        settle()
    }

    private fun preview(title: String, slug: String, change: (WorkspaceState) -> WorkspaceState) {
        compose.runOnIdle { transform = change }
        shot(slug, title, "Import & backup")
        compose.runOnIdle { transform = { it } }
        settle()
    }

    private fun startWorkspace(): ViewModelStore {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val directory =
            InstrumentationRegistry.getArguments().getString("screenshotDir", "ui-review")
        require(directory.matches(Regex("[a-z0-9-]+")))
        output = File(base.getExternalFilesDir(null), directory).apply { mkdirs() }
        val app = GalleryApplication(base)
        val storage = WorkspaceStorage(app)
        seed(storage.ledger)
        storage.ledger.db.close()
        val owner = ViewModelStore()
        vm =
            ViewModelProvider(owner, ViewModelProvider.AndroidViewModelFactory(app))[
                AppViewModel::class.java]
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            compose.activity.enableEdgeToEdge()
        }
        compose.setContent {
            val raw by vm.state.collectAsStateWithLifecycle()
            val s = transform(raw)
            SideEffect {
                WindowCompat.getInsetsController(
                        compose.activity.window,
                        compose.activity.window.decorView,
                    )
                    .apply {
                        isAppearanceLightStatusBars = !s.dark
                        isAppearanceLightNavigationBars = !s.dark
                    }
            }
            AppTheme(s.dark) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Box {
                        key(generation) { Workspace(vm, s) }
                        overlay?.invoke(s)
                    }
                }
            }
        }
        compose.waitUntil(30000) { !state().loading }
        return owner
    }

    @Test
    fun captureMotionForFeedback() {
        assumeTrue(
            "Opt in with -e captureMotion true",
            InstrumentationRegistry.getArguments().getString("captureMotion") == "true",
        )
        val owner = startWorkspace()
        compose.runOnIdle {
            transform = {
                it.copy(
                    messages = emptyList(),
                    requests = emptyList(),
                    jobs = emptyList(),
                    events = emptyList(),
                )
            }
        }
        settle()
        compose.mainClock.autoAdvance = false
        // Advance the Compose clock one frame at a time so screenrecord captures actual motion.
        fun frames(milliseconds: Int = 500) {
            repeat((milliseconds + 15) / 16) {
                compose.mainClock.advanceTimeByFrame()
                Thread.sleep(16)
            }
        }
        fun demonstrate(label: String) {
            click(label)
            frames()
            Thread.sleep(650)
        }
        frames()
        Thread.sleep(900)
        demonstrate("Review")
        demonstrate("Filters")
        demonstrate("Filters")
        demonstrate("People")
        demonstrate("Details")
        demonstrate("Details")
        demonstrate("Trips")
        demonstrate("More")
        compose.onNodeWithContentDescription("Switch theme").performClick()
        frames(650)
        Thread.sleep(650)
        demonstrate("Review")
        demonstrate("Add expense")
        demonstrate("Cancel")
        demonstrate("People")
        compose.mainClock.autoAdvance = true
        owner.clear()
    }

    @Test
    fun captureScreensForFeedback() {
        assumeTrue(
            "Opt in with -e captureUi true",
            InstrumentationRegistry.getArguments().getString("captureUi") == "true",
        )
        val owner = startWorkspace()

        // Main pages use the app's actual navigation, rather than recreating screen layouts.
        compose.runOnIdle {
            transform = {
                it.copy(
                    messages = emptyList(),
                    requests = emptyList(),
                    jobs = emptyList(),
                    events = emptyList(),
                )
            }
        }
        shot(
            "assistant-welcome",
            "Assistant · first run",
            "Assistant",
            "Empty conversation before you add expenses or ask a question.",
        )
        reset()
        compose.runOnIdle { transform = { it.copy(jobs = emptyList()) } }
        shot(
            "assistant-confirmation",
            "Assistant · confirm a split",
            "Assistant",
            "Sample conversation and a real ledger confirmation card. Chat text is seeded demo content.",
        )
        click("Confirm changes")
        shot(
            "assistant-finalize",
            "Assistant · finalization is separate",
            "Assistant",
            "After confirmation, the card offers a separate finalization action.",
        )
        vm.clearNotice()
        reset()
        shot("assistant-interrupted", "Assistant · interrupted job", "Assistant")
        compose.runOnIdle {
            transform = {
                it.copy(
                    jobs = emptyList(),
                    activeJob = "demo-preview",
                    activity = "Generating on device · GPU",
                    liveText = "I’m checking the selected expenses and their saved context…",
                )
            }
        }
        shot(
            "assistant-processing",
            "Assistant · processing status",
            "Assistant",
            "Preview of the real processing UI with a sample status; no inference benchmark is represented.",
        )
        reset()
        compose.onNode(hasSetTextAction()).performTextInput("Split lunch with @")
        shot("assistant-mentions", "Assistant · @person suggestions", "Assistant")

        page("Review")
        shot("review-inbox", "Review · Inbox", "Review & splits")
        click("Filters")
        shot("review-filters", "Review · filters and date ranges", "Review & splits")
        scroll("Save this view")
        shot("review-saved-views", "Review · saved views and exports", "Review & splits")
        click("Save this view")
        shot("review-save-view", "Review · save a view", "Review & splits")
        click("Cancel")
        page("Review")
        click("Ready (", true)
        shot("review-ready", "Review · Ready splits", "Review & splits")
        compose.onAllNodes(isToggleable()).onFirst().performClick()
        scroll("Selected expenses")
        shot("review-bulk", "Review · bulk actions", "Review & splits")
        click("Split…")
        shot("split-personal", "Split editor · personal", "Review & splits")
        click("Split: Personal")
        click("Equal shares")
        compose.onNode(isToggleable() and hasAnySibling(hasText("Alex Chen @alex"))).performClick()
        compose.onNode(isToggleable() and hasAnySibling(hasText("Maya Patel @maya"))).performClick()
        shot("split-equal", "Split editor · equal shares", "Review & splits")
        click("Split: Equal shares")
        click("Exact amounts")
        repeat(3) { index ->
            compose
                .onAllNodes(hasSetTextAction() and hasText("USD"))[index]
                .performTextReplacement("15.60")
        }
        shot("split-exact", "Split editor · exact amounts", "Review & splits")
        click("Split: Exact amounts")
        click("Percentages")
        listOf("33.34", "33.33", "33.33").forEachIndexed { index, amount ->
            compose
                .onAllNodes(hasSetTextAction() and hasText("%"))[index]
                .performTextReplacement(amount)
        }
        shot("split-percent", "Split editor · percentages", "Review & splits")
        click("Cancel")
        click("Assign trip")
        shot("review-assign-trip", "Review · assign selected expenses to a trip", "Review & splits")
        click("Cancel")
        click("Give one instruction")
        shot("assistant-selected-scope", "Assistant · selected-expense scope", "Assistant")

        page("Review")
        compose.runOnIdle {
            overlay = { s ->
                ExpenseSheet(
                    vm,
                    s,
                    s.transactions.first { it.s("id") == lunch },
                    { overlay = null },
                    {},
                    {},
                )
            }
        }
        shot("expense-detail", "Expense · allocations and actions", "Expense details")
        scroll("Mountain Cafe receipt.pdf")
        shot("expense-receipts", "Expense · receipt attachments", "Expense details")
        scroll("Original source")
        compose.onAllNodes(hasScrollAction()).onLast().performTouchInput { swipeUp() }
        shot("expense-source", "Expense · original statement data", "Expense details")
        scroll("Action history")
        compose.onAllNodes(hasScrollAction()).onLast().performTouchInput { swipeUp() }
        shot("expense-history", "Expense · context and Undo history", "Expense details")
        reset()
        page("Review")
        compose.runOnIdle {
            overlay = { s ->
                ExpenseSheet(
                    vm,
                    s,
                    s.transactions.first { it.s("id") == refund },
                    { overlay = null },
                    {},
                    {},
                )
            }
        }
        shot("expense-refund", "Expense · refund", "Expense details")
        click("Link refund to finalized purchase")
        shot("expense-link-refund", "Expense · link a refund", "Expense details")
        reset()
        page("Review")
        editor(
            "expense",
            obj(
                "description" to "Lunch with Alex",
                "amount" to "32.50",
                "category" to "Food & Drink",
                "note" to "Split equally with @alex",
            ),
            "Expense · add a cash expense",
            "Expense details",
        )

        page("People")
        shot("people-balances", "People · balances and available credit", "People & repayments")
        click("Details")
        shot("people-ledger", "People · unpaid expenses and repayments", "People & repayments")
        editor(
            "person",
            obj("name" to "Jordan Lee", "handle" to "jordan", "relation" to "Friend"),
            "People · add a person",
            "People & repayments",
        )
        editor(
            "repayment",
            obj("personId" to alex, "amount" to "75.00", "note" to "Yosemite trip repayment"),
            "Repayment · money received",
            "People & repayments",
        )
        compose.runOnIdle {
            overlay = { s ->
                EditorDialog(
                    Editor("repayment", obj("personId" to maya, "amount" to "25.00")),
                    s,
                    { overlay = null },
                ) {}
            }
        }
        click("Direction: Received from person")
        click("Return available credit")
        shot("repayment-credit", "Repayment · return available credit", "People & repayments")

        page("Trips")
        shot("trips", "Trips · active and archived trips", "Trips")
        editor("trip", null, "Trips · create a trip", "Trips")
        editor(
            "trip",
            state().trips.first { it.s("id") == trip },
            "Trips · dates and default split",
            "Trips",
        )
        compose.runOnIdle {
            overlay = { s ->
                EditorDialog(
                    Editor("trip", s.trips.first { it.s("id") == trip }),
                    s,
                    { overlay = null },
                ) {}
            }
        }
        scroll("Trip context / exceptions (optional)")
        shot("trip-context", "Trips · shared context and exceptions", "Trips")
        compose.runOnIdle { overlay = null }
        click("Suggest expenses")
        shot("trip-suggestions", "Trips · suggested expenses", "Trips")
        click("Cancel")
        click("Review expenses")
        click("Ready (", true)
        shot("trip-review", "Trips · assigned-expense review", "Trips")

        page("Overview & reports")
        shot("overview", "Overview · spending and outstanding balances", "Reports & organization")
        scroll("Shopping")
        shot("reports-category", "Reports · spending by category", "Reports & organization")
        scroll("Monthly spending")
        shot("reports-monthly", "Reports · monthly spending", "Reports & organization")
        page("Finalized expenses")
        shot("finalized", "Finalized · immutable expenses", "Review & splits")

        page("Rules, context & templates")
        shot("rules", "Rules · reusable allocation rules", "Reports & organization")
        editor("rule", rule, "Rules · merchant and date scopes", "Reports & organization")
        compose.runOnIdle {
            overlay = { s -> EditorDialog(Editor("rule", rule), s, { overlay = null }) {} }
        }
        scroll("Expense category:", true)
        shot("rule-split", "Rules · split and output category", "Reports & organization")
        compose.runOnIdle { overlay = null }
        click("Optimize rules")
        shot("rule-optimization", "Rules · review cleanup suggestions", "Reports & organization")
        click("Cancel")
        click("Show: Rules")
        click("Saved context")
        shot("saved-context", "Context · user facts and source quotes", "Reports & organization")
        editor(
            "context",
            context,
            "Context · person, trip and date scopes",
            "Reports & organization",
        )
        click("Show: Saved context")
        click("Split templates")
        shot("templates", "Templates · saved split methods", "Reports & organization")
        editor("template", template, "Templates · edit a split method", "Reports & organization")
        click("Show: Split templates")
        click("Merchant names")
        shot(
            "merchant-aliases",
            "Merchant names · readable statement labels",
            "Reports & organization",
        )
        editor("alias", alias, "Merchant names · edit a label", "Reports & organization")

        page("Import history")
        shot("import-history", "Imports · statement history and saved context", "Import & backup")
        page("More")
        scroll("Import / export")
        click("Import / export")
        shot("import-export", "Import & export · file options", "Import & backup")
        click("Done")
        preview("CSV import · duplicates, payments and invalid rows", "csv-preview") {
            it.copy(statement = statement)
        }
        preview("Import · optional scoped context", "import-context") {
            it.copy(imported = imported)
        }
        preview("JSON import · participant matching and reapproval", "json-preview") {
            it.copy(transfer = transfer)
        }
        preview("Workspace restore · review before replacement", "workspace-restore") {
            it.copy(
                workspacePreview =
                    obj(
                        "people" to 3,
                        "transactions" to state().transactions.size,
                        "trips" to 2,
                        "receipts" to 1,
                        "outstandingCents" to state().balances.sumOf { b -> b.outstandingCents },
                    )
            )
        }

        page("Settings & on-device AI")
        shot(
            "settings-models",
            "Settings · on-device models and download controls",
            "Settings & themes",
        )
        scroll("Previous workspace recovery copy")
        shot("settings-backup", "Settings · workspace backup and recovery", "Settings & themes")
        scroll("Data and privacy")
        shot("settings-privacy", "Settings · cards, privacy and storage", "Settings & themes")
        editor(
            "account",
            obj("name" to "Travel card"),
            "Settings · add a card account",
            "Settings & themes",
        )
        editor("timezone", null, "Settings · workspace timezone", "Settings & themes")
        page("More")
        shot("more", "More · all workspace sections", "Settings & themes")
        vm.toggleTheme()
        page("Review")
        shot("review-light", "Light theme · Review", "Settings & themes")
        page("Assistant")
        compose.runOnIdle { transform = { it.copy(jobs = emptyList()) } }
        shot("assistant-light", "Light theme · Assistant", "Settings & themes")
        vm.toggleTheme()
        page("Trips")
        compose.onAllNodesWithContentDescription("Trip options").onFirst().performClick()
        shot("trip-actions", "Trips · actions menu", "Trips")
        page("Review")
        compose.runOnIdle {
            overlay = { s -> EditorDialog(Editor("expense"), s, { overlay = null }) {} }
        }
        settle()
        compose
            .onAllNodes(hasContentDescription("Choose Date", substring = true))
            .onFirst()
            .performClick()
        shot("date-picker", "Editors · calendar date picker", "Expense details")
        owner.clear()
    }
}
