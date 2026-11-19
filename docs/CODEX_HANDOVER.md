# VacuumTube fork — Codex handover

**Checked:** 2026-11-19. **Repo:** `watchinthewheels20/VacuumTube` (public fork of `shy1132/VacuumTube`), `main` at `0ec63b014288`. **Stack:** Electron/Node.js YouTube Leanback/TV wrapper. **Current package line:** 2.0.x, `package.json` v2.0.1 at handover. **Artifact:** Windows **x64** `VacuumTube-Setup.exe` NSIS wizard; **not 32-bit x86**. Earlier discussion said x86 generically, but the actual implemented fork CI is x64; changing architecture requires explicit decision.

## Core reason for this fork

The user's media remote historically continued to send play/pause into VacuumTube **even when another app had focus**. Preserve and test the **focus-aware Media Session guard**: all applicable hardware/system media events, particularly play/pause, must be ignored while VacuumTube is unfocused or minimised, and work again when focus returns. **Do not confuse it with Pause on Blur**: when that optional preference is off, video may keep playing when unfocused even though remote commands are ignored; when on, losing focus pauses playback.

Keep existing YouTube Leanback experience, TV-style input, keyboard/gamepad support, settings overlay, playback and window lifecycle. Don't intercept media remote globally or disrupt focused-app controls. Respect the Electron/renderer and privileged IPC security boundary; do not introduce unvalidated APIs. Preserve user settings/session, styles and update behaviour at `%APPDATA%\VacuumTube\`, especially `config.json` and migration from legacy `state.json`.

## Relevant implementation and workflow

Read `AGENTS.md` first; then `package.json` and lockfile, `src/index.js`, `src/preload/index.js`, `src/preload/modules/media-session-focus.js`, `src/preload/modules/pause-on-blur.js`, `src/preload/util/controller.js`, `src/config.js`, `src/updater.js` and the affected tests in `test/`. README partly describes **upstream** downloads/platforms and must not be treated as this fork's release promise.

```bash
npm ci
npm test
npm start
```

On Windows build an installer with `npx electron-builder --win nsis --x64 --publish never`. The repository CI **VacuumTube Windows installer** in `.github/workflows/windows-dev-build.yml` uses Windows + Node 22, runs tests, builds and checks `dist/VacuumTube-Setup.exe`, `.blockmap` and `latest.yml`. Successful `main` runs publish prerelease tags `vacuumtube-dev-<run_number>-<run_attempt>` with setup EXE, blockmap and latest.yml. Only two newest development releases are retained; save a tested installer before risky iterations. CI does **not** actually run installer-wizard/uninstall or test physical media remotes; do not imply that it does.

## Input and release acceptance

Test remote play/pause with VacuumTube focused; switch focus to another app and send play/pause; minimize, then restore; verify Pause on Blur off/on independently. Test keyboard/controller navigation, window focus/resizing and YouTube playback. Verify Windows installer wizard, chosen destination, shortcuts, uninstall and settings persistence when the environment permits. Auto-update metadata existing is **not proof** that automatic updates correctly notice same-version development builds—supply explicit installer download for each review.

Integrate reviewed changes into a consolidated `main` commit, observe completed workflow, confirm **this fork's** exact setup asset and version, and return a direct verified URL. Never substitute an upstream installer or invent a portable package. Retain MIT attribution; no major version jump without authorisation.