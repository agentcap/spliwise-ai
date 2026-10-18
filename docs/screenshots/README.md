# README screenshots

These are screenshots of the implemented interfaces with synthetic sample data.
No personal statements, real workspace records, or credentials are included.

| File                    | Source                                                                                              | Notes                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `web-review.png`        | `tests/browser/workflow.spec.ts`, upload/duplicate/review workflow, `test-results/review-board.png` | Current webapp; synthetic Chase CSV fixture and mocked AI.                   |
| `web-overview.png`      | Same browser test, `test-results/populated-overview.png`                                            | Sample finalized expenses, repayment and date-filtered balances.             |
| `android-assistant.png` | Retained native screenshot tour, `02-assistant-confirmation.png`                                    | Real emulator UI, seeded demo conversation, ledger-backed confirmation card. |
| `android-review.png`    | Same native tour, `07-review-inbox.png`                                                             | Sample Inbox items and grouped merchants.                                    |
| `android-trips.png`     | Same native tour, `31-trips.png`                                                                    | Sample active/archived trips and shared context.                             |

The original Android captures are retained locally under
`.tools/android/ui-review-modern/raw/`; their titles and captions are recorded
in that gallery's `screenshots.json`. The tour is documented in
[Android setup](../android.md). The committed PNGs are unmodified copies; GitHub
display widths are set in the main README. Click through for full resolution.

To refresh the web screenshots in an isolated browser-test workspace:

```sh
npm run test:browser -- tests/browser/workflow.spec.ts --grep upload
```

Copy the two generated images from `test-results/` to the filenames above after
inspection. These images illustrate product behavior, not measured model output
or proof of performance on a physical phone.
