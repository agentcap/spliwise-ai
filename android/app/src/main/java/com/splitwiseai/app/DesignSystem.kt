package com.splitwiseai.app

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.gson.JsonObject
import com.splitwiseai.ledger.*
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

// Standard Compose animations follow Android's animator duration scale, including off.
val CalmMotion = tween<Float>(240, easing = FastOutSlowInEasing)

@Composable
fun AppTheme(dark: Boolean, content: @Composable () -> Unit) {
    val target =
        if (dark)
            darkColorScheme(
                primary = Color(0xFF79E4C1),
                onPrimary = Color(0xFF07382B),
                primaryContainer = Color(0xFF193C34),
                onPrimaryContainer = Color(0xFFBCF5DF),
                secondary = Color(0xFFA6C7FF),
                onSecondary = Color(0xFF132E50),
                secondaryContainer = Color(0xFF21334D),
                onSecondaryContainer = Color(0xFFD1E2FF),
                tertiary = Color(0xFFE9C88C),
                tertiaryContainer = Color(0xFF3E3321),
                onTertiaryContainer = Color(0xFFF5DFB8),
                background = Color(0xFF0C131E),
                onBackground = Color(0xFFEDF2F8),
                surface = Color(0xFF151F2D),
                onSurface = Color(0xFFEDF2F8),
                surfaceVariant = Color(0xFF202D3D),
                onSurfaceVariant = Color(0xFF9EAFC2),
                surfaceContainerLowest = Color(0xFF0A1019),
                surfaceContainerLow = Color(0xFF111B28),
                surfaceContainer = Color(0xFF182332),
                surfaceContainerHigh = Color(0xFF1E2B3B),
                surfaceContainerHighest = Color(0xFF263345),
                surfaceDim = Color(0xFF0C131E),
                surfaceBright = Color(0xFF2B3849),
                outline = Color(0xFF5B6A7C),
                outlineVariant = Color(0xFF2B394A),
                inverseSurface = Color(0xFFE4ECF4),
                inverseOnSurface = Color(0xFF1B2838),
                inversePrimary = Color(0xFF126B53),
                error = Color(0xFFFFB3AE),
                errorContainer = Color(0xFF482A2C),
                onErrorContainer = Color(0xFFFFDAD7),
            )
        else
            lightColorScheme(
                primary = Color(0xFF126C54),
                onPrimary = Color.White,
                primaryContainer = Color(0xFFD9F2E8),
                onPrimaryContainer = Color(0xFF134B3D),
                secondary = Color(0xFF315F9D),
                onSecondary = Color.White,
                secondaryContainer = Color(0xFFE4EDFA),
                onSecondaryContainer = Color(0xFF234878),
                tertiary = Color(0xFF846124),
                tertiaryContainer = Color(0xFFF8EED8),
                onTertiaryContainer = Color(0xFF70531D),
                background = Color(0xFFF5F7F9),
                onBackground = Color(0xFF172638),
                surface = Color.White,
                onSurface = Color(0xFF172638),
                surfaceVariant = Color(0xFFEDF1F5),
                onSurfaceVariant = Color(0xFF627287),
                surfaceContainerLowest = Color.White,
                surfaceContainerLow = Color(0xFFF9FAFC),
                surfaceContainer = Color(0xFFF0F3F7),
                surfaceContainerHigh = Color(0xFFEAF0F4),
                surfaceContainerHighest = Color(0xFFE3EAF1),
                surfaceDim = Color(0xFFE7EDF3),
                surfaceBright = Color.White,
                outline = Color(0xFF8190A1),
                outlineVariant = Color(0xFFDFE6EE),
                inverseSurface = Color(0xFF233246),
                inverseOnSurface = Color(0xFFF1F5FA),
                inversePrimary = Color(0xFF79E4C1),
                error = Color(0xFFB14143),
                errorContainer = Color(0xFFFFEDEC),
                onErrorContainer = Color(0xFF842F32),
            )
    @Composable
    fun animated(color: Color, name: String) =
        animateColorAsState(color, tween(320), label = name).value
    val colors =
        target.copy(
            background = animated(target.background, "background"),
            surface = animated(target.surface, "surface"),
            primary = animated(target.primary, "primary"),
            onPrimary = animated(target.onPrimary, "onPrimary"),
            primaryContainer = animated(target.primaryContainer, "primaryContainer"),
            onPrimaryContainer = animated(target.onPrimaryContainer, "onPrimaryContainer"),
            onBackground = animated(target.onBackground, "onBackground"),
            onSurface = animated(target.onSurface, "onSurface"),
            surfaceContainerLow = animated(target.surfaceContainerLow, "surfaceLow"),
            surfaceContainer = animated(target.surfaceContainer, "surfaceContainer"),
            surfaceContainerHigh = animated(target.surfaceContainerHigh, "surfaceHigh"),
            surfaceVariant = animated(target.surfaceVariant, "surfaceVariant"),
            onSurfaceVariant = animated(target.onSurfaceVariant, "mutedText"),
            outlineVariant = animated(target.outlineVariant, "outline"),
        )
    MaterialTheme(
        colorScheme = colors,
        typography =
            Typography(
                displayLarge =
                    TextStyle(
                        fontSize = 42.sp,
                        lineHeight = 48.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-1.8).sp,
                        fontFeatureSettings = "tnum",
                    ),
                headlineLarge =
                    TextStyle(
                        fontSize = 32.sp,
                        lineHeight = 38.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-1).sp,
                    ),
                headlineMedium =
                    TextStyle(
                        fontSize = 26.sp,
                        lineHeight = 32.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-0.6).sp,
                    ),
                headlineSmall =
                    TextStyle(
                        fontSize = 23.sp,
                        lineHeight = 29.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-0.5).sp,
                    ),
                titleLarge =
                    TextStyle(
                        fontSize = 21.sp,
                        lineHeight = 27.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-0.4).sp,
                    ),
                titleMedium =
                    TextStyle(
                        fontSize = 16.sp,
                        lineHeight = 23.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
                titleSmall =
                    TextStyle(
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
                bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
                bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
                labelLarge =
                    TextStyle(
                        fontSize = 13.sp,
                        lineHeight = 19.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
                labelMedium =
                    TextStyle(fontSize = 11.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
                labelSmall =
                    TextStyle(
                        fontSize = 10.sp,
                        lineHeight = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.8.sp,
                    ),
            ),
        shapes =
            Shapes(
                extraSmall = RoundedCornerShape(8.dp),
                small = RoundedCornerShape(12.dp),
                medium = RoundedCornerShape(16.dp),
                large = RoundedCornerShape(24.dp),
                extraLarge = RoundedCornerShape(30.dp),
            ),
        content = content,
    )
}

@Composable
fun IconTile(
    icon: ImageVector,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    Box(
        modifier.size(42.dp).clip(RoundedCornerShape(14.dp)).background(color.copy(alpha = .12f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(21.dp), tint = color)
    }
}

@Composable
fun PersonAvatar(
    name: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    Box(
        modifier.size(44.dp).clip(CircleShape).background(color.copy(alpha = .13f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name
                .split(" ")
                .filter { it.isNotBlank() }
                .take(2)
                .joinToString("") { it.first().uppercase() },
            style = MaterialTheme.typography.titleSmall,
            color = color,
        )
    }
}

@Composable
fun StatusPill(
    text: String,
    color: Color = MaterialTheme.colorScheme.primary,
    icon: ImageVector? = null,
) {
    Row(
        Modifier.clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = .11f))
            .padding(horizontal = 9.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (icon != null) Icon(icon, null, Modifier.size(12.dp), tint = color)
        Text(text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

@Composable
fun BalanceHero(
    amount: Long,
    label: String,
    subtitle: String,
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(26.dp))
            .background(
                Brush.linearGradient(
                    listOf(colors.primaryContainer, colors.primaryContainer.copy(alpha = .55f))
                )
            )
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                Icons.Outlined.AccountBalanceWallet,
                null,
                Modifier.size(16.dp),
                colors.onPrimaryContainer.copy(alpha = .7f),
            )
            Text(
                label,
                style = MaterialTheme.typography.labelLarge,
                color = colors.onPrimaryContainer.copy(alpha = .75f),
            )
        }
        AnimatedContent(
            amount,
            transitionSpec = {
                (fadeIn(tween(180)) + slideInVertically(tween(220)) { it / 5 }) togetherWith
                    fadeOut(tween(120))
            },
            label = "balance change",
        ) { value ->
            Text(
                money(value),
                style = MaterialTheme.typography.displayLarge,
                color = colors.onPrimaryContainer,
            )
        }
        Text(
            subtitle,
            style = MaterialTheme.typography.bodySmall,
            color = colors.onPrimaryContainer.copy(alpha = .72f),
        )
        content()
    }
}

@Composable
fun CleanTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isError: Boolean = false,
    label: @Composable (() -> Unit)? = null,
    placeholder: @Composable (() -> Unit)? = null,
    leadingIcon: @Composable (() -> Unit)? = null,
    trailingIcon: @Composable (() -> Unit)? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    singleLine: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    shape: Shape = MaterialTheme.shapes.medium,
) {
    OutlinedTextField(
        value,
        onValueChange,
        modifier,
        enabled = enabled,
        isError = isError,
        label = label,
        placeholder = placeholder,
        leadingIcon = leadingIcon,
        trailingIcon = trailingIcon,
        keyboardOptions = keyboardOptions,
        singleLine = singleLine,
        minLines = minLines,
        maxLines = maxLines,
        shape = shape,
        colors =
            OutlinedTextFieldDefaults.colors(
                unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
                unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                unfocusedLabelColor = MaterialTheme.colorScheme.onSurfaceVariant,
            ),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SheetDialog(
    onDismissRequest: () -> Unit,
    title: @Composable () -> Unit,
    text: @Composable () -> Unit,
    confirmButton: @Composable () -> Unit,
    dismissButton: @Composable (() -> Unit)? = null,
) {
    ModalBottomSheet(
        onDismissRequest,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
    ) {
        Column(
            Modifier.fillMaxWidth()
                .heightIn(max = LocalConfiguration.current.screenHeightDp.dp * .86f)
                .imePadding()
        ) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 22.dp)) {
                ProvideTextStyle(MaterialTheme.typography.headlineSmall) { title() }
            }
            Box(Modifier.weight(1f, fill = false).fillMaxWidth().padding(horizontal = 24.dp)) {
                text()
            }
            HorizontalDivider(
                Modifier.padding(top = 20.dp),
                color = MaterialTheme.colorScheme.outlineVariant,
            )
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                dismissButton?.invoke()
                Spacer(Modifier.width(10.dp))
                confirmButton()
            }
        }
    }
}

@Composable
fun WorkspaceNavigation(page: String, navigate: (String) -> Unit) {
    val primary = listOf("assistant", "review", "people", "trips", "more")
    val selectedPage = if (page in primary) page else "more"
    Surface(color = MaterialTheme.colorScheme.background) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .6f))
            Row(
                Modifier.fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = 10.dp, vertical = 6.dp)
            ) {
                listOf(
                        Triple("assistant", "Assistant", Icons.Outlined.AutoAwesome),
                        Triple("review", "Review", Icons.Outlined.ReceiptLong),
                        Triple("people", "People", Icons.Outlined.PeopleOutline),
                        Triple("trips", "Trips", Icons.Outlined.Luggage),
                        Triple("more", "More", Icons.Outlined.GridView),
                    )
                    .forEach { (key, label, icon) ->
                        val selected = selectedPage == key
                        val scale by
                            animateFloatAsState(
                                if (selected) 1f else .9f,
                                spring(dampingRatio = .65f, stiffness = 450f),
                                label = "navigation scale",
                            )
                        val fill by
                            animateColorAsState(
                                if (selected) MaterialTheme.colorScheme.primaryContainer
                                else Color.Transparent,
                                tween(220),
                                label = "navigation fill",
                            )
                        val tint by
                            animateColorAsState(
                                if (selected) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                                tween(220),
                                label = "navigation tint",
                            )
                        Column(
                            Modifier.weight(1f)
                                .selectable(selected, role = Role.Tab, onClick = { navigate(key) })
                                .padding(vertical = 3.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Box(
                                Modifier.size(width = 48.dp, height = 32.dp)
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(fill),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(icon, null, Modifier.size(21.dp).scale(scale), tint)
                            }
                            Text(label, style = MaterialTheme.typography.labelMedium, color = tint)
                        }
                    }
            }
        }
    }
}

@Composable
fun SettingsAction(icon: ImageVector, label: String, onClick: () -> Unit, subtitle: String = "") {
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 12.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, Modifier.size(21.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            if (subtitle.isNotBlank())
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
        }
        Icon(
            Icons.Outlined.ChevronRight,
            null,
            Modifier.size(17.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

fun friendlyDate(value: String): String = runCatching {
    LocalDate.parse(value).format(DateTimeFormatter.ofPattern("MMM d", Locale.getDefault()))
}
    .getOrDefault(value)

fun merchantName(s: WorkspaceState, t: JsonObject): String {
    val aliases =
        s.aliases.filter { normalized(t.s("description")).contains(normalized(it.s("pattern"))) }
    return aliases.map { it.s("name") }.distinct().singleOrNull()
        ?: t.s("description").let { name ->
            if (name == name.uppercase() && name.any { it.isLetter() })
                name.split(" ").joinToString(" ") {
                    if (it.length <= 3) it else it.lowercase().replaceFirstChar(Char::titlecase)
                }
            else name
        }
}

fun categoryIcon(category: String): ImageVector =
    when {
        category.contains("Food", true) -> Icons.Outlined.Restaurant
        category.contains("Grocer", true) -> Icons.Outlined.ShoppingBasket
        category.contains("Travel", true) -> Icons.Outlined.Flight
        category.contains("Gas", true) -> Icons.Outlined.LocalGasStation
        category.contains("Shop", true) -> Icons.Outlined.ShoppingBag
        else -> Icons.Outlined.ReceiptLong
    }
