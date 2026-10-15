# Holocene Auto: the iteration loop

Edit Agent Pad (web) or the Kotlin host and see it on the Honda head-unit simulator
(`HOLOC_9_Honda_API33`, `emulator-5554`) in seconds. Run everything from the repo root.

## The 60-second loop

```bash
mise run auto:sim      # once: opens the simulator window (quick-boot, ~6s after the first run)
mise run pad:dev       # web edits: Vite HMR inside the app's WebView; Ctrl-C when done
mise run auto:dev      # Kotlin edits: build debug APK, install, restart the app (~5s)
mise run auto:dev --logs --grant-mic   # same, tail filtered logcat, skip the mic prompt
mise run pad:build     # ship Agent Pad: nginx serves apps/agent-pad/dist, so this IS production
mise run auto:sim:stop # quit the simulator (saves the quick-boot snapshot)
```

- `pad:dev` starts Vite on `127.0.0.1:5190` (`PAD_DEV_PORT` overrides), runs
  `adb reverse tcp:5190 tcp:5190`, and launches the debug app with the intent extra
  `sh.delo.holocene.extra.PAD_URL=http://localhost:5190/`. The tab bar shows a yellow
  `DEV http://localhost:5190/` marker while the dev URL is active; no marker means production.
  `/upload` is proxied to `https://agent-pad.delo.sh`, so recording and replies work end to end.
  Ctrl-C stops Vite and removes the reverse. Entry-file edits (`main.tsx`) trigger a full page
  reload; component edits hot-swap.
- `auto:dev` always relaunches without the extra, so it returns the app to production Agent Pad.
- `auto:sim --headless` adds `-no-window` for unattended runs.

## DevTools

Open `chrome://inspect/#devices` on the host and inspect the Agent Pad WebView
(`webview_devtools_remote_<pid>`). Remote debugging is enabled only in debuggable builds.

## Microphone

The emulator starts with host mic passthrough OFF (the guest records flat dither until it is
turned on). `auto:sim` runs `adb -s emulator-5554 emu avd hostmicon` after boot, and the AVD has
`hw.audioInput=yes`. Toggle by hand with `emu avd hostmicoff` / `hostmicon`. Verified by the diagnostic mic probe: RMS ~5
off, RMS 25-70 with room noise on. Headless runs leave it off.

## What is debug-only

Everything above the production policy is gated on `FLAG_DEBUGGABLE`, never on a build constant:

- `PAD_URL` is honored only for `http://localhost:<port>/` or `http://127.0.0.1:<port>/`
  (`AgentPadPolicy.devPadUrlOrNull`), is never persisted, and only that one extra origin is allowed
  for navigation and audio grants. Release builds ignore the extra.
- Cleartext to `localhost`/`127.0.0.1` comes from `app/src/debug/` only; the release manifest is untouched.
- `WebView.setWebContentsDebuggingEnabled(true)`.

## Pitfalls

- Always `adb -s emulator-5554`. A physical phone is usually on adb too; bare `adb` commands are
  ambiguous or hit the wrong device. `auto:dev` and `pad:dev` honor `ANDROID_SERIAL` but default to the simulator and refuse any non-`emulator-*` serial unless `ALLOW_PHYSICAL_DEVICE=1`; `auto:sim`/`auto:sim:stop` always target `emulator-5554`.
- `pad:dev` refuses to run unless the installed app is a debuggable build (release builds ignore the dev URL); `auto:dev` installs one.
- The app runs as Android user 10 (`am start --user 10`), not 0. The scripts read `am get-current-user`.
- Port 5173 is often taken by other projects' Vite servers, hence 5190.
- Honda "Connect the Device" dialog: tap Cancel (or tick "Do not show this again"). It covers the app after boot.
- The first mic use prompts for permission once; `auto:dev --grant-mic` pre-grants it.
- The emulator log is `${XDG_STATE_HOME:-~/.local/state}/holocene-auto/emulator.log`.
- Image acting weird (stale snapshot, wrong user state): `mise run auto:sim:stop`, then start it once by
  hand with `-wipe-data` (`~/Android/Sdk/emulator/emulator -avd HOLOC_9_Honda_API33 -port 5554 -wipe-data`),
  then use `auto:sim` again. This erases app data and the saved snapshot.
- On the Wayland desktop the emulator runs through XWayland (`QT_QPA_PLATFORM=xcb`); the script finds
  Mutter's Xauthority cookie itself when launched from a shell without it.
- Do not change `versionCode`/`versionName` for dev work; releases go through `auto:release-bundle`.
