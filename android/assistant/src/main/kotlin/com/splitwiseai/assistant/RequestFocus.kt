package com.splitwiseai.assistant

/** Narrow only a complete, explicit equal-split command. Other requests retain every tool. */
internal fun isFocusedEqualSplit(
    text: String,
    selectedCount: Int,
    handles: Set<String>,
    categories: Set<String>,
    selectedDescriptions: List<String>,
): Boolean {
    if (selectedCount !in 1..20 || text.length > 1000) return false
    val person = "(?:@[a-z][a-z0-9_]{0,39}|me|myself)"
    val target = "(?:the selected [a-z][a-z0-9_-]*|this(?: expense)?|these expenses)"
    val pattern =
        Regex(
            "^\\s*split(?: (?<target>$target))? equally between (?<people>$person(?:(?:,\\s*(?:and )?| and )$person)*)(?:\\.\\s*category (?<category>[^.\\r\\n]+))?\\.?\\s*$",
            RegexOption.IGNORE_CASE,
        )
    val match = pattern.matchEntire(text) ?: return false
    val requestedTarget = match.groups["target"]?.value?.lowercase()
    val pluralTarget = requestedTarget in setOf(null, "these expenses", "the selected expenses")
    if (selectedCount > 1 && !pluralTarget) return false
    if (
        !pluralTarget && requestedTarget !in setOf("this", "this expense", "the selected expense")
    ) {
        val noun = requestedTarget!!.removePrefix("the selected ")
        if (
            selectedDescriptions.size != 1 ||
                !Regex("\\b${Regex.escape(noun)}\\b", RegexOption.IGNORE_CASE)
                    .containsMatchIn(selectedDescriptions.single())
        )
            return false
    }
    val category = match.groups["category"]?.value?.trim()
    if (category != null && categories.none { it.equals(category, true) }) return false
    val participants =
        Regex(person, RegexOption.IGNORE_CASE)
            .findAll(match.groups["people"]!!.value)
            .map {
                it.value.lowercase().removePrefix("@").let { value ->
                    if (value == "myself") "me" else value
                }
            }
            .toList()
    return participants.distinct().size == participants.size &&
        participants.all { name -> handles.any { it.equals(name, true) } }
}

internal val focusedSplitTools =
    setOf(
        "search_transactions",
        "lookup_context",
        "propose_split",
        "request_clarification",
        "finish_reply",
    )
