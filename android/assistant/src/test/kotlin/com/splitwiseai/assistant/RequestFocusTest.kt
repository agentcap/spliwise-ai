package com.splitwiseai.assistant

import org.junit.Assert.*
import org.junit.Test

class RequestFocusTest {
    private fun focused(
        text: String,
        count: Int = 1,
        descriptions: List<String> = listOf("CAFE lunch"),
    ) =
        isFocusedEqualSplit(
            text,
            count,
            setOf("me", "alex", "maya"),
            setOf("Food & Drink", "Groceries"),
            descriptions,
        )

    @Test
    fun clearCommandsUseTheFocusedCatalog() {
        assertTrue(
            focused(
                "Split the selected lunch equally between @me and @alex. Category Food & Drink."
            )
        )
        assertTrue(focused("Split equally between me and @alex"))
        assertTrue(focused("Split this expense equally between myself, @alex, and @maya."))
        assertTrue(
            focused(
                "Split the selected ticket equally between @alex and @maya.",
                descriptions = listOf("Train ticket"),
            )
        )
        assertTrue(focused("Split these expenses equally between me and @alex.", 3))
    }

    @Test
    fun ATargetMustMatchTheSelectedScope() {
        assertFalse(
            focused(
                "Split the selected lunch equally between me and @alex.",
                descriptions = listOf("Coffee"),
            )
        )
        assertFalse(focused("Split the selected lunch equally between me and @alex.", 2))
        assertFalse(focused("Split this expense equally between me and @alex.", 2))
        assertTrue(focused("Split these expenses equally between me and @alex.", 2))
    }

    @Test
    fun generalAndAmbiguousRequestsRetainAllTools() {
        assertFalse(focused("Split this with my friend"))
        assertFalse(focused("What does Alex owe me?"))
        assertFalse(focused("Split equally between me and @alex", 0))
        assertFalse(focused("Split equally between me and @alex", 21))
    }

    @Test
    fun OtherActionsAndMultipleIntentsRetainAllTools() {
        assertFalse(focused("Always split equally between me and @alex"))
        assertFalse(focused("Save a template: split equally between me and @alex"))
        assertFalse(focused("Split equally between me and @alex and remember Alex is my roommate"))
        assertFalse(focused("Split equally between me and @alex. Add Maya as a friend."))
        assertFalse(
            focused("Split equally between me and @alex. Category Food & Drink and save a rule")
        )
    }

    @Test
    fun UnresolvedOrRepeatedPeopleRetainAllTools() {
        assertFalse(focused("Split equally between me and @unknown"))
        assertFalse(focused("Split equally between me and Alex"))
        assertFalse(focused("Split equally between me and @me"))
    }

    @Test
    fun OtherSplitMethodsAndUnknownCategoriesRetainAllTools() {
        assertFalse(focused("Split 40/60 between me and @alex"))
        assertFalse(focused("Split equally between me and @alex. Category New category."))
    }

    @Test
    fun FocusedCatalogCannotSaveOrganizationChangesOrPayments() {
        assertTrue("propose_split" in focusedSplitTools)
        assertTrue("request_clarification" in focusedSplitTools)
        assertTrue(
            focusedSplitTools
                .intersect(
                    setOf(
                        "add_person",
                        "save_rule",
                        "save_user_fact",
                        "prepare_repayment",
                        "prepare_expense",
                        "manage_trip",
                        "save_template",
                    )
                )
                .isEmpty()
        )
    }
}
