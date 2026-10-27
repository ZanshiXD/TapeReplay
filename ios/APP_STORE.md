# Publishing Tape Replay on the App Store

A GitHub Actions workflow (`.github/workflows/ios-app-store.yml`) does the Mac part for you on a free GitHub macOS
machine: it generates an Xcode project from `ios/AppStore/project.yml`, builds the app with the current Xcode,
signs it for the App Store with your API key, and uploads it to App Store Connect. You do the account steps once.

## 1. Apple: once

1. **Join the Apple Developer Program** ($99 a year) at developer.apple.com/programs. Your current sign-in is on
   free provisioning, which cannot publish.
2. **Make an API key that can sign for the App Store.** App Store Connect > Users and Access > Integrations >
   App Store Connect API > Team Keys > **+**, role **Admin** (creating App Store signing certificates needs it).
   Download the `.p8` (only once), and note its **Key ID** and the **Issuer ID** above the list.
3. **Find your Team ID:** developer.apple.com/account > Membership details (10 characters).
4. **Register the app ID:** Certificates, Identifiers & Profiles > Identifiers > **+** > App IDs > App, bundle ID
   `com.kuta.tapereplay` (explicit), no extra capabilities.
5. **Create the app:** App Store Connect > Apps > **+** > New App: platform iOS, name, language, bundle ID
   `com.kuta.tapereplay`, a SKU (any text, e.g. `tapereplay`).

## 2. GitHub: once

1. **Install Git for Windows** (git-scm.com), and sign in to github.com.
2. **Create a private repository** on github.com (e.g. `tape-replay`), empty (no README).
3. **Push this folder** from a terminal opened in this project folder (the one holding `tape-replay.html`):

   ```bash
   git init -b main
   git add .
   git commit -m "Tape Replay"
   git remote add origin https://github.com/<you>/tape-replay.git
   git push -u origin main
   ```

   `.gitignore` keeps out real market data (`.dbn`, `.tapeseries`, `desktop/data/`), build output and keys.
4. **Add four secrets:** the repository > Settings > Secrets and variables > Actions > New repository secret:

   | Secret | Value |
   | --- | --- |
   | `ASC_KEY_ID` | the API key's Key ID |
   | `ASC_ISSUER_ID` | the Issuer ID |
   | `ASC_KEY_P8` | the whole text of `AuthKey_<KeyID>.p8` (open it in Notepad, copy everything) |
   | `APPLE_TEAM_ID` | your Team ID |

## 3. Each release

1. Repository > **Actions** > **iOS App Store** > **Run workflow**, type the version (e.g. `1.0.0`), Run.
   (Or push a tag: `git tag ios-v1.0.0` then `git push --tags`.) It takes about 10 to 20 minutes.
2. When it is green, the build appears in **App Store Connect > TestFlight** after Apple processes it. Install it
   with the TestFlight app on your phone to check it.
3. Fill in the App Store page: description, keywords, support URL, **privacy policy URL**, privacy answers
   ("Data Not Collected"), age rating, screenshots (6.9-inch iPhone and 13-inch iPad), then pick the build and
   **Submit for Review**.

Build numbers come from the workflow's run number, so every upload is higher than the last. After changing
`tape-replay.html`, run `python3 ios/sync_web.py` and commit before releasing.

## Before review

- The prop presets are named "L Flex 25K / 50K", not after the firm: another company's name in the app can be
  rejected as a trademark problem (guideline 5.2). Keep the store description free of firm names too.
- The description and screenshots should show a full app (replays, orders, prop simulation, imports), so it is not
  taken for a website in a wrapper (guideline 4.2).
- Never commit or bundle real Databento data; the app ships generated practice data.

## If the workflow fails

Open the failed step's log. Common causes: a missing secret (the "Check the secrets" step names it), an API key
without the Admin role ("No signing certificate"), the bundle ID not registered or no app created in App Store
Connect, or a version already approved (raise the version).
