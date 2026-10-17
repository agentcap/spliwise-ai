package com.splitwiseai.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.google.gson.JsonObject
import com.mikepenz.markdown.m3.Markdown
import com.splitwiseai.ledger.*
import java.time.LocalDate
import java.time.ZoneId

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val vm: AppViewModel = viewModel()
            val state by vm.state.collectAsStateWithLifecycle()
            SideEffect {
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !state.dark
                    isAppearanceLightNavigationBars = !state.dark
                }
            }
            AppTheme(state.dark) { Workspace(vm, state) }
        }
    }
}

data class Editor(val kind: String, val record: JsonObject? = null)

fun today(s: WorkspaceState): String =
    LocalDate.now(ZoneId.of(s.settings.s("timezone", "America/Los_Angeles"))).toString()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Workspace(vm: AppViewModel, s: WorkspaceState) {
    var page by rememberSaveable { mutableStateOf("assistant") }
    var editor by remember { mutableStateOf<Editor?>(null) }
    var detail by rememberSaveable { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var tripFilter by rememberSaveable { mutableStateOf("") }
    var personFilter by rememberSaveable { mutableStateOf("") }
    var importCard by rememberSaveable { mutableStateOf("sapphire") }
    var importing by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(s.notice) {
        if (s.notice.isNotBlank()) {
            snackbar.showSnackbar(s.notice)
            vm.clearNotice()
        }
    }
    val workspacePicker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {
            it?.let(vm::previewWorkspace)
        }
    val statementPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {
            it?.let { uri -> vm.previewStatement(uri, importCard) }
        }
    val jsonPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {
            it?.let(vm::previewJson)
        }
    val receiptPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null && detail != null) vm.attach(uri, detail!!)
        }
    BackHandler(
        page !in listOf("assistant", "review", "people", "trips", "more") || detail != null
    ) {
        if (detail != null) detail = null else page = "more"
    }
    val title =
        when (page) {
            "assistant" -> "Assistant"
            "review" -> "Review expenses"
            "people" -> "People & balances"
            "trips" -> "Trips"
            "overview" -> "Overview"
            "finalized" -> "Finalized"
            "rules" -> "Rules & context"
            "imports" -> "Import history"
            "settings" -> "Settings"
            else -> "Your workspace"
        }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                colors =
                    TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    ),
                navigationIcon = {
                    if (page !in listOf("assistant", "review", "people", "trips", "more")) {
                        IconButton(onClick = { page = "more" }) {
                            Icon(Icons.Outlined.ArrowBack, "Back to workspace")
                        }
                    } else
                        Box(Modifier.padding(start = 20.dp, end = 10.dp)) {
                            IconTile(Icons.Outlined.AccountBalanceWallet, Modifier.size(34.dp))
                        }
                },
                title = {
                    AnimatedContent(
                        title,
                        transitionSpec = {
                            (fadeIn(tween(180)) +
                                slideInVertically(tween(220)) { it / 3 }) togetherWith
                                fadeOut(tween(90))
                        },
                        label = "page title",
                    ) { name ->
                        Text(
                            name,
                            style = MaterialTheme.typography.titleLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    IconButton(
                        onClick = { vm.perform("Undone") { it.undo() } },
                        enabled = !s.loading,
                    ) {
                        Icon(Icons.Outlined.Undo, "Undo last action")
                    }
                    IconButton(onClick = vm::toggleTheme) {
                        val rotation by
                            animateFloatAsState(
                                if (s.dark) 0f else 180f,
                                tween(350),
                                label = "theme toggle",
                            )
                        Icon(
                            if (s.dark) Icons.Outlined.LightMode else Icons.Outlined.DarkMode,
                            "Switch theme",
                            Modifier.size(21.dp).rotate(rotation),
                        )
                    }
                },
            )
        },
        bottomBar = {
            WorkspaceNavigation(page) { key ->
                page = key
                if (key != "review") selected = emptySet()
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (s.loading) CircularProgressIndicator(Modifier.align(Alignment.Center))
            else {
                val pages = rememberSaveableStateHolder()
                AnimatedContent(
                    page,
                    modifier = Modifier.fillMaxSize(),
                    transitionSpec = {
                        (fadeIn(tween(220, delayMillis = 40)) +
                            slideInHorizontally(tween(280, easing = FastOutSlowInEasing)) {
                                it / 18
                            }) togetherWith fadeOut(tween(110)) using SizeTransform(clip = false)
                    },
                    label = "workspace navigation",
                ) { destination ->
                    pages.SaveableStateProvider(destination) {
                        when (destination) {
                            "assistant" ->
                                AssistantScreen(
                                    vm,
                                    s,
                                    selected,
                                    tripFilter,
                                    {
                                        selected = emptySet()
                                        tripFilter = ""
                                    },
                                    { page = "settings" },
                                    { detail = it },
                                )
                            "review",
                            "finalized" ->
                                ReviewScreen(
                                    vm,
                                    s,
                                    destination == "finalized",
                                    selected,
                                    { selected = it },
                                    tripFilter,
                                    personFilter,
                                    {
                                        tripFilter = ""
                                        personFilter = ""
                                    },
                                    { detail = it },
                                    { editor = Editor("expense") },
                                    { importing = true },
                                    { page = "assistant" },
                                )
                            "people" ->
                                PeopleScreen(
                                    vm,
                                    s,
                                    { editor = Editor("person") },
                                    { p -> editor = Editor("repayment", obj("personId" to p)) },
                                    { p ->
                                        personFilter = p
                                        page = "finalized"
                                    },
                                )
                            "trips" ->
                                TripsScreen(
                                    vm,
                                    s,
                                    { editor = Editor("trip", it) },
                                    { key ->
                                        tripFilter = key
                                        page = "review"
                                    },
                                    {
                                        tripFilter = it
                                        page = "assistant"
                                    },
                                )
                            "overview" -> OverviewScreen(s, { page = it }, { importing = true })
                            "rules" ->
                                OrganizationScreen(vm, s) { kind, record ->
                                    editor = Editor(kind, record)
                                }
                            "imports" -> ImportsScreen(s) { importing = true }
                            "settings" ->
                                SettingsScreen(
                                    vm,
                                    s,
                                    { workspacePicker.launch(arrayOf("*/*")) },
                                    { kind -> editor = Editor(kind) },
                                )
                            else ->
                                MoreScreen(
                                    { page = it },
                                    { importing = true },
                                    { editor = Editor("expense") },
                                )
                        }
                    }
                }
            }
        }
    }
    if (importing)
        AlertDialog(
            onDismissRequest = { importing = false },
            title = { Text("Import / export") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Statements stay on this device. Choose the card used for this export.")
                    Choice(
                        "Card account",
                        importCard,
                        s.accounts
                            .filter { it.s("id") != "manual" }
                            .map { it.s("id") to it.s("name") },
                    ) {
                        importCard = it
                    }
                    Button(
                        onClick = {
                            importing = false
                            statementPicker.launch(
                                arrayOf("text/*", "application/csv", "application/octet-stream")
                            )
                        },
                        Modifier.fillMaxWidth(),
                    ) {
                        Text("Import statement CSV")
                    }
                    OutlinedButton(
                        onClick = {
                            importing = false
                            jsonPicker.launch(
                                arrayOf("application/json", "text/*", "application/octet-stream")
                            )
                        },
                        Modifier.fillMaxWidth(),
                    ) {
                        Text("Import transactions or rules JSON")
                    }
                    OutlinedButton(
                        onClick = {
                            importing = false
                            workspacePicker.launch(arrayOf("*/*"))
                        },
                        Modifier.fillMaxWidth(),
                    ) {
                        Text("Restore full workspace")
                    }
                    HorizontalDivider()
                    Text("Export", style = MaterialTheme.typography.titleSmall)
                    FlowButtons(
                        listOf(
                            "Transactions JSON" to { vm.export("transactions") },
                            "Rules JSON" to { vm.export("rules") },
                            "Transactions CSV" to { vm.export("csv") },
                            "Full workspace" to { vm.shareWorkspace() },
                        )
                    )
                }
            },
            confirmButton = { TextButton(onClick = { importing = false }) { Text("Done") } },
        )
    editor?.let { value ->
        EditorDialog(value, s, onDismiss = { editor = null }) { input ->
            when (value.kind) {
                "person" ->
                    vm.perform("Person added") {
                        it.addPerson(input.s("name"), input.s("handle"), input.s("relation"))
                    }
                "expense" -> vm.perform("Expense added to Inbox") { it.manual(input) }
                "repayment" -> vm.perform("Repayment recorded") { it.repayment(input) }
                "trip" -> vm.perform("Trip saved") { it.saveTrip(input) }
                "rule" -> vm.perform("Rule saved") { it.saveRule(input) }
                "template" ->
                    vm.perform("Template saved") { it.saveOrganization("split_templates", input) }
                "alias" ->
                    vm.perform("Merchant name saved") {
                        it.saveOrganization("merchant_aliases", input)
                    }
                "context" ->
                    vm.perform("Context saved") { it.saveOrganization("user_context", input) }
                "account" ->
                    vm.perform("Card added") {
                        it.db.execute(
                            "INSERT INTO accounts(id,name,format) VALUES(?,?,?)",
                            id(),
                            input.s("name"),
                            input.s("format"),
                        )
                    }
                "timezone" ->
                    vm.perform("Timezone saved") {
                        ZoneId.of(input.s("timezone"))
                        it.db.execute(
                            "UPDATE workspace_settings SET timezone=? WHERE id='main'",
                            input.s("timezone"),
                        )
                    }
            }
            editor = null
        }
    }
    detail?.let { key ->
        s.transactions
            .find { it.s("id") == key }
            ?.let { t ->
                ExpenseSheet(
                    vm,
                    s,
                    t,
                    { detail = null },
                    { receiptPicker.launch(arrayOf("image/png", "image/jpeg", "application/pdf")) },
                    {
                        selected = setOf(key)
                        page = "assistant"
                        detail = null
                    },
                )
            }
    }
    ImportDialogs(vm, s)
    if (s.error.isNotEmpty())
        AlertDialog(
            onDismissRequest = vm::clearError,
            title = { Text("Action needs attention") },
            text = { Text(s.error) },
            confirmButton = { TextButton(onClick = vm::clearError) { Text("OK") } },
        )
}

@Composable
fun Choice(
    label: String,
    selected: String,
    options: List<Pair<String, String>>,
    compact: Boolean = false,
    change: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val display = options.find { it.first == selected }?.second ?: "Choose"
    val rotation by
        animateFloatAsState(if (expanded) 180f else 0f, tween(180), label = "dropdown arrow")
    Box {
        Surface(
            onClick = { expanded = true },
            modifier =
                Modifier.fillMaxWidth().semantics { contentDescription = "$label: $display" },
            shape = RoundedCornerShape(if (compact) 12.dp else 16.dp),
            color =
                if (compact) MaterialTheme.colorScheme.surfaceContainer
                else MaterialTheme.colorScheme.surfaceContainerLow,
            border =
                if (compact) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Row(
                Modifier.padding(horizontal = 14.dp, vertical = if (compact) 10.dp else 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (compact) {
                    Icon(
                        Icons.Outlined.Layers,
                        null,
                        Modifier.size(15.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "$label: $display",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.labelLarge,
                    )
                } else
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(
                            label,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            display,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                Icon(
                    Icons.Outlined.ExpandMore,
                    null,
                    Modifier.size(18.dp).rotate(rotation),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        DropdownMenu(expanded, { expanded = false }, modifier = Modifier.widthIn(min = 240.dp)) {
            options.forEach { (key, title) ->
                DropdownMenuItem(
                    text = { Text(title) },
                    trailingIcon = {
                        if (key == selected)
                            Icon(
                                Icons.Outlined.Check,
                                null,
                                Modifier.size(18.dp),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                    },
                    onClick = {
                        change(key)
                        expanded = false
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FlowButtons(buttons: List<Pair<String, () -> Unit>>) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        buttons.forEachIndexed { index, (label, action) ->
            val destructive = label in setOf("Delete", "Reject", "Remove", "Dismiss")
            if (index == 0 && !destructive)
                FilledTonalButton(
                    onClick = action,
                    shape = RoundedCornerShape(12.dp),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                    colors =
                        ButtonDefaults.filledTonalButtonColors(
                            containerColor = MaterialTheme.colorScheme.primaryContainer,
                            contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        ),
                ) {
                    Text(label)
                }
            else
                TextButton(
                    onClick = action,
                    colors =
                        ButtonDefaults.textButtonColors(
                            contentColor =
                                if (destructive) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.onSurfaceVariant
                        ),
                    contentPadding = PaddingValues(horizontal = 11.dp, vertical = 10.dp),
                ) {
                    Text(label)
                }
        }
    }
}

@Composable
fun Panel(title: String, subtitle: String = "", content: @Composable ColumnScope.() -> Unit = {}) {
    Card(
        Modifier.fillMaxWidth().animateContentSize(tween(260, easing = FastOutSlowInEasing)),
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            if (subtitle.isNotBlank())
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            content()
        }
    }
}

@Composable
fun Empty(title: String, body: String) {
    Column(
        Modifier.fillMaxWidth().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconTile(Icons.Outlined.ReceiptLong, Modifier.size(52.dp))
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
fun AssistantScreen(
    vm: AppViewModel,
    s: WorkspaceState,
    selected: Set<String>,
    trip: String,
    clearScope: () -> Unit,
    settings: () -> Unit,
    details: (String) -> Unit,
) {
    var text by rememberSaveable { mutableStateOf("") }
    var scope by rememberSaveable { mutableStateOf("workspace") }
    LaunchedEffect(selected, trip) {
        scope =
            if (selected.isNotEmpty()) "selected"
            else if (trip.isNotEmpty()) "trip" else "workspace"
    }
    fun send() {
        if (text.isBlank()) return
        vm.enqueue(
            text,
            if (scope == "selected") selected.toList() else null,
            trip = if (scope == "trip") trip else null,
        )
        text = ""
    }
    val listState = rememberLazyListState()
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(
            Modifier.padding(horizontal = 22.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(6.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(MaterialTheme.colorScheme.primary)
            )
            Spacer(Modifier.width(7.dp))
            Text(
                "On-device AI",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = settings) {
                Text(
                    if (vm.models.ready(vm.models.models.first { it.id == s.selectedModel }))
                        vm.models.models.first { it.id == s.selectedModel }.name
                    else "Set up AI"
                )
            }
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = listState,
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
            reverseLayout = true,
        ) {
            if (s.activeJob.isNotEmpty())
                item("live") {
                    Panel(s.activity) {
                        StatusPill("Processing privately", icon = Icons.Outlined.AutoAwesome)
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                        if (s.liveText.isNotBlank()) Markdown(s.liveText)
                        TextButton(onClick = vm::stop) { Text("Stop") }
                    }
                }
            items(
                s.jobs.filter { it.s("status") in setOf("failed", "cancelled", "queued") }.take(5),
                key = { "job" + it.s("id") },
            ) { job ->
                Panel(
                    if (job.s("status") == "queued") "Queued request"
                    else "Request ${job.s("status")}",
                    job.s("error"),
                ) {
                    if (job.s("status") == "queued")
                        TextButton(onClick = { vm.cancelQueued(job.s("id")) }) { Text("Cancel") }
                    else TextButton(onClick = { vm.retry(job.s("id")) }) { Text("Retry / resume") }
                }
            }
            items(s.messages.reversed(), key = { it.s("id") }) { message ->
                val own = message.s("role") == "user"
                Column(
                    Modifier.fillMaxWidth().animateItem(),
                    horizontalAlignment = if (own) Alignment.End else Alignment.Start,
                ) {
                    Card(
                        modifier = Modifier.widthIn(max = 350.dp).animateContentSize(tween(220)),
                        shape =
                            if (own) RoundedCornerShape(22.dp, 22.dp, 6.dp, 22.dp)
                            else RoundedCornerShape(6.dp, 22.dp, 22.dp, 22.dp),
                        colors =
                            CardDefaults.cardColors(
                                containerColor =
                                    if (own) MaterialTheme.colorScheme.primaryContainer
                                    else MaterialTheme.colorScheme.surface
                            ),
                    ) {
                        Column(Modifier.padding(18.dp)) {
                            Text(
                                if (own) "YOU" else "SPLITWISE AI",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Spacer(Modifier.height(8.dp))
                            Markdown(message.s("text"))
                        }
                    }
                    if (!own) {
                        s.events
                            .filter { it.s("jobId") == message.s("jobId") }
                            .forEach { event ->
                                Text(
                                    "${if (event.s("undoneAt").isEmpty()) "✓" else "Undone:"} ${event.s("title")} ${event.s("detail")}",
                                    Modifier.padding(8.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        s.requests
                            .filter { it.s("jobId") == message.s("jobId") }
                            .forEach { request -> RequestCard(vm, s, request, details) }
                    }
                }
            }
            if (s.olderMessages)
                item("older") {
                    TextButton(onClick = vm::loadOlderMessages) { Text("Load earlier messages") }
                }
            if (s.messages.isEmpty() && s.activeJob.isEmpty())
                item("welcome") { AssistantWelcome { text = it } }
        }
        Column(
            Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val choices =
                listOf("workspace" to "Workspace") +
                    (if (selected.isNotEmpty())
                        listOf("selected" to "${selected.size} selected expenses")
                    else emptyList()) +
                    (if (trip.isNotEmpty())
                        listOf(
                            "trip" to
                                (s.trips.find { it.s("id") == trip }?.s("name") ?: "Current trip")
                        )
                    else emptyList())
            Choice("Scope", scope, choices, compact = true) {
                scope = it
                if (it == "workspace") clearScope()
            }
            val mention = Regex("@([a-zA-Z0-9_]*)$").find(text)
            AnimatedVisibility(
                mention != null,
                enter = fadeIn(tween(180)) + expandVertically(tween(220)),
                exit = fadeOut(tween(100)) + shrinkVertically(tween(180)),
            ) {
                Row(Modifier.horizontalScroll(rememberScrollState())) {
                    s.people
                        .filter {
                            it.s("handle").startsWith(mention?.groupValues?.get(1).orEmpty(), true)
                        }
                        .take(6)
                        .forEach { person ->
                            AssistChip(
                                onClick = {
                                    text =
                                        text.take(mention?.range?.first ?: text.length) +
                                            "@${person.s("handle")} "
                                },
                                label = { Text("@${person.s("handle")}") },
                                modifier = Modifier.padding(end = 6.dp),
                            )
                        }
                }
            }
            Surface(
                shape = RoundedCornerShape(24.dp),
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                Row(verticalAlignment = Alignment.Bottom) {
                    BasicTextField(
                        text,
                        { text = it },
                        Modifier.weight(1f)
                            .heightIn(min = 48.dp, max = 150.dp)
                            .padding(horizontal = 17.dp, vertical = 14.dp),
                        textStyle =
                            MaterialTheme.typography.bodyMedium.copy(
                                color = MaterialTheme.colorScheme.onSurface
                            ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions =
                            KeyboardOptions(
                                capitalization = KeyboardCapitalization.Sentences,
                                imeAction = ImeAction.Send,
                            ),
                        keyboardActions = KeyboardActions(onSend = { send() }),
                        decorationBox = { inner ->
                            Box {
                                if (text.isEmpty())
                                    Text(
                                        "Ask about your expenses…",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                inner()
                            }
                        },
                        maxLines = 5,
                    )
                    FilledIconButton(
                        onClick = { send() },
                        modifier = Modifier.padding(end = 6.dp, bottom = 6.dp).size(38.dp),
                        enabled = text.isNotBlank(),
                    ) {
                        Icon(Icons.Outlined.ArrowUpward, "Send", Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun AssistantWelcome(prompt: (String) -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        IconTile(Icons.Outlined.AutoAwesome, Modifier.size(58.dp))
        Text(
            "A little clarity.\nFor every expense.",
            style = MaterialTheme.typography.headlineLarge,
        )
        Text(
            "Split costs, plan trips, and keep track of what’s owed. It all stays on your phone.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(2.dp))
        listOf(
                Triple(
                    Icons.Outlined.CallSplit,
                    "Split shared costs",
                    "Help me split an expense with ",
                ),
                Triple(Icons.Outlined.Add, "Add an expense", "Add a cash expense: "),
                Triple(Icons.Outlined.Luggage, "Plan a shared trip", "Create a trip to "),
            )
            .forEach { (icon, label, text) ->
                Surface(
                    onClick = { prompt(text) },
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.surface,
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(15.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Icon(
                            icon,
                            null,
                            Modifier.size(20.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            label,
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Icon(
                            Icons.Outlined.NorthEast,
                            null,
                            Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
    }
}

@Composable
fun RequestCard(vm: AppViewModel, s: WorkspaceState, r: JsonObject, details: (String) -> Unit) {
    val payload = json(r.s("payload"))
    val pending = r.s("status") == "pending"
    val splitUpdates =
        if (r.s("kind") == "splits") payload.asJsonArray.map { it.asJsonObject } else emptyList()
    val finalized =
        r.s("status") == "applied" &&
            splitUpdates.isNotEmpty() &&
            splitUpdates
                .filter { it.s("state") == "ready" }
                .let { ready ->
                    ready.isNotEmpty() &&
                        ready.all { u ->
                            s.transactions.any {
                                it.s("id") == u.s("id") &&
                                    it.s("state") == "finalized" &&
                                    it.doc("proposal") == u.o("proposal")
                            }
                        }
                }
    Card(
        Modifier.fillMaxWidth()
            .padding(top = 12.dp)
            .animateContentSize(tween(280, easing = FastOutSlowInEasing)),
        shape = RoundedCornerShape(20.dp),
        colors =
            CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        border =
            BorderStroke(
                1.dp,
                if (pending) MaterialTheme.colorScheme.primary.copy(alpha = .3f)
                else MaterialTheme.colorScheme.outlineVariant,
            ),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                IconTile(
                    if (r.s("kind") == "repayment") Icons.Outlined.Payments
                    else Icons.Outlined.ReceiptLong,
                    Modifier.size(34.dp),
                )
                Text(r.s("title"), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            }
            AnimatedContent(
                if (pending) "Review required"
                else if (finalized) "Finalized"
                else if (r.s("status") == "applied" && r.s("kind") == "splits") "Ready to finalize"
                else r.s("status").replaceFirstChar { it.uppercase() },
                label = "confirmation status",
            ) { status ->
                StatusPill(
                    status,
                    if (pending) MaterialTheme.colorScheme.tertiary
                    else MaterialTheme.colorScheme.primary,
                    if (pending) Icons.Outlined.Visibility else Icons.Outlined.CheckCircle,
                )
            }
            if (r.s("kind") == "splits")
                payload.asJsonArray.forEach { value ->
                    val u = value.asJsonObject
                    val t = s.transactions.find { it.s("id") == u.s("id") }
                    TextButton(onClick = { details(u.s("id")) }) {
                        Text(t?.let { merchantName(s, it) } ?: u.s("id"))
                    }
                    val p = u.o("proposal")
                    if (p.size() > 0)
                        p.shares().forEach { share ->
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    s.people.find { it.s("id") == share.personId }?.s("name")
                                        ?: "Unknown",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    money(share.amountCents),
                                    style = MaterialTheme.typography.titleSmall,
                                )
                            }
                        }
                    else Text(u.s("attention"))
                }
            else {
                val p = payload.asJsonObject
                Text(
                    when (r.s("kind")) {
                        "expense" ->
                            "${p.s("date")} · ${p.s("description")} · ${money(p.n("amountCents"))}"
                        "repayment" ->
                            "${s.people.find { it.s("id") == p.s("personId") }?.s("name")} · ${p.s("direction")} ${money(p.n("amountCents"))}"
                        else ->
                            "Assign ${p.a("items").size} expenses to ${s.trips.find { it.s("id") == p.s("tripId") }?.s("name") ?: "no trip"}"
                    }
                )
            }
            if (pending)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = {
                            vm.perform("Changes applied for review") { it.applyRequest(r.s("id")) }
                        },
                        shape = RoundedCornerShape(12.dp),
                    ) {
                        Text("Confirm changes")
                    }
                    TextButton(
                        onClick = { vm.perform("Dismissed") { it.dismissRequest(r.s("id")) } }
                    ) {
                        Text("Dismiss")
                    }
                }
            else {
                if (r.s("status") == "applied" && r.s("kind") == "splits" && !finalized)
                    Button(
                        onClick = {
                            vm.perform("Splits finalized") { it.finalizeRequest(r.s("id")) }
                        }
                    ) {
                        Text("Finalize splits")
                    }
            }
        }
    }
}
