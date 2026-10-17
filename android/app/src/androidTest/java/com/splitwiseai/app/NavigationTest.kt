package com.splitwiseai.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NavigationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun mainScreensAndEditorsOpen() {
        compose.waitUntil(20000) {
            compose.onAllNodesWithText("On-device AI").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Review", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Review expenses").assertExists()
        compose.onNodeWithText("Add expense").performClick()
        compose.onNodeWithText("Expense description").assertExists()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("People", useUnmergedTree = true).performClick()
        compose.onNodeWithText("People & balances").assertExists()
        compose.onNodeWithText("Trips", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Create trip").assertExists()
        compose.onNodeWithText("More", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Settings & on-device AI").performScrollTo().performClick()
        compose.onNodeWithText("Private, on-device AI").assertExists()
    }
}
