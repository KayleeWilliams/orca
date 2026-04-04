# Orca CLI Bundled Distribution

## Goal

Ship `orca` as a companion CLI that is bundled with the Orca desktop app.

`orca` will **not** be separately distributed on npm for the initial public release.

## Product Direction

The CLI is version-coupled to the running Orca app because it depends on the app's local runtime RPC contract.

That means the primary user story should be:

1. Install Orca desktop.
2. Register the `orca` command using the platform-native path:
   - macOS: from Orca Settings, like VS Code's shell-command install
   - Linux package builds: from package install scripts
   - Windows installer builds: from installer-managed PATH registration
3. The user can run `orca ...` from any terminal while Orca is running.

This is closer to VS Code's platform-specific model than to a standalone npm package:

- the app is the primary product
- the CLI is an app capability
- CLI installation is explicit and opt-in
- version drift between app and CLI is minimized

## UX

Add a Settings section for CLI installation, likely under Advanced or Developer.

This Settings UI is primarily for macOS and for status/help across platforms.

Suggested UX:

- Setting label: `Command line interface`
- Description: `Allow terminal tools and coding agents to interact with this running Orca app.`
- Toggle:
  - off: CLI not registered
  - on: Orca prompts to install/register `orca` where that is app-managed

When toggled on for the first time, show a modal like:

- Title: `Set up CLI to work in the terminal`
- Body: `Register "orca" in PATH to enable accessing the "orca" command anywhere from your terminal.`
- Actions:
  - `Cancel`
  - `Register`

Platform note:

- on macOS, registration may require an administrator prompt because Orca installs `/usr/local/bin/orca` as a symlink to the app-bundled launcher, following the same general pattern VS Code uses for `code`
- on Windows and Linux package builds, registration should prefer installer/package integration over post-install GUI mutation

After success:

- show the installed path
- provide `Reinstall`
- provide `Remove from PATH`
- optionally provide `Copy setup instructions`

If installation fails:

- show the exact install location
- show the exact shell snippet or manual step needed

## Distribution Model

The packaged app should contain the CLI artifact and launcher files in stable internal locations.

Registration should follow the verified VS Code model by platform:

- macOS: app-driven shell command install
- Linux package builds: package-managed symlink
- Windows installer builds: installer-managed PATH registration

Why:

- simpler macOS story
- clearer user consent where the app owns registration
- more robust Linux/Windows behavior by using package/installer hooks
- keeps the CLI tied to the installed app version

## Installation Strategy

### macOS

Follow the VS Code pattern:

- ship an app-bundled launcher script
- install `/usr/local/bin/orca` as a symlink to that launcher
- if needed, prompt for elevation explicitly from the app

This avoids shell rc editing and gives a stable command location.

### Linux

For package-managed builds, follow the VS Code pattern:

- ship an app-bundled launcher script
- install `/usr/bin/orca` from the package as a symlink to that launcher

For AppImage and other non-package-managed distributions:

- do not assume a robust global PATH install exists
- either fall back to a user-level wrapper with manual instructions
- or disable CLI install in v1 if path stability is not good enough

### Windows

Follow the VS Code pattern:

- ship `orca.cmd` and related launcher files under `<install dir>\\bin`
- let the installer add `<install dir>\\bin` to PATH
- optionally register Windows App Paths for Explorer/address bar launching

This is more robust than trying to add PATH from the running GUI app after install.

## Runtime Expectations

The bundled `orca` command remains a thin client:

- it reads Orca runtime metadata
- it connects to the local Orca runtime endpoint
- it fails clearly if Orca is not running or is incompatible

Runtime startup rules:

- ordinary `orca ...` commands do not auto-launch Orca
- `orca open` explicitly launches Orca and waits for the runtime
- the CLI must detect stale runtime metadata before trusting a local runtime
- the CLI should only proceed once it observes a healthy current runtime, not just the existence of a metadata file
- `orca open` should be idempotent and cheap when Orca is already running

Error and preflight rules:

- when the runtime is missing, ordinary commands should explicitly tell the user to run `orca open`
- `orca status --json` should be the primary preflight command for agents and scripts
- `orca status --json` should distinguish:
  - app not running
  - app starting
  - runtime reachable
  - runtime reachable but terminal graph not ready

This design does not turn `orca` into a standalone daemon or independently useful tool.
The Orca desktop app remains the runtime owner even when the CLI launches it on demand.
The Orca desktop app remains the runtime owner, and `orca open` is the explicit way to start it from the CLI.

## Compatibility Rules

Because the CLI is bundled with the app:

- CLI version should match app version
- `orca version` should report both CLI and runtime compatibility details
- incompatible runtime versions should fail with a precise error

This is one of the main reasons not to ship npm-first.

## Security Notes

Bundling the CLI with the app does not change the runtime security model.

The important properties remain:

- local-only IPC
- runtime auth token
- user-scoped metadata and endpoint permissions
- no remote network listener by default

The launcher registration should only point to the bundled CLI. It should not expose any extra background service.

## Non-Goals

For the initial version:

- no separate npm distribution
- no remote CLI-to-Orca connectivity
- no standalone daemon mode independent of the Orca app

## Recommended First Slice

1. Bundle the CLI artifact and launcher files into packaged app builds.
2. macOS: add a Settings toggle and modal for shell-command registration.
3. Linux package builds: register `/usr/bin/orca` from packaging.
4. Windows installer builds: register `<install dir>\\bin` on PATH.
5. Show install/status/help flows in Settings.

This is the smallest coherent implementation that matches the desired product story.
