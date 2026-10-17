# Splitwise AI for Android

Native Kotlin/Compose app for Android 12 and newer, with a local SQLite ledger and on-device Gemma 4 inference. The target phone is the Android test device. The web app and phone have independent workspaces after a transfer.

## Build on this Windows / WSL computer

In Ubuntu, from `/path/to/splitwise_ai`:

```sh
python3 scripts/android-bootstrap.py
bash scripts/android-build.sh :ledger:test :assistant:test :app:lintDebug :app:assembleDebug
```

The bootstrap installs checksum-verified Microsoft OpenJDK 17, Android SDK command-line tools, API 37, Build Tools 36 and Windows USB platform tools inside ignored `.tools/android/`. No system-wide Java or Android Studio installation is required. Gradle 9.3.1 is pinned with a distribution checksum. Kotlin 2.4 is required by the inference library's dependencies. SDK installation accepts Google's SDK licenses.

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. Keep the generated debug signing key (`~/.android/debug.keystore` in this Ubuntu account) to install future builds over this one without removing its data. The APK includes ARM64 for phones and x86-64 for emulator tests. This is a signed development build for direct installation; no Play Store account is needed.

## Manual desktop testing

On Windows, double-click `Start Android App.cmd` in the project folder. The launcher starts the project Android emulator with 8 GB RAM and six virtual CPU cores, exposes host CPU acceleration through KVM, installs the current APK while keeping its data, copies the already-downloaded E4B model after checksum verification, and opens Splitwise AI. Close the emulator window when finished; use the same launcher to reopen it. Desktop and phone workspaces are independent.

Use the mouse to tap controls and drag the expense list, and type with the desktop keyboard. This is the native Android app with a persistent local ledger. The 66-screen gallery is a separate screenshot reference. An empty workspace is expected on the first desktop run.

Try adding Alex with handle `alex`, adding a $12 lunch, selecting it in Review, and choosing **Give one instruction**. Ask to split it equally between yourself and `@alex`. Confirm the $6/$6 split, then finalize separately. Alex should owe $6. Record a $5 repayment to leave $1 outstanding. All normal editors, imports, reports, settings, and workspace backup/restore are available.

The emulator uses CPU inference because its software graphics driver is unsuitable for model GPU execution. Phone builds continue to prefer GPU and fall back to CPU. Desktop emulator latency is not a Galaxy benchmark. The launcher copies a locally downloaded model without another network download; otherwise download E4B in the app settings. The optional Linux window libraries stay in `.tools/android/gui-libs/`. It runs only the emulator process with the KVM group on WSL and does not change account membership. The project toolchain, system image, WSL GUI support and KVM must already be installed. Emulator startup logs are under `.tools/android/desktop/`.

For the faster equal-split path, select the expense first and use **Give one instruction**, then ask `Split equally between me and @alex`. Existing people and categories are required. The model receives the selected expense directly and a smaller set of relevant tools. Other split methods, ambiguous targets and requests containing additional actions keep the full tool catalog. Confirmation and separate finalization still apply. Model startup and general chat can take longer; see [measured performance and limits](android-performance.md).

An opt-in native inference check uses a separate synthetic ledger and leaves the manual workspace untouched:

```sh
.tools/android/sdk/platform-tools/adb -e shell am instrument -w \
  -e desktopAiSmoke true -e class com.splitwiseai.app.DesktopModelTest \
  com.splitwiseai.app.test/androidx.test.runner.AndroidJUnitRunner
```

## Install on your Android test device

1. On the phone, open **Settings → About phone → Software information**, tap **Build number** seven times and enable **Developer options → USB debugging**.
2. Connect the unlocked phone with a USB data cable. Accept its **Allow USB debugging** prompt.
3. From PowerShell in this project:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\android-install.ps1
```

The installer updates the app while retaining its data, then opens it. With multiple devices, add `-DeviceSerial SERIAL`. You can also copy the APK to the phone and open it there to install it.

## Set up offline AI

Open **More → Settings**. Download **Gemma 4 E4B** (3.66 GB), then select it. E4B is the default because it handled the action tests more consistently. E2B (2.59 GB) is an optional smaller model and may need more specific instructions. Downloads normally require Wi-Fi, with an explicit mobile-data option. Pause/resume is supported and a SHA-256 checksum is verified before the model can run. Model revisions, exact byte sizes and checksums are pinned in `android/app/src/main/assets/models.json`.

After the download, turn on airplane mode to test chat and split processing. The app prefers GPU execution and falls back to CPU if GPU initialization fails. Model loading and generation happen away from the UI thread. Device speed, memory use and temperature vary; desktop inference checks are not phone benchmarks.

AI-generated expense changes first appear as confirmation cards. **Confirm changes** prepares the split for review; **Finalize splits** updates balances. Rules, facts, templates and trip setup save automatically with action receipts and Undo. AI cannot finalize or reopen expenses. Manual import, review, splitting and reporting work without a downloaded model.

For a first phone test in an empty workspace, add a person with an @handle and a $12 cash lunch. Download the model, enable airplane mode, select the lunch and ask to split it equally with that person. Confirm the proposed split, then finalize it: the person's balance should become $6. Record a $5 repayment and check the remaining $1. Undo and full workspace backup are available throughout. Test GPU speed and longer sessions on the phone itself; the emulator and desktop model runner do not establish Galaxy performance.

## Transfer your existing workspace

1. In the web app, choose **Settings → Download full workspace** to obtain `splitwise-ai-workspace.sqlite`.
2. Copy that file to the phone.
3. In Android, open **More → Settings → Restore workspace** and select it.
4. Review record counts and the outstanding balance, then confirm the replacement.

Restore preserves finalized splits, people, repayments, rules, trips, receipts, conversation and undo history. Unfinished jobs become interrupted and require explicit resume. A recovery copy of the previous phone workspace can be shared from Settings. Newer, incompatible or corrupt databases are rejected before replacement.

Use **Full workspace backup** regularly. Android cloud backup and automatic device transfer are disabled for the private ledger and downloaded models. Uninstalling the app removes its private data. CSV/transaction/rule exports contain only their stated records; full workspace backup is the complete recovery format. Browser-only preferences such as saved views do not exist in the web SQLite export; create them again on the phone.

## Verification

See [completed checks and device-testing limits](android-verification.md).

```sh
# Regenerate synthetic expected results using the existing web ledger.
.tools/node/bin/node --import tsx scripts/android-fixtures.ts
bash scripts/android-build.sh :ledger:test :assistant:test :app:lintDebug :app:assembleDebug

# Android instrumentation tests (an authorized device or emulator must be connected).
bash scripts/android-build.sh :app:connectedDebugAndroidTest
```

Tests cover financial parity, import occurrence counts, rounding, refunds, credits, scoped context, stale and duplicate actions, separate confirmation/finalization, Undo and database restoration. Instrumentation storage tests use isolated temporary workspaces. Navigation tests open screens and forms without entering records.

For an optional local emulator, install `emulator` and `system-images;android-36;google_apis;x86_64` with the project SDK manager, then run `bash scripts/android-emulator.sh`. On WSL without usable KVM, run with `ANDROID_TEST_ACCEL=off`; software startup is substantially slower. Use the Windows platform tools for a USB phone and the WSL platform tools for this emulator.

For real-model evaluation using synthetic data on this computer:

```sh
python3 scripts/android-eval-runtime.py
python3 scripts/android-download-model.py e2b e4b
bash scripts/android-build.sh :model-check:installDist
JAVA_HOME="$PWD/.tools/android/jdk21" android/model-check/build/install/model-check/bin/model-check \
  "$PWD" "$PWD/.tools/android/models/gemma-4-E4B-it.litertlm"
```

The `assistant` module is shared between the Android runtime and this desktop harness. The desktop harness needs Java 21 because of the JVM inference artifact; Android builds continue using Java 17. Replacing E4B's filename with E2B's checks the smaller model. Evaluation prints per-scenario timings and validates tool actions against the real ledger; it never reads personal workspace files. A model can ask for clarification or fail to prepare an action; use the manual editors when needed. Persisted change confirmations come from validated ledger actions, so a model reply cannot fabricate a successful save.

## Screenshot review

The opt-in `ScreenshotTour` captures 66 real Compose pages and dialogs using an isolated application context and a synthetic ledger. Its conversation and processing-status content are samples. Ordinary instrumentation runs skip visual captures unless explicitly enabled.

With the project emulator running:

```sh
bash scripts/android-build.sh :app:assembleDebug :app:assembleDebugAndroidTest
.tools/android/sdk/platform-tools/adb -e install -r android/app/build/outputs/apk/debug/app-debug.apk
.tools/android/sdk/platform-tools/adb -e install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
.tools/android/sdk/platform-tools/adb -e shell am instrument -w -e captureUi true \
  -e screenshotDir ui-review-modern \
  -e class com.splitwiseai.app.ScreenshotTour#captureScreensForFeedback \
  com.splitwiseai.app.test/androidx.test.runner.AndroidJUnitRunner
# Check for OK (1 test), then collect the images.
mkdir -p .tools/android/ui-review-modern/raw
.tools/android/sdk/platform-tools/adb -e pull \
  /sdcard/Android/data/com.splitwiseai.app/files/ui-review-modern/. .tools/android/ui-review-modern/raw
.tools/node/bin/node scripts/android-gallery.mjs .tools/android/ui-review-modern
python3 -m http.server 4175 --bind 127.0.0.1 --directory .tools/android/ui-review-modern
```

Open `http://127.0.0.1:4175/` for the numbered, searchable gallery. Individual PNGs, contact sheets and the portable HTML gallery are kept under `.tools/android/ui-review-modern/`. The earlier screenshots remain under `.tools/android/ui-review/`.

For a motion recording, start Android's `screenrecord` on the emulator, then run the same instrumentation command with `-e captureMotion true -e class com.splitwiseai.app.ScreenshotTour#captureMotionForFeedback`. This opt-in test advances Compose frames in real time through navigation, filters, person details, theme switching and the expense sheet. A `motion-preview.mp4` and `motion-poster.png` in the gallery directory are automatically included by the gallery builder.
