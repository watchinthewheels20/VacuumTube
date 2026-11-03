# AGENTS.md — repository-specific development contract

> Follow this file when developing this fork. It is a living repository contract, not a replacement for inspecting the current source, tests, and CI configuration. Update it when a verified project decision changes.

## Repository identity

- Application: **VacuumTube** (a fork of the Electron wrapper for YouTube Leanback / YouTube for TV).
- Source repository: **watchinthewheels20/VacuumTube**; upstream project: **shy1132/VacuumTube**.
- Application type: **Windows desktop (Electron/Node.js)**.
- Default branch: **main**.
- Current supported release line: **2.0.x** (`package.json` currently declares **2.0.1**). Do not make a major version jump without explicit authorization.
- User-visible delivery artifact: **`VacuumTube-Setup.exe`**, a Windows **x64 (Intel/AMD)** NSIS installer. The current fork workflow does **not** deliver 32-bit x86, ARM, portable ZIP, macOS, or Linux packages.

## Read before modifying relevant areas

- `README.md`: app overview, settings, keyboard/controller mappings, and local configuration. **Caution:** its upstream download/build links and platform list do not describe this fork's current release workflow.
- `package.json` and `package-lock.json`: app version, dependencies, Electron Builder configuration, installer identity and targets.
- `src/index.js`, `src/preload/index.js`, and `src/preload/modules/`: Electron window lifecycle, IPC, YouTube Leanback integration and input behaviour.
- `src/preload/modules/media-session-focus.js`, `src/preload/util/controller.js`, and `src/preload/modules/pause-on-blur.js`: remote/media actions, focus rules and the separate pause-on-blur setting.
- `src/config.js` and `src/updater.js`: persisted preferences, migration, install detection and update behaviour.
- `.github/workflows/windows-dev-build.yml`: **authoritative** Windows test/build/release workflow. `test/`: current automated regression tests.
- There is **no separate architecture or handover document in this repository at present**. Consult the real implementation and current GitHub state rather than assuming one exists. Add a link here if such a document is introduced.

## Stable product and engineering invariants

- Preserve the YouTube Leanback experience and existing working TV-style navigation, controller support, keyboard shortcuts, playback features and settings unless the review explicitly changes them.
- **Media remote focus rule:** hardware/system media actions (especially play/pause) must not control VacuumTube when its window is unfocused or minimized. They must work again after focus returns. Preserve the existing Media Session guard and add focused/unfocused regression tests when editing input handling.
- **Focus is not pause:** ordinary playback may continue after the window loses focus; the optional `pause_on_blur` setting independently controls whether losing focus pauses playback. Do not conflate these behaviours.
- Preserve the app/installer identity and existing-user settings unless a deliberate migration is required. On Windows, the normal user-data directory is `%APPDATA%\VacuumTube\`; preferences are stored in `config.json` (with legacy `state.json` migration). Treat session data, userstyles and user settings as persistent across installer updates.
- Protect the Electron/web-content boundary: do not introduce unvalidated privileged IPC or expose credentials, tokens, private user data or secrets in commits, workflow logs or diagnostic output. Respect the upstream MIT license and attribution.
- Target **Windows x64 NSIS** for this fork's releases. Retain the familiar interactive installation wizard, selectable destination and uninstaller. Do not silently add other platforms, architectures or portable assets.
- Do not redirect publishing or update links to the upstream repository. Currently the fork is configured in `package.json` and `src/updater.js`. Do not claim that automatic updates work merely because update metadata is published: verify version comparison, installation type and actual updater behaviour.

## Review-to-release workflow

1. Treat one user **Feedback review** as one coherent batch. Address every **Issue, Feature request, Question and Feedback** item, distinguishing code changes, answers and observations.
2. Re-read current `main`, this contract, relevant sources and tests. Use an isolated branch where feasible; make minimal changes and add targeted tests, keeping already-working behaviour intact.
3. Integrate via **one squash/consolidated commit on `main` per completed review**, when permitted. Avoid unrelated modifications and arbitrary version jumps.
4. Run `npm test` and the actual Windows build workflow. Check the completed CI run, its logs and release assets; perform installation/startup smoke testing where the environment permits. **Do not present an in-progress build as verified.**
5. For a code-change review, supply the **specific, verified** `VacuumTube-Setup.exe` release asset URL for the new commit and a concise testing checklist. Do not substitute an upstream installer or an unverified guessed download link. An AGENTS/documentation-only change does not inherently require an app update announcement.
6. Report what changed, answers to questions, tests/build results, commit or tag, any unverified runtime behaviour and known limitations. Never fabricate build status, installation testing, links or verification.

## Commands and release details

- Local setup: `npm ci`; launch during development: `npm start`; automated tests: `npm test` (Node's built-in test runner).
- Local Windows x64 packaging: `npx electron-builder --win nsis --x64 --publish never`. Run on Windows with the locked dependencies; output goes to `dist/`.
- CI workflow: **VacuumTube Windows installer** — `.github/workflows/windows-dev-build.yml`. Runs for `main` pushes, pull requests targeting `main`, and manual dispatch; uses Windows runners and Node.js 22.
- CI checks: install dependencies; run tests; build the x64 NSIS installer; check `dist/VacuumTube-Setup.exe`, `dist/VacuumTube-Setup.exe.blockmap`, and `dist/latest.yml`. **These CI checks do not currently test the actual installer wizard, uninstall or hardware remote on a desktop.**
- Publishing: successful `main` runs create GitHub **prereleases** tagged `vacuumtube-dev-<run_number>-<run_attempt>`. Release assets are the setup EXE, blockmap and `latest.yml`; CI retains only the newest **two** development releases.
- Installation/update: download the matching, verified `VacuumTube-Setup.exe` asset from **this fork's** GitHub Releases, close VacuumTube and run its installer wizard. For test builds, use the explicit release asset rather than assuming the application's automatic updater will detect a same-version development build.
- Rollback: identify the last tested-good GitHub release and download its installer **if that release is still retained**; reinstall it, checking existing preferences and playback. Because old development releases are pruned, preserve a known-good installer separately before risky iterations. Validate compatibility before changing persistent formats.

## Known regression checklist

- With the app focused, media remote **play/pause** and other supported system media actions operate normally; with another window focused or VacuumTube minimized, they do not control VacuumTube; on refocus, they operate again.
- Playback continues out of focus when **Pause on Blur** is off; when it is on, the app pauses on blur. Test keyboard navigation, gamepad input and remapped media controls for regressions.
- YouTube Leanback opens and plays videos; fullscreen/window sizing, the settings overlay and selected features continue to function.
- Existing installs retain `%APPDATA%\VacuumTube\` configuration and session state, including migration of legacy `state.json` where relevant; installing an update does not silently reset preferences.
- Build a real x64 `VacuumTube-Setup.exe`; verify its release asset and metadata; where Windows test access exists, exercise installation over an existing copy, launch, shortcuts and uninstallation. Explicitly mark hands-on installer/remote checks unverified if not performed.

## Rules for keeping this file accurate

Update this contract when release mechanics, compatibility boundaries, data persistence or architectural decisions materially change. Re-check `package.json`, CI and the latest commit before citing versions or releases. Keep version-specific examples illustrative rather than permanent rules. Never store credentials, secrets, tokens or sensitive user information in this file.
