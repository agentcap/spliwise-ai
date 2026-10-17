package com.splitwiseai.app

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.splitwiseai.ledger.*

@Composable
fun ReviewScreen(
    vm: AppViewModel,
    s: WorkspaceState,
    finalized: Boolean,
    selected: Set<String>,
    selection: (Set<String>) -> Unit,
    trip: String,
    person: String,
    clearFilter: () -> Unit,
    detail: (String) -> Unit,
    add: () -> Unit,
    import: () -> Unit,
    chat: () -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf("inbox") }
    var search by rememberSaveable { mutableStateOf("") }
    var from by rememberSaveable { mutableStateOf("") }
    var to by rememberSaveable { mutableStateOf("") }
    var account by rememberSaveable { mutableStateOf("") }
    var filters by remember { mutableStateOf(false) }
    var quick by remember { mutableStateOf(false) }
    var assign by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var savingView by remember { mutableStateOf(false) }
    var viewsVersion by remember { mutableIntStateOf(0) }
    var page by rememberSaveable { mutableIntStateOf(0) }
    var grouped by rememberSaveable { mutableStateOf(true) }
    val state = if (finalized) "finalized" else tab
    val filterTransition = remember { MutableTransitionState(false) }
    filterTransition.targetState = filters
    fun display(t: JsonObject): String = merchantName(s, t)
    val filtered =
        s.transactions
            .filter { t ->
                t.s("state") == state &&
                    (trip.isEmpty() || t.s("tripId") == trip) &&
                    (person.isEmpty() ||
                        t.doc("proposal").shares().any { it.personId == person }) &&
                    (from.isEmpty() || t.s("date") >= from) &&
                    (to.isEmpty() || t.s("date") <= to) &&
                    (account.isEmpty() || t.s("accountId") == account) &&
                    (search.isEmpty() ||
                        (display(t) +
                                " " +
                                t.s("description") +
                                " " +
                                t.s("instruction") +
                                " " +
                                t.s("notes"))
                            .contains(search, true))
            }
            .sortedWith(compareByDescending<JsonObject> { it.s("updatedAt") }.thenBy { it.s("id") })
    val visible = filtered.drop(page * 100).take(100)
    val refs = selected.mapNotNull { key ->
        s.transactions.find { it.s("id") == key }?.let { Reference(key, it.n("version")) }
    }
    LaunchedEffect(search, from, to, account, tab, trip, person) { page = 0 }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            FlowButtons(
                listOf(
                    "Add expense" to add,
                    "Import" to import,
                    "Filters" to { filters = !filters },
                )
            )
        }
        if (!finalized)
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("inbox" to "Inbox", "ready" to "Ready").forEach { (key, label) ->
                        FilterChip(
                            tab == key,
                            {
                                tab = key
                                selection(emptySet())
                            },
                            label = {
                                Text("$label (${s.transactions.count { it.s("state") == key }})")
                            },
                            border = null,
                            shape = RoundedCornerShape(12.dp),
                            colors =
                                FilterChipDefaults.filterChipColors(
                                    selectedContainerColor =
                                        MaterialTheme.colorScheme.primaryContainer,
                                    selectedLabelColor =
                                        MaterialTheme.colorScheme.onPrimaryContainer,
                                    containerColor = MaterialTheme.colorScheme.surface,
                                ),
                        )
                    }
                }
            }
        item {
            CleanTextField(
                search,
                { search = it },
                Modifier.fillMaxWidth(),
                placeholder = { Text("Search merchant, notes or instructions") },
                leadingIcon = { Icon(Icons.Outlined.Search, null) },
                singleLine = true,
            )
        }
        if (trip.isNotEmpty() || person.isNotEmpty())
            item {
                AssistChip(
                    onClick = clearFilter,
                    label = {
                        Text(
                            "${s.trips.find { it.s("id") == trip }?.s("name") ?: s.people.find { it.s("id") == person }?.s("name")} · Clear filter"
                        )
                    },
                )
            }
        if (filterTransition.currentState || filterTransition.targetState)
            item {
                AnimatedVisibility(
                    filterTransition,
                    enter = fadeIn(tween(180)) + expandVertically(tween(260)),
                    exit = fadeOut(tween(100)) + shrinkVertically(tween(220)),
                ) {
                    Panel("Filter expenses") {
                        DateRange(from, to, { from = it }, { to = it })
                        FlowButtons(
                            listOf(
                                "This month" to
                                    {
                                        from = today(s).take(7) + "-01"
                                        to = today(s)
                                    },
                                "This year" to
                                    {
                                        from = today(s).take(4) + "-01-01"
                                        to = today(s)
                                    },
                                "All dates" to
                                    {
                                        from = ""
                                        to = ""
                                    },
                            )
                        )
                        Choice(
                            "Card",
                            account,
                            listOf("" to "All cards") +
                                s.accounts.map { it.s("id") to it.s("name") },
                        ) {
                            account = it
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Switch(grouped, { grouped = it })
                            Text("Group similar merchants")
                        }
                        TextButton(onClick = { savingView = true }) { Text("Save this view") }
                        key(viewsVersion) {
                            vm.savedViews().forEach { view ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    TextButton(
                                        onClick = {
                                            search = view.s("search")
                                            from = view.s("from")
                                            to = view.s("to")
                                            account = view.s("account")
                                            tab = view.s("tab", "inbox")
                                        },
                                        Modifier.weight(1f),
                                    ) {
                                        Text(view.s("name"))
                                    }
                                    IconButton(
                                        onClick = {
                                            vm.removeView(view.s("name"))
                                            viewsVersion++
                                        }
                                    ) {
                                        Icon(Icons.Outlined.Close, "Remove saved view")
                                    }
                                }
                            }
                        }
                        FlowButtons(
                            listOf(
                                "Export filtered JSON" to
                                    {
                                        vm.export("transactions", from, to, state)
                                    },
                                "Export filtered CSV" to { vm.export("csv", from, to, state) },
                            )
                        )
                    }
                }
            }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    visible.isNotEmpty() && visible.all { it.s("id") in selected },
                    { checked ->
                        selection(
                            if (checked) selected + visible.map { it.s("id") }
                            else selected - visible.map { it.s("id") }.toSet()
                        )
                    },
                )
                Text(
                    "${filtered.size} expenses · ${selected.size} selected",
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
        if (selected.isNotEmpty())
            item {
                Panel("Selected expenses") {
                    if (finalized)
                        FlowButtons(
                            listOf(
                                "Reopen" to
                                    {
                                        vm.perform("Reopened for review") {
                                            it.review(refs, "reopen")
                                        }
                                        selection(emptySet())
                                    },
                                "Assign trip" to { assign = true },
                            )
                        )
                    else
                        FlowButtons(
                            listOf(
                                "Personal" to
                                    {
                                        vm.perform("Splits ready") { it.quick(refs, SplitSpec()) }
                                    },
                                "Split…" to { quick = true },
                                "Give one instruction" to chat,
                                "Process" to { vm.enqueue("", selected.toList(), true) },
                                "Assign trip" to { assign = true },
                            ) +
                                if (tab == "ready")
                                    listOf(
                                        "Finalize" to
                                            {
                                                vm.perform("Finalized") {
                                                    it.review(refs, "approve")
                                                }
                                                selection(emptySet())
                                            },
                                        "Return to Inbox" to
                                            {
                                                vm.perform("Returned to Inbox") {
                                                    it.review(refs, "reject")
                                                }
                                                selection(emptySet())
                                            },
                                    )
                                else emptyList()
                        )
                    if (!finalized && s.templates.isNotEmpty())
                        Choice(
                            "Apply template",
                            "",
                            s.templates.map { it.s("id") to it.s("name") },
                        ) { key ->
                            val t = s.templates.first { it.s("id") == key }
                            vm.perform("Template applied") {
                                it.quick(refs, SplitSpec.from(t.doc("spec")), t.s("category"))
                            }
                        }
                    TextButton(onClick = { selection(emptySet()) }) { Text("Clear selection") }
                }
            }
        if (visible.isEmpty())
            item {
                Empty(
                    if (state == "ready") "Nothing ready for review"
                    else if (finalized) "No finalized expenses" else "Your Inbox is clear",
                    "Add an expense or import a statement. Only finalized splits affect balances.",
                )
            }
        if (grouped && tab == "inbox" && !finalized) {
            visible
                .groupBy { normalized(display(it)) }
                .forEach { (merchant, transactions) ->
                    if (transactions.size > 1)
                        item("group$merchant") {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    "$merchant · ${transactions.size}",
                                    Modifier.weight(1f),
                                    style = MaterialTheme.typography.labelLarge,
                                )
                                TextButton(
                                    onClick = {
                                        selection(transactions.map { it.s("id") }.toSet())
                                        chat()
                                    }
                                ) {
                                    Text("One instruction")
                                }
                            }
                        }
                    items(transactions, key = { it.s("id") }) { t ->
                        ExpenseRow(
                            s,
                            t,
                            display(t),
                            t.s("id") in selected,
                            { selection(if (it) selected + t.s("id") else selected - t.s("id")) },
                            { detail(t.s("id")) },
                            Modifier.animateItem(),
                        )
                    }
                }
        } else
            items(visible, key = { it.s("id") }) { t ->
                ExpenseRow(
                    s,
                    t,
                    display(t),
                    t.s("id") in selected,
                    { selection(if (it) selected + t.s("id") else selected - t.s("id")) },
                    { detail(t.s("id")) },
                    Modifier.animateItem(),
                )
            }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { page-- }, enabled = page > 0) { Text("Previous") }
                Text("Page ${page + 1}")
                TextButton(onClick = { page++ }, enabled = (page + 1) * 100 < filtered.size) {
                    Text("Next")
                }
            }
        }
    }
    if (quick)
        SplitDialog(s, null, { quick = false }) { spec, category ->
            vm.perform("Splits ready") { it.quick(refs, spec, category) }
            quick = false
        }
    if (assign)
        AlertDialog(
            onDismissRequest = { assign = false },
            title = { Text("Assign trip") },
            text = {
                Choice(
                    "Trip",
                    "",
                    listOf("" to "Remove trip assignment") +
                        s.trips
                            .filter { it.s("status") == "active" }
                            .map { it.s("id") to it.s("name") },
                ) { key ->
                    vm.perform("Trip assigned") { it.assign(refs, key.ifEmpty { null }) }
                    assign = false
                }
            },
            confirmButton = { TextButton(onClick = { assign = false }) { Text("Cancel") } },
        )
    if (savingView)
        AlertDialog(
            onDismissRequest = { savingView = false },
            title = { Text("Save view") },
            text = { CleanTextField(name, { name = it }, label = { Text("Name") }) },
            confirmButton = {
                TextButton(
                    onClick = {
                        vm.saveView(
                            obj(
                                "name" to name.trim(),
                                "search" to search,
                                "from" to from,
                                "to" to to,
                                "account" to account,
                                "tab" to tab,
                            )
                        )
                        viewsVersion++
                        savingView = false
                    },
                    enabled = name.isNotBlank(),
                ) {
                    Text("Save")
                }
            },
            dismissButton = { TextButton(onClick = { savingView = false }) { Text("Cancel") } },
        )
}

@Composable
fun ExpenseRow(
    s: WorkspaceState,
    t: JsonObject,
    title: String,
    selected: Boolean,
    change: (Boolean) -> Unit,
    open: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val fill by
        animateColorAsState(
            if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = .65f)
            else MaterialTheme.colorScheme.surface,
            tween(180),
            label = "expense selection",
        )
    val outline by
        animateColorAsState(
            if (selected) MaterialTheme.colorScheme.primary.copy(alpha = .5f)
            else MaterialTheme.colorScheme.outlineVariant.copy(alpha = .4f),
            tween(180),
            label = "expense outline",
        )
    Card(
        modifier.fillMaxWidth().clickable(onClick = open),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = fill),
        border = BorderStroke(1.dp, outline),
    ) {
        Row(
            Modifier.padding(start = 4.dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(selected, change)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${friendlyDate(t.s("date"))} · ${s.accounts.find { it.s("id") == t.s("accountId") }?.s("name") ?: "Manual"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (t.s("attention").isNotBlank())
                    Text(
                        t.s("attention"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                if (t.doc("proposal").size() > 0)
                    Text(
                        t.doc("proposal").shares().joinToString { share ->
                            "${s.people.find { it.s("id") == share.personId }?.s("name")}: ${money(share.amountCents)}"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
            }
            Text(
                money(t.n("amountCents")),
                Modifier.padding(start = 8.dp),
                style = MaterialTheme.typography.titleMedium,
                color =
                    if (t.n("amountCents") < 0) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
fun PeopleScreen(
    vm: AppViewModel,
    s: WorkspaceState,
    add: () -> Unit,
    repay: (String) -> Unit,
    ledger: (String) -> Unit,
) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            BalanceHero(
                s.balances.sumOf { it.outstandingCents },
                "Total outstanding",
                "From finalized expenses, with repayments included.",
            )
        }
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Your people",
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.titleMedium,
                )
                TextButton(onClick = add) {
                    Icon(Icons.Outlined.PersonAdd, null, Modifier.size(17.dp))
                    Spacer(Modifier.width(7.dp))
                    Text("Add person")
                }
            }
        }
        items(s.balances, key = { it.person.s("id") }) { b ->
            var expanded by remember { mutableStateOf(false) }
            Card(
                Modifier.fillMaxWidth().animateItem(),
                shape = RoundedCornerShape(22.dp),
                colors =
                    CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        PersonAvatar(b.person.s("name"))
                        Column(
                            Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(b.person.s("name"), style = MaterialTheme.typography.titleMedium)
                            Text(
                                "@${b.person.s("handle")}${b.person.s("relation").takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text(
                                money(b.outstandingCents),
                                style = MaterialTheme.typography.titleLarge,
                            )
                            Text(
                                if (b.outstandingCents > 0) "owes you" else "settled up",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (b.creditCents > 0)
                        StatusPill(
                            "Available credit · ${money(b.creditCents)}",
                            MaterialTheme.colorScheme.secondary,
                            Icons.Outlined.AccountBalanceWallet,
                        )
                    FlowButtons(
                        listOf(
                            "Record repayment" to { repay(b.person.s("id")) },
                            "Expenses" to { ledger(b.person.s("id")) },
                            "Share summary" to { vm.shareSettlement(b.person.s("id")) },
                            "Details" to { expanded = !expanded },
                        )
                    )
                    AnimatedVisibility(
                        expanded,
                        enter = fadeIn(tween(180)) + expandVertically(tween(260)),
                        exit = fadeOut(tween(100)) + shrinkVertically(tween(220)),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            Row(horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                                Column {
                                    Text(
                                        "Received",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    Text(
                                        money(b.receivedCents),
                                        style = MaterialTheme.typography.titleSmall,
                                    )
                                }
                                Column {
                                    Text(
                                        "Returned",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    Text(
                                        money(b.returnedCents),
                                        style = MaterialTheme.typography.titleSmall,
                                    )
                                }
                            }
                            b.expenses
                                .filter { it.remainingCents > 0 }
                                .take(50)
                                .forEach { expense ->
                                    Row(
                                        Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(
                                                expense.description,
                                                style = MaterialTheme.typography.bodySmall,
                                            )
                                            Text(
                                                friendlyDate(expense.date),
                                                style = MaterialTheme.typography.labelMedium,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                        Text(
                                            money(expense.remainingCents),
                                            style = MaterialTheme.typography.titleSmall,
                                        )
                                    }
                                }
                            s.payments
                                .filter { it.s("personId") == b.person.s("id") }
                                .take(30)
                                .forEach {
                                    Text(
                                        "${friendlyDate(it.s("date"))} · ${it.s("direction")} ${money(it.n("amountCents"))}\n${it.s("note")}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                        }
                    }
                }
            }
        }
        if (s.balances.isEmpty())
            item {
                Empty(
                    "Better together",
                    "Add the people you share costs with. Mention their @handle in chat to get started.",
                )
            }
    }
}

@Composable
fun TripsScreen(
    vm: AppViewModel,
    s: WorkspaceState,
    edit: (JsonObject?) -> Unit,
    review: (String) -> Unit,
    chat: (String) -> Unit,
) {
    var suggestions by remember { mutableStateOf<JsonObject?>(null) }
    var chosen by remember { mutableStateOf(setOf<String>()) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Shared adventures", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "The costs, all in one place.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                FilledTonalButton(onClick = { edit(null) }) {
                    Icon(Icons.Outlined.Add, null, Modifier.size(17.dp))
                    Spacer(Modifier.width(5.dp))
                    Text("Create trip")
                }
            }
        }
        items(s.trips, key = { it.s("id") }) { trip ->
            val tx = s.transactions.filter { it.s("tripId") == trip.s("id") }
            val final = tx.filter { it.s("state") == "finalized" }
            var menu by remember { mutableStateOf(false) }
            Card(
                Modifier.fillMaxWidth().animateItem(),
                shape = RoundedCornerShape(24.dp),
                colors =
                    CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        IconTile(
                            Icons.Outlined.Luggage,
                            color =
                                if (trip.s("status") == "active")
                                    MaterialTheme.colorScheme.secondary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Column(
                            Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Text(trip.s("name"), style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${friendlyDate(trip.s("from"))} – ${friendlyDate(trip.s("to"))}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Box {
                            IconButton(onClick = { menu = true }) {
                                Icon(Icons.Outlined.MoreHoriz, "Trip options")
                            }
                            DropdownMenu(menu, { menu = false }) {
                                DropdownMenuItem(
                                    text = { Text("Ask assistant") },
                                    onClick = {
                                        menu = false
                                        chat(trip.s("id"))
                                    },
                                    leadingIcon = { Icon(Icons.Outlined.AutoAwesome, null) },
                                )
                                DropdownMenuItem(
                                    text = { Text("Suggest expenses") },
                                    onClick = {
                                        menu = false
                                        suggestions = trip
                                        chosen = emptySet()
                                    },
                                    leadingIcon = { Icon(Icons.Outlined.PlaylistAdd, null) },
                                )
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            if (trip.s("status") == "active") "Archive"
                                            else "Reopen"
                                        )
                                    },
                                    onClick = {
                                        menu = false
                                        vm.perform("Trip updated") {
                                            it.archiveTrip(
                                                trip.s("id"),
                                                trip.n("version"),
                                                trip.s("status") == "active",
                                            )
                                        }
                                    },
                                    leadingIcon = { Icon(Icons.Outlined.Archive, null) },
                                )
                                s.balances
                                    .filter {
                                        it.person.s("id") in
                                            json(trip.s("participants")).asJsonArray.map { p ->
                                                p.asString
                                            }
                                    }
                                    .forEach { b ->
                                        DropdownMenuItem(
                                            text = {
                                                Text(
                                                    "Share ${b.person.s("name")}'s settlement summary"
                                                )
                                            },
                                            onClick = {
                                                menu = false
                                                vm.shareSettlement(
                                                    b.person.s("id"),
                                                    trip = trip.s("id"),
                                                )
                                            },
                                            leadingIcon = { Icon(Icons.Outlined.IosShare, null) },
                                        )
                                    }
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatusPill(
                            trip.s("status").replaceFirstChar { it.uppercase() },
                            if (trip.s("status") == "active") MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (tx.isNotEmpty())
                            StatusPill("${tx.size} expenses", MaterialTheme.colorScheme.secondary)
                        if (tx.any { it.s("state") != "finalized" })
                            StatusPill(
                                "${tx.count { it.s("state") != "finalized" }} to review",
                                MaterialTheme.colorScheme.tertiary,
                            )
                    }
                    if (trip.s("context").isNotBlank())
                        Text(
                            trip.s("context"),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    if (tx.isNotEmpty()) {
                        Row(Modifier.fillMaxWidth()) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    "Finalized spending",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    money(final.sumOf { it.n("amountCents") }),
                                    style = MaterialTheme.typography.headlineSmall,
                                )
                            }
                            Column(Modifier.weight(1f)) {
                                Text(
                                    "Your share",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    money(
                                        final.sumOf {
                                            it.doc("proposal")
                                                .shares()
                                                .find { p -> p.personId == "self" }
                                                ?.amountCents ?: 0L
                                        }
                                    ),
                                    style = MaterialTheme.typography.headlineSmall,
                                )
                            }
                        }
                    }
                    FlowButtons(
                        listOf(
                            "Review expenses" to { review(trip.s("id")) },
                            "Edit" to { edit(trip) },
                        )
                    )
                }
            }
        }
        if (s.trips.isEmpty())
            item {
                Empty(
                    "Where to next?",
                    "Create a trip, choose your people, and set a default split. You decide which expenses belong.",
                )
            }
    }
    suggestions?.let { trip ->
        val rows =
            s.transactions.filter {
                it.s("tripId").isEmpty() &&
                    it.s("date") >= trip.s("from") &&
                    it.s("date") <= trip.s("to")
            }
        AlertDialog(
            onDismissRequest = { suggestions = null },
            title = { Text("Suggested trip expenses") },
            text = {
                LazyColumn(
                    Modifier.heightIn(max = 400.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    item {
                        Text(
                            "Choose expenses that belong to this trip. You can assign other bookings from Review.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    items(rows) { t ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                t.s("id") in chosen,
                                { chosen = if (it) chosen + t.s("id") else chosen - t.s("id") },
                            )
                            Text(
                                "${friendlyDate(t.s("date"))} · ${merchantName(s, t)} · ${money(t.n("amountCents"))}",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val refs = chosen.map { key ->
                            val t = rows.first { it.s("id") == key }
                            Reference(key, t.n("version"))
                        }
                        vm.perform("Trip expenses assigned") { it.assign(refs, trip.s("id")) }
                        suggestions = null
                    },
                    enabled = chosen.isNotEmpty(),
                ) {
                    Text("Assign ${chosen.size}")
                }
            },
            dismissButton = { TextButton(onClick = { suggestions = null }) { Text("Cancel") } },
        )
    }
}

@Composable
fun OverviewScreen(s: WorkspaceState, navigate: (String) -> Unit, import: () -> Unit) {
    var from by rememberSaveable { mutableStateOf("") }
    var to by rememberSaveable { mutableStateOf("") }
    var dates by remember { mutableStateOf(false) }
    val final =
        s.transactions.filter {
            it.s("state") == "finalized" &&
                (from.isEmpty() || it.s("date") >= from) &&
                (to.isEmpty() || it.s("date") <= to)
        }
    val spent = final.sumOf { it.n("amountCents") }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (from.isBlank() && to.isBlank()) "All dates"
                    else "${from.ifBlank { "Beginning" }} – ${to.ifBlank { "Today" }}",
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { dates = !dates }) {
                    Icon(Icons.Outlined.CalendarMonth, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Date range")
                }
            }
            AnimatedVisibility(
                dates,
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically(),
            ) {
                DateRange(from, to, { from = it }, { to = it })
            }
        }
        item {
            BalanceHero(
                spent,
                "Total spent in range",
                "${final.size} finalized expenses · ${s.transactions.count { it.s("state") != "finalized" }} still to review",
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Card(
                    Modifier.weight(1f),
                    colors =
                        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    Column(
                        Modifier.padding(18.dp),
                        verticalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Icon(
                            Icons.Outlined.PersonOutline,
                            null,
                            Modifier.size(20.dp),
                            MaterialTheme.colorScheme.secondary,
                        )
                        Text(
                            "Your share in range",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            money(
                                final.sumOf {
                                    it.doc("proposal")
                                        .shares()
                                        .find { p -> p.personId == "self" }
                                        ?.amountCents ?: 0L
                                }
                            ),
                            style = MaterialTheme.typography.titleLarge,
                        )
                    }
                }
                Card(
                    Modifier.weight(1f),
                    colors =
                        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    Column(
                        Modifier.padding(18.dp),
                        verticalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Icon(
                            Icons.Outlined.AccountBalanceWallet,
                            null,
                            Modifier.size(20.dp),
                            MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            "All-time outstanding",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            money(s.balances.sumOf { it.outstandingCents }),
                            style = MaterialTheme.typography.titleLarge,
                        )
                    }
                }
            }
        }
        item {
            Panel("Spending by category") {
                if (final.isEmpty())
                    Text(
                        "Finalize your first split to see your spending here.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                final
                    .groupBy { it.doc("proposal").s("category") }
                    .mapValues { it.value.sumOf { t -> t.n("amountCents") } }
                    .toList()
                    .sortedByDescending { it.second }
                    .forEach { (category, amount) ->
                        key(category) {
                            var appeared by remember { mutableStateOf(false) }
                            LaunchedEffect(Unit) { appeared = true }
                            val progress by
                                animateFloatAsState(
                                    if (appeared && spent > 0)
                                        (amount.toFloat() / spent).coerceIn(0f, 1f)
                                    else 0f,
                                    tween(650, easing = FastOutSlowInEasing),
                                    label = "category bar",
                                )
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                IconTile(
                                    categoryIcon(category),
                                    Modifier.size(34.dp),
                                    MaterialTheme.colorScheme.secondary,
                                )
                                Column(
                                    Modifier.weight(1f),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Row(
                                        Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                    ) {
                                        Text(category, style = MaterialTheme.typography.bodyMedium)
                                        Text(
                                            money(amount),
                                            style = MaterialTheme.typography.titleSmall,
                                        )
                                    }
                                    LinearProgressIndicator(
                                        progress = { progress },
                                        modifier =
                                            Modifier.fillMaxWidth()
                                                .height(4.dp)
                                                .clip(RoundedCornerShape(2.dp)),
                                        color = MaterialTheme.colorScheme.secondary,
                                        trackColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                                    )
                                }
                            }
                        }
                    }
            }
        }
        item {
            Panel("Monthly spending") {
                final
                    .groupBy { it.s("date").take(7) }
                    .toSortedMap()
                    .forEach { (month, tx) ->
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                runCatching {
                                        java.time.YearMonth.parse(month)
                                            .format(
                                                java.time.format.DateTimeFormatter.ofPattern(
                                                    "MMMM yyyy"
                                                )
                                            )
                                    }
                                    .getOrDefault(month),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                money(tx.sumOf { it.n("amountCents") }),
                                style = MaterialTheme.typography.titleSmall,
                            )
                        }
                    }
                Text(
                    "Unpaid from this range: ${money(s.balances.sumOf { b -> b.expenses.filter { (from.isEmpty() || it.date >= from) && (to.isEmpty() || it.date <= to) }.sumOf { it.remainingCents } })}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item {
            FlowButtons(
                listOf(
                    "Review" to { navigate("review") },
                    "Add people" to { navigate("people") },
                    "Import statement" to import,
                    "Set up AI" to { navigate("settings") },
                )
            )
        }
    }
}

@Composable
fun MoreScreen(navigate: (String) -> Unit, import: () -> Unit, add: () -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Make room for\nwhat matters.", style = MaterialTheme.typography.headlineLarge)
                Text(
                    "A clearer view of your shared expenses.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Surface(
                    onClick = add,
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(20.dp),
                    color = MaterialTheme.colorScheme.primaryContainer,
                ) {
                    Column(
                        Modifier.padding(18.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Icon(
                            Icons.Outlined.Add,
                            null,
                            tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                        Text(
                            "Add expense",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                }
                Surface(
                    onClick = import,
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(20.dp),
                    color = MaterialTheme.colorScheme.secondaryContainer,
                ) {
                    Column(
                        Modifier.padding(18.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Icon(
                            Icons.Outlined.FileUpload,
                            null,
                            tint = MaterialTheme.colorScheme.onSecondaryContainer,
                        )
                        Text(
                            "Import / export",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                        )
                    }
                }
            }
        }
        item {
            Panel("Your workspace") {
                SettingsAction(
                    Icons.Outlined.PieChart,
                    "Overview & reports",
                    { navigate("overview") },
                    "Spending, categories and monthly totals",
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                SettingsAction(
                    Icons.Outlined.TaskAlt,
                    "Finalized expenses",
                    { navigate("finalized") },
                    "Accepted splits and their history",
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                SettingsAction(
                    Icons.Outlined.Tune,
                    "Rules, context & templates",
                    { navigate("rules") },
                    "Make repeat expenses easier",
                )
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                SettingsAction(
                    Icons.Outlined.History,
                    "Import history",
                    { navigate("imports") },
                    "Statements and imported context",
                )
            }
        }
        item {
            Panel("Preferences") {
                SettingsAction(
                    Icons.Outlined.Settings,
                    "Settings & on-device AI",
                    { navigate("settings") },
                    "Models, appearance, backups and privacy",
                )
            }
        }
    }
}

@Composable
fun ImportsScreen(s: WorkspaceState, import: () -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Button(onClick = import) { Text("Import statements or data") } }
        items(s.imports, key = { it.s("id") }) { row ->
            Panel(row.s("fileName"), "${row.s("createdAt")}\n${row.s("summary")}") {
                row.doc("preview")
                    .o("completion")
                    .s("context")
                    .takeIf { it.isNotEmpty() }
                    ?.let { Text("Context from import: $it") }
            }
        }
    }
}

@Composable
fun OrganizationScreen(vm: AppViewModel, s: WorkspaceState, edit: (String, JsonObject?) -> Unit) {
    var tab by rememberSaveable { mutableStateOf("rules") }
    var optimize by remember { mutableStateOf<List<List<JsonObject>>?>(null) }
    var optimizationRevision by remember { mutableStateOf("") }
    var cleanupSelected by remember { mutableStateOf(setOf<Int>()) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Choice(
                "Show",
                tab,
                listOf(
                    "rules" to "Rules",
                    "context" to "Saved context",
                    "templates" to "Split templates",
                    "aliases" to "Merchant names",
                ),
            ) {
                tab = it
            }
        }
        item {
            FlowButtons(
                listOf(
                    "Add ${when(tab) { "rules" -> "rule"
 "context" -> "context"
 "templates" -> "template"
 else -> "merchant name" }}" to
                        {
                            edit(
                                when (tab) {
                                    "rules" -> "rule"
                                    "context" -> "context"
                                    "templates" -> "template"
                                    else -> "alias"
                                },
                                null,
                            )
                        }
                ) +
                    if (tab == "rules")
                        listOf(
                            "Optimize rules" to
                                {
                                    vm.perform("") {
                                        optimizationRevision = it.revision()
                                        val groups = it.optimization()
                                        cleanupSelected = groups.indices.toSet()
                                        optimize = groups
                                    }
                                }
                        )
                    else emptyList()
            )
        }
        if (tab == "rules") {
            items(s.ruleChanges, key = { "draft" + it.s("id") }) { rule ->
                Panel(
                    "Proposed: ${rule.s("title")}",
                    "Imported/manual rule drafts need approval.",
                ) {
                    RuleDescription(s, rule.doc("definition"))
                    FlowButtons(
                        listOf(
                            "Approve" to
                                {
                                    vm.perform("Rule activated") {
                                        it.reviewRule(rule.s("id"), true)
                                    }
                                },
                            "Reject" to
                                {
                                    vm.perform("Rule rejected") {
                                        it.reviewRule(rule.s("id"), false)
                                    }
                                },
                        )
                    )
                }
            }
            items(s.rules, key = { it.s("id") }) { rule ->
                Panel(rule.s("title"), "Active for future processing") {
                    RuleDescription(s, rule.doc("definition"))
                    FlowButtons(
                        listOf(
                            "Edit" to { edit("rule", rule) },
                            "Delete" to
                                {
                                    vm.perform("Rule deleted") {
                                        it.deleteRule(rule.s("id"), rule.n("version"))
                                    }
                                },
                        )
                    )
                }
            }
        } else {
            val rows =
                when (tab) {
                    "context" -> s.contexts
                    "templates" -> s.templates
                    else -> s.aliases
                }
            items(rows, key = { it.s("id") }) { row ->
                Panel(
                    row.s(if (tab == "context") "title" else "name"),
                    when (tab) {
                        "context" -> row.s("text")
                        "templates" -> row.s("category")
                        else -> row.s("pattern")
                    },
                ) {
                    if (tab == "templates") Text(splitLabel(s, SplitSpec.from(row.doc("spec"))))
                    if (tab == "context") {
                        Text(
                            "Source quote: ${row.s("quote")}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text(
                            "${row.s("from")} ${row.s("to")}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    val kind =
                        when (tab) {
                            "context" -> "context"
                            "templates" -> "template"
                            else -> "alias"
                        }
                    val table =
                        when (tab) {
                            "context" -> "user_context"
                            "templates" -> "split_templates"
                            else -> "merchant_aliases"
                        }
                    FlowButtons(
                        listOf(
                            "Edit" to { edit(kind, row) },
                            "Delete" to
                                {
                                    vm.perform("Removed") {
                                        it.removeOrganization(table, row.s("id"), row.n("version"))
                                    }
                                },
                        )
                    )
                }
            }
        }
    }
    optimize?.let { groups ->
        AlertDialog(
            onDismissRequest = { optimize = null },
            title = { Text("Optimize rules") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text("${groups.size} compatible groups. Conflicting outcomes remain separate.")
                    groups.forEachIndexed { index, group ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                index in cleanupSelected,
                                {
                                    cleanupSelected =
                                        if (it) cleanupSelected + index else cleanupSelected - index
                                },
                            )
                            Text(group.joinToString(" + ") { r -> r.s("title") })
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val chosen = groups.filterIndexed { i, _ -> i in cleanupSelected }
                        vm.perform("Rules optimized") {
                            it.optimize(chosen, expectedRevision = optimizationRevision)
                        }
                        optimize = null
                    },
                    enabled = cleanupSelected.isNotEmpty(),
                ) {
                    Text("Apply cleanup")
                }
            },
            dismissButton = { TextButton(onClick = { optimize = null }) { Text("Cancel") } },
        )
    }
}

@Composable
fun RuleDescription(s: WorkspaceState, d: JsonObject) {
    Text(
        "${(listOf(d.s("merchant")) + d.a("merchantAliases").map { it.asString }).filter { it.isNotEmpty() }.joinToString(" OR ").ifEmpty { "Any merchant" }} · ${d.s("outputCategory")}"
    )
    Text(splitLabel(s, SplitSpec.from(d.o("split"))), style = MaterialTheme.typography.bodySmall)
    if (
        d.s("accountId").isNotEmpty() ||
            d.s("from").isNotEmpty() ||
            d.s("to").isNotEmpty() ||
            d.s("category").isNotEmpty()
    )
        Text(
            "${s.accounts.find { it.s("id") == d.s("accountId") }?.s("name") ?: "All cards"} · ${d.s("category")} · ${d.s("from")} – ${d.s("to")}",
            style = MaterialTheme.typography.bodySmall,
        )
}

fun splitLabel(s: WorkspaceState, spec: SplitSpec): String =
    "${spec.mode.replaceFirstChar { it.uppercase() }} · " +
        spec.participants
            .mapIndexed { i, key ->
                "${s.people.find { it.s("id") == key }?.s("name") ?: key}${spec.values?.getOrNull(i)?.let { if (spec.mode == "percent") " ${it / 100.0}%" else " ${money(it)}" } ?: ""}"
            }
            .joinToString()

@Composable
fun DateRange(from: String, to: String, fromChange: (String) -> Unit, toChange: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CleanTextField(
            from,
            fromChange,
            Modifier.weight(1f),
            label = { Text("From (YYYY-MM-DD)") },
            singleLine = true,
        )
        CleanTextField(
            to,
            toChange,
            Modifier.weight(1f),
            label = { Text("To (YYYY-MM-DD)") },
            singleLine = true,
        )
    }
}
