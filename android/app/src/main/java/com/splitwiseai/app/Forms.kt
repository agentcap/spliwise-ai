package com.splitwiseai.app

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.splitwiseai.ledger.*
import java.time.LocalDate

@Composable
fun SplitFields(s: WorkspaceState, spec: SplitSpec, change: (SplitSpec) -> Unit) {
    Choice(
        "Split",
        spec.mode,
        listOf(
            "personal" to "Personal",
            "equal" to "Equal shares",
            "exact" to "Exact amounts",
            "percent" to "Percentages",
        ),
    ) { mode ->
        change(
            SplitSpec(
                mode,
                if (mode == "personal") listOf("self")
                else spec.participants.ifEmpty { listOf("self") },
                if (mode in setOf("exact", "percent"))
                    spec.participants.ifEmpty { listOf("self") }.map { 0L }
                else null,
            )
        )
    }
    if (spec.mode != "personal") {
        s.people.forEach { person ->
            val key = person.s("id")
            val index = spec.participants.indexOf(key)
            val rowColor by
                animateColorAsState(
                    if (index >= 0) MaterialTheme.colorScheme.primaryContainer.copy(alpha = .4f)
                    else MaterialTheme.colorScheme.surfaceContainerLow,
                    tween(180),
                    label = "participant selection",
                )
            Row(
                Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(rowColor)
                    .padding(end = 8.dp)
                    .animateContentSize(tween(220)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(
                    index >= 0,
                    { checked ->
                        val ids = if (checked) spec.participants + key else spec.participants - key
                        change(
                            spec.copy(
                                participants = ids,
                                values =
                                    if (spec.mode in setOf("exact", "percent"))
                                        ids.map { p ->
                                            val i = spec.participants.indexOf(p)
                                            if (i >= 0) spec.values?.getOrNull(i) ?: 0L else 0L
                                        }
                                    else null,
                            )
                        )
                    },
                )
                Text(
                    "${person.s("name")} @${person.s("handle")}",
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (index >= 0 && spec.mode in setOf("exact", "percent")) {
                    var field by
                        remember(key, spec.mode) {
                            mutableStateOf(
                                ((spec.values?.getOrNull(index) ?: 0L)
                                        .toBigDecimal()
                                        .movePointLeft(2))
                                    .toPlainString()
                            )
                        }
                    CleanTextField(
                        field,
                        { value ->
                            field = value
                            run {
                                val amount = runCatching {
                                    cents(value)
                                }
                                    .getOrDefault(Long.MIN_VALUE)
                                val values =
                                    spec.participants.indices.map { i ->
                                        if (i == index) amount else spec.values?.getOrNull(i) ?: 0L
                                    }
                                change(spec.copy(values = values))
                            }
                        },
                        Modifier.width(110.dp),
                        label = { Text(if (spec.mode == "percent") "%" else "USD") },
                        isError = runCatching { cents(field) }.isFailure,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                    )
                }
            }
        }
        if (spec.values?.any { it == Long.MIN_VALUE } == true)
            Text("Enter a valid amount for every person.", color = MaterialTheme.colorScheme.error)
        else if (spec.mode == "percent")
            Text(
                "Total: ${(spec.values?.sum() ?: 0L) / 100.0}%",
                style = MaterialTheme.typography.labelMedium,
            )
        else if (spec.mode == "exact")
            Text(
                "Total: ${money(spec.values?.sum() ?: 0L)}",
                style = MaterialTheme.typography.labelMedium,
            )
    }
}

@Composable
fun SplitDialog(
    s: WorkspaceState,
    transaction: JsonObject?,
    dismiss: () -> Unit,
    save: (SplitSpec, String) -> Unit,
) {
    var spec by remember {
        mutableStateOf(
            transaction?.doc("proposal")?.get("spec")?.let { SplitSpec.from(it.asJsonObject) }
                ?: SplitSpec()
        )
    }
    var category by remember {
        mutableStateOf(
            transaction?.doc("proposal")?.s("category")?.ifEmpty {
                transaction.s("bankCategory").ifEmpty { "Uncategorized" }
            } ?: "Uncategorized"
        )
    }
    var error by remember { mutableStateOf("") }
    SheetDialog(
        onDismissRequest = dismiss,
        title = {
            Text(
                if (transaction == null) "Split selected expenses"
                else "Edit split · ${money(transaction.n("amountCents"))}"
            )
        },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                SplitFields(s, spec) { spec = it }
                Choice("Category", category, s.categories.map { it.s("name") to it.s("name") }) {
                    category = it
                }
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    try {
                        if (transaction != null) split(transaction.n("amountCents"), spec)
                        require(spec.mode == "personal" || spec.participants.isNotEmpty())
                        save(spec, category)
                    } catch (e: Exception) {
                        error = e.message ?: "Invalid split."
                    }
                }
            ) {
                Text("Save for review")
            }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorDialog(
    editor: Editor,
    s: WorkspaceState,
    onDismiss: () -> Unit,
    save: (JsonObject) -> Unit,
) {
    val old = editor.record ?: JsonObject()
    val kind = editor.kind
    val fields =
        remember(editor) {
            mutableStateMapOf<String, String>().apply {
                old.entrySet()
                    .filter { it.value.isJsonPrimitive }
                    .forEach { put(it.key, it.value.asString) }
                if (kind == "rule")
                    old.doc("definition")
                        .entrySet()
                        .filter { it.value.isJsonPrimitive }
                        .forEach { put(it.key, it.value.asString) }
                if (kind in setOf("expense", "repayment")) {
                    put("date", today(s))
                    if (!containsKey("amount")) put("amount", "")
                }
                if (kind == "repayment") put("direction", "received")
                if (kind == "account") put("format", "chase")
                if (kind == "timezone")
                    put("timezone", s.settings.s("timezone", "America/Los_Angeles"))
            }
        }
    var spec by
        remember(editor) {
            mutableStateOf(
                when (kind) {
                    "trip" -> old.doc("split").takeIf { it.size() > 0 }?.let(SplitSpec::from)
                    "rule" ->
                        old.doc("definition")
                            .o("split")
                            .takeIf { it.size() > 0 }
                            ?.let(SplitSpec::from)
                    "template" -> old.doc("spec").takeIf { it.size() > 0 }?.let(SplitSpec::from)
                    else -> null
                } ?: SplitSpec()
            )
        }
    var error by remember { mutableStateOf("") }
    var pickingDate by remember { mutableStateOf<String?>(null) }
    @Composable
    fun Field(key: String, label: String, lines: Int = 1) {
        CleanTextField(
            fields[key] ?: "",
            { fields[key] = it },
            Modifier.fillMaxWidth(),
            label = { Text(label) },
            singleLine = lines == 1,
            minLines = lines,
            keyboardOptions =
                if (key == "amount") KeyboardOptions(keyboardType = KeyboardType.Decimal)
                else KeyboardOptions.Default,
            trailingIcon =
                if (key in setOf("date", "from", "to"))
                    ({
                        IconButton(onClick = { pickingDate = key }) {
                            Icon(Icons.Outlined.CalendarToday, "Choose $label")
                        }
                    })
                else null,
        )
    }
    @Composable
    fun Pick(key: String, label: String, choices: List<Pair<String, String>>) {
        Choice(label, fields[key] ?: choices.firstOrNull()?.first ?: "", choices) {
            fields[key] = it
        }
    }
    SheetDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                "${if (old.s("id").isEmpty()) "Add" else "Edit"} ${when(kind) { "alias" -> "merchant name"
 "context" -> "saved context"
 "account" -> "card account"
 else -> kind }}"
            )
        },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                when (kind) {
                    "person" -> {
                        Field("name", "Name")
                        Field("handle", "Unique @handle (without @)")
                        Field("relation", "Relationship (optional)")
                    }
                    "expense" -> {
                        Field("description", "Expense description")
                        Field("amount", "Amount in USD")
                        Field("date", "Date (YYYY-MM-DD)")
                        Pick(
                            "category",
                            "Category",
                            s.categories.map { it.s("name") to it.s("name") },
                        )
                        Pick(
                            "tripId",
                            "Trip",
                            listOf("" to "No trip") +
                                s.trips
                                    .filter { it.s("status") == "active" }
                                    .map { it.s("id") to it.s("name") },
                        )
                        Field("note", "Notes (optional)", 2)
                    }
                    "repayment" -> {
                        Pick(
                            "personId",
                            "Person",
                            s.people
                                .filter { it.n("isSelf") == 0L }
                                .map { it.s("id") to it.s("name") },
                        )
                        Pick(
                            "direction",
                            "Direction",
                            listOf(
                                "received" to "Received from person",
                                "returned" to "Return available credit",
                            ),
                        )
                        Field("amount", "Amount in USD")
                        Field("date", "Date (YYYY-MM-DD)")
                        Field("note", "Note (optional)")
                    }
                    "trip" -> {
                        Field("name", "Trip name")
                        Field("destination", "Destination (optional)")
                        Field("from", "Start date (YYYY-MM-DD)")
                        Field("to", "End date (YYYY-MM-DD)")
                        SplitFields(s, spec) { spec = it }
                        Field("context", "Trip context / exceptions (optional)", 2)
                    }
                    "rule" -> {
                        Field("title", "Rule name")
                        Field("merchant", "Merchant contains (blank for any)")
                        Field(
                            "merchantAlternatives",
                            "Other merchant names, separated by | (optional)",
                        )
                        Pick(
                            "accountId",
                            "Card scope",
                            listOf("" to "All cards") +
                                s.accounts.map { it.s("id") to it.s("name") },
                        )
                        Field("category", "Statement category scope (optional)")
                        Field("from", "From date (optional)")
                        Field("to", "To date (optional)")
                        SplitFields(s, spec) { spec = it }
                        Pick(
                            "outputCategory",
                            "Expense category",
                            s.categories.map { it.s("name") to it.s("name") },
                        )
                    }
                    "template" -> {
                        Field("name", "Template name")
                        SplitFields(s, spec) { spec = it }
                        Pick(
                            "category",
                            "Category",
                            s.categories.map { it.s("name") to it.s("name") },
                        )
                    }
                    "alias" -> {
                        Field("pattern", "Statement merchant contains")
                        Field("name", "Display name")
                    }
                    "context" -> {
                        Field("title", "Title")
                        Field("text", "Fact or context", 3)
                        Pick(
                            "personId",
                            "Person scope",
                            listOf("" to "Workspace") + s.people.map { it.s("id") to it.s("name") },
                        )
                        Pick(
                            "tripId",
                            "Trip scope",
                            listOf("" to "Any trip") + s.trips.map { it.s("id") to it.s("name") },
                        )
                        Field("from", "From date (optional)")
                        Field("to", "To date (optional)")
                    }
                    "account" -> {
                        Field("name", "Card account name")
                        Pick(
                            "format",
                            "CSV format",
                            listOf("chase" to "Chase", "amex" to "American Express"),
                        )
                    }
                    "timezone" -> Field("timezone", "Workspace timezone (e.g. America/Los_Angeles)")
                }
                if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    try {
                        val input = JsonObject()
                        fields.forEach { (k, v) -> input.addProperty(k, v) }
                        if (old.s("id").isNotEmpty()) {
                            input.addProperty("id", old.s("id"))
                            input.addProperty("version", old.n("version"))
                        }
                        if (kind in setOf("expense", "repayment")) {
                            input.addProperty("amountCents", cents(fields["amount"] ?: ""))
                            date(input.s("date"))
                            require(input.n("amountCents") > 0)
                        }
                        if (kind == "person")
                            require(
                                input.s("name").isNotBlank() &&
                                    Regex("[a-z][a-z0-9_]{0,39}").matches(input.s("handle"))
                            ) {
                                "Enter a name and lowercase @handle."
                            }
                        if (kind == "trip") {
                            date(input.s("from"))
                            date(input.s("to"))
                            require(input.s("from") <= input.s("to"))
                            input.add("split", spec.toJson())
                        }
                        if (kind == "template") input.add("spec", spec.toJson())
                        if (kind == "rule") {
                            val d =
                                obj(
                                    "merchant" to input.s("merchant"),
                                    "merchantAliases" to
                                        (fields["merchantAlternatives"]
                                            ?.split('|')
                                            ?.map { it.trim() }
                                            ?.filter { it.isNotEmpty() }
                                            ?: old.doc("definition").a("merchantAliases").map {
                                                it.asString
                                            }),
                                    "split" to spec.toJson(),
                                    "outputCategory" to
                                        input.s("outputCategory").ifEmpty {
                                            s.categories.firstOrNull()?.s("name") ?: "Uncategorized"
                                        },
                                )
                            listOf("accountId", "category", "from", "to").forEach {
                                if (input.s(it).isNotBlank()) d.addProperty(it, input.s(it))
                            }
                            input.add("definition", d)
                        }
                        if (kind in setOf("expense", "template") && input.s("category").isEmpty())
                            input.addProperty(
                                "category",
                                s.categories.firstOrNull()?.s("name") ?: "Uncategorized",
                            )
                        if (kind == "repayment" && input.s("personId").isEmpty())
                            input.addProperty(
                                "personId",
                                s.people.firstOrNull { it.n("isSelf") == 0L }?.s("id")
                                    ?: error("Add a person first."),
                            )
                        if (kind == "context") input.addProperty("quote", input.s("text"))
                        if (kind == "account") require(input.s("name").trim().length in 1..100)
                        save(input)
                    } catch (e: Exception) {
                        error =
                            when (e) {
                                is NumberFormatException ->
                                    "Enter a valid amount, for example 12.50."
                                is java.time.format.DateTimeParseException ->
                                    "Choose a valid date from the calendar."
                                else ->
                                    e.message?.takeUnless { it == "Failed requirement." }
                                        ?: "Check the required fields before saving."
                            }
                    }
                }
            ) {
                Text("Save")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
    pickingDate?.let { field ->
        val initial = runCatching {
            LocalDate.parse(fields[field]).toEpochDay() * 86_400_000L
        }
            .getOrNull()
        val picker = rememberDatePickerState(initialSelectedDateMillis = initial)
        DatePickerDialog(
            onDismissRequest = { pickingDate = null },
            confirmButton = {
                TextButton(
                    onClick = {
                        picker.selectedDateMillis?.let {
                            fields[field] = LocalDate.ofEpochDay(it / 86_400_000L).toString()
                        }
                        pickingDate = null
                    }
                ) {
                    Text("Use date")
                }
            },
            dismissButton = { TextButton(onClick = { pickingDate = null }) { Text("Cancel") } },
        ) {
            DatePicker(picker)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExpenseSheet(
    vm: AppViewModel,
    s: WorkspaceState,
    t: JsonObject,
    dismiss: () -> Unit,
    attach: () -> Unit,
    chat: () -> Unit,
) {
    var splitDialog by remember { mutableStateOf(false) }
    var instruction by remember(t.s("id")) { mutableStateOf("") }
    var files by remember { mutableStateOf(emptyList<JsonObject>()) }
    var source by remember { mutableStateOf<JsonObject?>(null) }
    var history by remember { mutableStateOf(emptyList<JsonObject>()) }
    var refund by remember { mutableStateOf(false) }
    var trip by remember { mutableStateOf(t.s("tripId")) }
    val ref = Reference(t.s("id"), t.n("version"))
    LaunchedEffect(t.s("id"), s.notice) {
        vm.attachments(t.s("id")) { files = it }
        vm.perform("") { store ->
            source =
                store
                    .one("SELECT raw,rowNumber FROM import_rows WHERE id=?", t.s("importRowId"))
                    ?.doc("raw")
            history =
                store.all(
                    "SELECT id,label,actor,createdAt,undoneAt FROM action_batches WHERE EXISTS(SELECT 1 FROM json_each(undo) WHERE json_extract(value,'$.id')=?) ORDER BY sequence DESC LIMIT 30",
                    t.s("id"),
                )
        }
    }
    ModalBottomSheet(
        onDismissRequest = dismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(t.s("description"), style = MaterialTheme.typography.headlineSmall)
            Text("${money(t.n("amountCents"))} · ${t.s("date")} · ${t.s("state")}")
            val p = t.doc("proposal")
            if (p.size() > 0) {
                p.shares().forEach { share ->
                    Text(
                        "${s.people.find { it.s("id") == share.personId }?.s("name")} · ${money(share.amountCents)}"
                    )
                }
                Text(p.s("explanation"), style = MaterialTheme.typography.bodySmall)
            }
            if (t.s("attention").isNotBlank())
                Text(t.s("attention"), color = MaterialTheme.colorScheme.secondary)
            if (t.s("state") == "finalized")
                Button(
                    onClick = {
                        vm.perform("Expense reopened") { it.review(listOf(ref), "reopen") }
                    }
                ) {
                    Text("Reopen for review")
                }
            else {
                FlowButtons(
                    listOf(
                        "Edit split" to { splitDialog = true },
                        "Personal" to
                            {
                                vm.perform("Personal split ready") {
                                    it.quick(listOf(ref), SplitSpec())
                                }
                            },
                        "Ask assistant" to chat,
                        "Generate split" to { vm.enqueue("", listOf(ref.id), true) },
                    ) +
                        if (t.s("state") == "ready")
                            listOf(
                                "Finalize split" to
                                    {
                                        vm.perform("Split finalized") {
                                            it.review(listOf(ref), "approve")
                                        }
                                    },
                                "Reject" to
                                    {
                                        vm.perform("Returned to Inbox") {
                                            it.review(listOf(ref), "reject")
                                        }
                                    },
                            )
                        else emptyList()
                )
                if (t.n("amountCents") < 0)
                    TextButton(onClick = { refund = true }) {
                        Text("Link refund to finalized purchase")
                    }
                if (s.templates.isNotEmpty())
                    Choice("Template", "", s.templates.map { it.s("id") to it.s("name") }) { key ->
                        val template = s.templates.first { it.s("id") == key }
                        vm.perform("Template applied") {
                            it.quick(
                                listOf(ref),
                                SplitSpec.from(template.doc("spec")),
                                template.s("category"),
                            )
                        }
                    }
                val last =
                    s.transactions
                        .filter { it.s("state") == "finalized" && it.doc("proposal").has("spec") }
                        .maxByOrNull { it.s("updatedAt") }
                if (last != null)
                    TextButton(
                        onClick = {
                            vm.perform("Last split applied") {
                                it.quick(
                                    listOf(ref),
                                    SplitSpec.from(last.doc("proposal").o("spec")),
                                    last.doc("proposal").s("category"),
                                )
                            }
                        }
                    ) {
                        Text("Use last split")
                    }
                if (t.s("tripId").isNotEmpty())
                    TextButton(
                        onClick = {
                            vm.perform("Trip default ready") { store ->
                                store.saveProposals(
                                    listOf(
                                        obj(
                                            "id" to ref.id,
                                            "version" to ref.version,
                                            "state" to "ready",
                                            "proposal" to store.tripProposal(t),
                                        )
                                    )
                                )
                            }
                        }
                    ) {
                        Text("Use trip default")
                    }
                CleanTextField(
                    instruction,
                    { instruction = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("Instruction and context") },
                    minLines = 2,
                )
                Button(
                    onClick = {
                        val text = instruction
                        vm.perform("Instruction saved") {
                            it.review(listOf(ref), "correct", text)
                            vm.enqueue(text, listOf(ref.id))
                        }
                        instruction = ""
                    },
                    enabled = instruction.isNotBlank(),
                ) {
                    Text("Save instruction & process")
                }
            }
            Choice(
                "Assign trip",
                trip,
                listOf("" to "No trip") +
                    s.trips
                        .filter { it.s("status") == "active" }
                        .map { it.s("id") to it.s("name") },
            ) {
                trip = it
                val key = it
                vm.perform("Trip assigned") { it.assign(listOf(ref), key.ifEmpty { null }) }
            }
            HorizontalDivider()
            Text("Saved context", style = MaterialTheme.typography.titleMedium)
            if (t.s("instruction").isNotBlank()) Text("Current instruction: ${t.s("instruction")}")
            t.docs("notes").forEach {
                Text(
                    "${it.s("text")}\n${it.s("source")} · ${it.s("createdAt")}",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            HorizontalDivider()
            Text("Receipts (${files.size}/10)", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = attach, enabled = files.size < 10) {
                Text("Attach PNG, JPEG or PDF · up to 5 MB")
            }
            files.forEach { file ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { vm.shareReceipt(file.s("id")) }, Modifier.weight(1f)) {
                        Text(file.s("name"))
                    }
                    TextButton(
                        onClick = {
                            vm.perform("Receipt removed · Undo available") {
                                it.removeOrganization("attachments", file.s("id"), 0)
                            }
                        }
                    ) {
                        Text("Remove")
                    }
                }
            }
            HorizontalDivider()
            Text("Original source", style = MaterialTheme.typography.titleMedium)
            Text(
                "${t.s("source", "import")} · Posted ${t.s("postDate")}",
                style = MaterialTheme.typography.bodySmall,
            )
            source?.entrySet()?.forEach {
                Text("${it.key}: ${it.value.asString}", style = MaterialTheme.typography.bodySmall)
            }
            Text("Action history", style = MaterialTheme.typography.titleMedium)
            history.forEach {
                Text(
                    "${it.s("label")} · ${it.s("actor")}\n${it.s("createdAt")}${if (it.s("undoneAt").isNotEmpty()) " · Undone" else ""}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
    if (splitDialog)
        SplitDialog(s, t, { splitDialog = false }) { spec, category ->
            vm.perform("Split saved for review") { it.quick(listOf(ref), spec, category) }
            splitDialog = false
        }
    if (refund)
        AlertDialog(
            onDismissRequest = { refund = false },
            title = { Text("Choose original purchase") },
            text = {
                LazyColumn(Modifier.heightIn(max = 400.dp)) {
                    items(
                        s.transactions.filter {
                            it.s("state") == "finalized" && it.n("amountCents") > 0
                        }
                    ) { original ->
                        TextButton(
                            onClick = {
                                vm.perform("Refund split ready") { store ->
                                    store.saveProposals(
                                        listOf(
                                            obj(
                                                "id" to ref.id,
                                                "version" to ref.version,
                                                "state" to "ready",
                                                "proposal" to
                                                    store.linkedRefund(ref.id, original.s("id")),
                                            )
                                        )
                                    )
                                }
                                refund = false
                            }
                        ) {
                            Text(
                                "${original.s("date")} · ${original.s("description")} · ${money(original.n("amountCents"))}"
                            )
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { refund = false }) { Text("Cancel") } },
        )
}

@Composable
fun SettingsScreen(
    vm: AppViewModel,
    s: WorkspaceState,
    restore: () -> Unit,
    edit: (String) -> Unit,
) {
    val progress by vm.models.progress.collectAsState()
    var cellular by remember { mutableStateOf(false) }
    var importingModel by remember { mutableStateOf<ModelFile?>(null) }
    val importModel = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val model = importingModel
        if (uri != null && model != null) vm.importModel(model, uri)
        importingModel = null
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Panel(
                "Private, on-device AI",
                "Choose a model once. Your chat and expense processing then stay on this phone.",
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    IconTile(Icons.Outlined.Wifi)
                    Column(Modifier.weight(1f)) {
                        Text(
                            "Allow downloads over mobile data",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            "Wi-Fi is used by default.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(cellular, { cellular = it })
                }
            }
        }
        items(vm.models.models.sortedByDescending { it.id == "e4b" }, key = { it.id }) { model ->
            val ready = vm.models.ready(model)
            val downloading = progress.running && progress.id == model.id
            Card(
                Modifier.fillMaxWidth().animateItem().animateContentSize(tween(240)),
                shape = RoundedCornerShape(22.dp),
                colors =
                    CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border =
                    if (model.id == "e4b")
                        BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = .25f))
                    else null,
            ) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        IconTile(
                            Icons.Outlined.AutoAwesome,
                            color =
                                if (model.id == "e4b") MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.secondary,
                        )
                        Column(
                            Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Text(model.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${"%.2f".format(model.size / 1_000_000_000.0)} GB · ${model.license}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (ready)
                            StatusPill(
                                if (s.selectedModel == model.id) "Selected" else "Ready",
                                icon = Icons.Outlined.CheckCircle,
                            )
                        else if (model.id == "e4b") StatusPill("Recommended")
                    }
                    Text(
                        if (model.toolInterface == "reduced-v2")
                            "Experimental model trained for this app. Import the supplied model file. Review its proposed changes carefully."
                        else if (model.id == "e4b")
                            "Best for detailed instructions and everyday expense tasks."
                        else "A smaller download. Clear, specific instructions work best.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (ready) {
                        Text(
                            "Ready for offline use",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        FlowButtons(
                            listOf(
                                "Use this model" to { vm.selectModel(model.id) },
                                "Delete model" to { vm.removeModel(model) },
                            )
                        )
                    } else if (downloading) {
                        val fraction by
                            animateFloatAsState(
                                (progress.bytes.toFloat() / progress.total.coerceAtLeast(1))
                                    .coerceIn(0f, 1f),
                                tween(250),
                                label = "model download progress",
                            )
                        LinearProgressIndicator(
                            progress = { fraction },
                            modifier =
                                Modifier.fillMaxWidth().height(5.dp).clip(RoundedCornerShape(3.dp)),
                        )
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "${progress.status} · ${progress.bytes / 1_000_000} / ${progress.total / 1_000_000} MB",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            TextButton(onClick = vm::pauseDownload) { Text(if (model.url.isBlank()) "Cancel import" else "Pause download") }
                        }
                    } else {
                        if (progress.id == model.id && progress.status.isNotBlank())
                            Text(
                                progress.status,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        FilledTonalButton(
                            onClick = {
                                if (model.url.isBlank()) {
                                    importingModel = model
                                    importModel.launch(arrayOf("*/*"))
                                } else vm.download(model, cellular)
                            },
                            enabled = !progress.running,
                            shape = RoundedCornerShape(12.dp),
                        ) {
                            Icon(Icons.Outlined.Download, null, Modifier.size(17.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                if (model.url.isBlank()) "Import model file"
                                else if (vm.models.partial(model) > 0) "Resume download"
                                else "Download model"
                            )
                        }
                    }
                }
            }
        }
        item {
            Panel(
                "Your workspace",
                "Timezone: ${s.settings.s("timezone", "America/Los_Angeles")}",
            ) {
                SettingsAction(Icons.Outlined.Schedule, "Change timezone", { edit("timezone") })
                SettingsAction(Icons.Outlined.Contrast, "Switch theme", vm::toggleTheme)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                SettingsAction(
                    Icons.Outlined.CloudDownload,
                    "Full workspace backup",
                    { vm.shareWorkspace() },
                    "Save a complete, recoverable copy",
                )
                SettingsAction(
                    Icons.Outlined.Restore,
                    "Restore workspace",
                    restore,
                    "Review a backup before replacing data",
                )
                SettingsAction(
                    Icons.Outlined.History,
                    "Previous workspace recovery copy",
                    { vm.shareWorkspace(true) },
                )
            }
        }
        item {
            Panel("Card accounts") {
                s.accounts.forEach { account ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Icon(
                            Icons.Outlined.CreditCard,
                            null,
                            Modifier.size(20.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Column {
                            Text(account.s("name"), style = MaterialTheme.typography.bodyMedium)
                            Text(
                                if (account.s("id") == "manual") "Cash and manually added expenses"
                                else if (account.s("format") == "amex") "American Express CSV"
                                else "Chase CSV",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                TextButton(onClick = { edit("account") }) {
                    Icon(Icons.Outlined.Add, null, Modifier.size(17.dp))
                    Spacer(Modifier.width(7.dp))
                    Text("Add card account")
                }
            }
        }
        item {
            Panel("Data and privacy") {
                IconTile(Icons.Outlined.VerifiedUser)
                Text(
                    "Your ledger, chat, receipts and models are stored privately on this phone. Automatic cloud backup is off. The internet is used for model downloads only.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "Use a full workspace backup to keep a recoverable copy. Only finalized splits affect balances; generated expense changes always need your confirmation.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
fun ImportDialogs(vm: AppViewModel, s: WorkspaceState) {
    s.workspacePreview?.let { preview ->
        AlertDialog(
            onDismissRequest = vm::dismissWorkspace,
            title = { Text("Restore full workspace") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        "${preview.n("people")} people · ${preview.n("transactions")} expenses · ${preview.n("trips")} trips · ${preview.n("receipts")} receipts"
                    )
                    Text("Outstanding balance: ${money(preview.n("outstandingCents"))}")
                    Text(
                        "This replaces the phone's workspace. A recovery copy of its current data is kept. Finalized splits and history are preserved; unfinished AI jobs require explicit resume. The web workspace remains independent."
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = vm::confirmWorkspace) { Text("Restore workspace") }
            },
            dismissButton = { TextButton(onClick = vm::dismissWorkspace) { Text("Cancel") } },
        )
    }
    s.statement?.let { preview ->
        var ack by remember(preview.id) { mutableStateOf(false) }
        var invalid by remember(preview.id) { mutableStateOf(false) }
        var keep by remember(preview.id) { mutableStateOf(setOf<Int>()) }
        AlertDialog(
            onDismissRequest = vm::dismissImport,
            title = { Text("Review statement import") },
            text = {
                LazyColumn(
                    Modifier.heightIn(max = 500.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item {
                        Text(
                            "${preview.rows.size} rows · ${preview.duplicates.size} duplicates · ${preview.rows.count { it.kind == "payment" && it.error == null }} card payments · ${preview.rows.count { it.error != null }} invalid"
                        )
                    }
                    items(preview.rows) { row ->
                        Column {
                            Text(
                                "${row.rowNumber}. ${row.date ?: "Invalid date"} · ${row.description} · ${row.amountCents?.let(::money) ?: "Invalid amount"}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            if (row.error != null)
                                Text(
                                    row.error ?: "Invalid row",
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            if (row.rowNumber in preview.duplicates)
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Checkbox(
                                        row.rowNumber in keep,
                                        {
                                            keep =
                                                if (it) keep + row.rowNumber
                                                else keep - row.rowNumber
                                        },
                                    )
                                    Text(
                                        "Known duplicate · keep as distinct",
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            if (row.kind == "payment")
                                Text(
                                    "Card-bill payment · retained in history, excluded from balances",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                        }
                    }
                    if (preview.duplicates.isNotEmpty())
                        item {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(ack, { ack = it })
                                Text("I reviewed the duplicate rows to skip.")
                            }
                        }
                    if (preview.rows.any { it.error != null })
                        item {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(invalid, { invalid = it })
                                Text("Skip the invalid rows shown above.")
                            }
                        }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { vm.confirmStatement(ack, invalid, keep) },
                    enabled =
                        (preview.duplicates.all { it in keep } || ack) &&
                            (preview.rows.none { it.error != null } || invalid),
                ) {
                    Text("Import valid expenses")
                }
            },
            dismissButton = { TextButton(onClick = vm::dismissImport) { Text("Cancel") } },
        )
    }
    s.imported?.let { (key, refs) ->
        var text by remember(key) { mutableStateOf("") }
        var from by remember(key) { mutableStateOf("") }
        var to by remember(key) { mutableStateOf("") }
        var narrow by remember { mutableStateOf(false) }
        val dates =
            refs.mapNotNull { r -> s.transactions.find { it.s("id") == r.id }?.s("date") }.sorted()
        AlertDialog(
            onDismissRequest = { vm.finishStatement("", false, "", "") },
            title = { Text("Context for ${refs.size} new expenses") },
            text = {
                Column(
                    Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        "${dates.firstOrNull()} – ${dates.lastOrNull()}. This context applies only to expenses added by this import."
                    )
                    CleanTextField(
                        text,
                        { text = it },
                        Modifier.fillMaxWidth(),
                        label = { Text("Trip, guests or sharing arrangement (optional)") },
                        minLines = 3,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(narrow, { narrow = it })
                        Text("Use a narrower date range")
                    }
                    if (narrow) DateRange(from, to, { from = it }, { to = it })
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.finishStatement(
                            text,
                            true,
                            if (narrow) from else "",
                            if (narrow) to else "",
                        )
                    }
                ) {
                    Text(if (text.isBlank()) "Process now" else "Save context & process")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        vm.finishStatement(
                            text,
                            false,
                            if (narrow) from else "",
                            if (narrow) to else "",
                        )
                    }
                ) {
                    Text(if (text.isBlank()) "Finish for now" else "Save context & finish")
                }
            },
        )
    }
    s.transfer?.let { preview ->
        var people by remember(preview) { mutableStateOf(false) }
        var skips by remember(preview) { mutableStateOf(false) }
        var keep by remember(preview) { mutableStateOf(setOf<Int>()) }
        AlertDialog(
            onDismissRequest = vm::dismissImport,
            title = { Text("Review ${preview.bundle.s("kind")} JSON") },
            text = {
                LazyColumn(
                    Modifier.heightIn(max = 500.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item { Text("Participant matches") }
                    items(preview.people) { p ->
                        Text(
                            "@${p.o("source").s("handle")} → ${p.o("target").s("name")} · ${if (p.b("existing")) "existing person" else "new person"}"
                        )
                    }
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(people, { people = it })
                            Text(
                                "I acknowledge these participant matches. Existing names and relationships stay unchanged."
                            )
                        }
                    }
                    item {
                        Text(
                            "${preview.rows.size} records · ${preview.rows.count { it.b("duplicate") }} duplicate matches. Imported transactions need finalization; imported rules need approval."
                        )
                    }
                    items(preview.rows) { r ->
                        Text(
                            "${r.n("rowNumber")}. ${r.o("record").s("description").ifEmpty { r.o("record").s("title") }}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        if (r.b("duplicate"))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(
                                    r.n("rowNumber").toInt() in keep,
                                    {
                                        keep =
                                            if (it) keep + r.n("rowNumber").toInt()
                                            else keep - r.n("rowNumber").toInt()
                                    },
                                )
                                Text(
                                    "Duplicate of ${r.s("existingId")} · keep as distinct",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                    }
                    if (preview.rows.any { it.b("duplicate") })
                        item {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(skips, { skips = it })
                                Text("I reviewed the duplicate records to skip.")
                            }
                        }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { vm.confirmJson(people, skips, keep) },
                    enabled =
                        people &&
                            (skips ||
                                preview.rows.none {
                                    it.b("duplicate") && it.n("rowNumber").toInt() !in keep
                                }),
                ) {
                    Text("Confirm import")
                }
            },
            dismissButton = { TextButton(onClick = vm::dismissImport) { Text("Cancel") } },
        )
    }
}
