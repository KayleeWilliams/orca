---
name: orca-browser
description: >
  Use the Orca browser commands to automate the built-in browser.
  Triggers: "click on", "fill the form", "take a screenshot",
  "navigate to", "interact with the page", "extract text from",
  "snapshot the page", or any task involving browser automation.
allowed-tools: Bash(orca:*)
---

# Orca Browser Automation

Use these commands when the agent needs to interact with the built-in Orca browser — navigating pages, reading page content, clicking elements, filling forms, or verifying UI state.

## Core Loop

The browser automation workflow follows a snapshot-interact-re-snapshot loop:

1. **Snapshot** the page to see interactive elements and their refs.
2. **Interact** using refs (`@e1`, `@e3`, etc.) to click, fill, or select.
3. **Re-snapshot** after interactions to see the updated page state.

```bash
orca goto --url https://example.com --json
orca snapshot --json
# Read the refs from the snapshot output
orca click --element @e3 --json
orca snapshot --json
```

## Element Refs

Refs like `@e1`, `@e5` are short identifiers assigned to interactive page elements during a snapshot. They are:

- **Assigned by snapshot**: Run `orca snapshot` to get current refs.
- **Scoped to one tab**: Refs from one tab are not valid in another.
- **Invalidated by navigation**: If the page navigates after a snapshot, refs become stale. Re-snapshot to get fresh refs.
- **Invalidated by tab switch**: Switching tabs with `orca tab switch` invalidates refs. Re-snapshot after switching.

If a ref is stale, the command returns `browser_stale_ref` — re-snapshot and retry.

## Worktree Scoping

Browser commands default to the **current worktree** — only tabs belonging to the agent's worktree are visible and targetable. Tab indices are relative to the filtered tab list.

```bash
# Default: operates on tabs in the current worktree
orca snapshot --json

# Explicitly target all worktrees (cross-worktree access)
orca snapshot --worktree all --json

# Tab indices are relative to the worktree-filtered list
orca tab list --json         # Shows tabs [0], [1], [2] for this worktree
orca tab switch --index 1 --json   # Switches to tab [1] within this worktree
```

If no tabs are open in the current worktree, commands return `browser_no_tab`.

## Commands

### Navigation

```bash
orca goto --url <url> [--json]           # Navigate to URL, waits for page load
orca back [--json]                       # Go back in browser history
orca forward [--json]                    # Go forward in browser history
orca reload [--json]                     # Reload the current page
```

### Observation

```bash
orca snapshot [--json]                   # Accessibility tree snapshot with element refs
orca screenshot [--format <png|jpeg>] [--json]  # Viewport screenshot (base64)
orca full-screenshot [--format <png|jpeg>] [--json]  # Full-page screenshot (base64)
orca pdf [--json]                        # Export page as PDF (base64)
```

### Interaction

```bash
orca click --element <ref> [--json]      # Click an element by ref
orca dblclick --element <ref> [--json]   # Double-click an element
orca fill --element <ref> --value <text> [--json]  # Clear and fill an input
orca type --input <text> [--json]        # Type at current focus (no element targeting)
orca select --element <ref> --value <value> [--json]  # Select dropdown option
orca check --element <ref> [--json]      # Check a checkbox
orca uncheck --element <ref> [--json]    # Uncheck a checkbox
orca scroll --direction <up|down> [--amount <pixels>] [--json]  # Scroll viewport
orca scrollintoview --element <ref> [--json]  # Scroll element into view
orca hover --element <ref> [--json]      # Hover over an element
orca focus --element <ref> [--json]      # Focus an element
orca drag --from <ref> --to <ref> [--json]  # Drag from one element to another
orca clear --element <ref> [--json]      # Clear an input field
orca select-all --element <ref> [--json] # Select all text in an element
orca keypress --key <key> [--json]       # Press a key (Enter, Tab, Escape, etc.)
orca upload --element <ref> --files <paths> [--json]  # Upload files to a file input
```

### Tab Management

```bash
orca tab list [--json]                   # List open browser tabs
orca tab switch --index <n> [--json]     # Switch active tab (invalidates refs)
orca tab create [--url <url>] [--json]   # Open a new browser tab
orca tab close [--index <n>] [--json]    # Close a browser tab
```

### Wait / Synchronization

Agents fail more often from bad waits than from bad selectors. Pick the right wait for the situation:

```bash
orca wait [--timeout <ms>] [--json]                        # Wait for timeout (default 1000ms)
orca wait --selector <css> [--state <visible|hidden>] [--timeout <ms>] [--json]  # Wait for element
orca wait --text <string> [--timeout <ms>] [--json]        # Wait for text to appear on page
orca wait --url <substring> [--timeout <ms>] [--json]      # Wait for URL to contain substring
orca wait --load <networkidle|load|domcontentloaded> [--timeout <ms>] [--json]   # Wait for load state
orca wait --fn <js-expression> [--timeout <ms>] [--json]   # Wait for JS condition to be truthy
```

After any page-changing action, pick one:

- Wait for specific content: `orca wait --text "Dashboard" --json`
- Wait for URL change: `orca wait --url "/dashboard" --json`
- Wait for network idle (catch-all for SPA navigation): `orca wait --load networkidle --json`
- Wait for an element: `orca wait --selector ".results" --json`

Avoid bare `orca wait --timeout 2000` except when debugging — it makes scripts slow and flaky. Condition waits default to 30000ms timeout.

### Data Extraction

```bash
orca exec --command "get text @e1" [--json]   # Get visible text of an element
orca exec --command "get html @e1" [--json]   # Get innerHTML
orca exec --command "get value @e1" [--json]  # Get input value
orca exec --command "get attr @e1 href" [--json]  # Get element attribute
orca exec --command "get title" [--json]      # Get page title
orca exec --command "get url" [--json]        # Get current URL
orca exec --command "get count .item" [--json]      # Count matching elements
```

### State Checks

```bash
orca exec --command "is visible @e1" [--json]  # Check if element is visible
orca exec --command "is enabled @e1" [--json]  # Check if element is enabled
orca exec --command "is checked @e1" [--json]  # Check if checkbox is checked
```

### Page Inspection

```bash
orca eval --expression <js> [--json]     # Evaluate JS in page context
```

### Cookie Management

```bash
orca cookie get [--url <url>] [--json]   # List cookies
orca cookie set --name <n> --value <v> [--domain <d>] [--json]  # Set a cookie
orca cookie delete --name <n> [--domain <d>] [--json]  # Delete a cookie
```

### Emulation

```bash
orca viewport --width <w> --height <h> [--scale <n>] [--mobile] [--json]
orca geolocation --latitude <lat> --longitude <lng> [--accuracy <m>] [--json]
```

### Request Interception

```bash
orca intercept enable [--patterns <list>] [--json]  # Start intercepting requests
orca intercept disable [--json]          # Stop intercepting
orca intercept list [--json]             # List paused requests
```

> **Note:** Per-request `intercept continue` and `intercept block` are not yet supported.
> They will be added once agent-browser supports per-request interception decisions.

### Console / Network Capture

```bash
orca capture start [--json]              # Start capturing console + network
orca capture stop [--json]               # Stop capturing
orca console [--limit <n>] [--json]      # Read captured console entries
orca network [--limit <n>] [--json]      # Read captured network entries
```

### Mouse Control

```bash
orca exec --command "mouse move 100 200" [--json]   # Move mouse to coordinates
orca exec --command "mouse down left" [--json]      # Press mouse button
orca exec --command "mouse up left" [--json]        # Release mouse button
orca exec --command "mouse wheel 100" [--json]      # Scroll wheel
```

### Keyboard

```bash
orca exec --command "keyboard inserttext \"text\"" [--json]  # Insert text bypassing key events
orca exec --command "keyboard type \"text\"" [--json]        # Raw keystrokes
orca exec --command "keydown Shift" [--json]                 # Hold key down
orca exec --command "keyup Shift" [--json]                   # Release key
```

### Frames (Iframes)

Iframes are auto-inlined in snapshots — refs inside iframes work transparently. For scoped interaction:

```bash
orca exec --command "frame @e3" [--json]        # Switch to iframe by ref
orca exec --command "frame \"#iframe\"" [--json] # Switch to iframe by CSS selector
orca exec --command "frame main" [--json]       # Return to main frame
```

### Semantic Locators (alternative to refs)

When refs aren't available or you want to skip a snapshot:

```bash
orca exec --command "find role button click --name \"Submit\"" [--json]
orca exec --command "find text \"Sign In\" click" [--json]
orca exec --command "find label \"Email\" fill \"user@test.com\"" [--json]
orca exec --command "find placeholder \"Search\" type \"query\"" [--json]
orca exec --command "find testid \"submit-btn\" click" [--json]
```

### Dialogs

`alert` and `beforeunload` are auto-accepted. For `confirm` and `prompt`:

```bash
orca exec --command "dialog status" [--json]        # Check for pending dialog
orca exec --command "dialog accept" [--json]        # Accept
orca exec --command "dialog accept \"text\"" [--json]  # Accept with prompt input
orca exec --command "dialog dismiss" [--json]       # Dismiss/cancel
```

### Debugging

```bash
orca exec --command "highlight @e1" [--json]     # Highlight element visually
orca exec --command "console" [--json]           # View console messages
orca exec --command "errors" [--json]            # View page errors
```

### Extended Commands (Passthrough)

```bash
orca exec --command "<agent-browser command>" [--json]
```

The `exec` command provides access to agent-browser's full command surface. Useful for commands without typed Orca handlers:

```bash
orca exec --command "set device \"iPhone 14\"" --json   # Emulate device
orca exec --command "set offline on" --json             # Toggle offline mode
orca exec --command "set media dark" --json             # Emulate color scheme
orca exec --command "network requests" --json           # View tracked network requests
orca exec --command "help" --json                       # See all available commands
```

**Important:** Do not use `orca exec --command "tab ..."` for tab management. Use `orca tab list/create/close/switch` instead — those operate at the Orca level and keep the UI synchronized.

## `fill` vs `type`

- **`fill`** targets a specific element by ref, clears its value first, then enters text. Use for form fields.
- **`type`** types at whatever currently has focus. Use for search boxes or after clicking into an input.

If neither works on a custom input component, try:

```bash
orca focus --element @e1 --json
orca exec --command "keyboard inserttext \"text\"" --json   # bypasses key events
```

## Error Codes and Recovery

| Error Code | Meaning | Recovery |
|-----------|---------|----------|
| `browser_no_tab` | No browser tab is open in this worktree | Open a tab, or use `--worktree all` to check other worktrees |
| `browser_stale_ref` | Ref is invalid (page changed since snapshot) | Run `orca snapshot` to get fresh refs |
| `browser_tab_not_found` | Tab index does not exist | Run `orca tab list` to see available tabs |
| `browser_error` | Error from the browser automation engine | Read the message for details; common causes: element not found, navigation timeout, JS error |

## Worked Example

Agent fills a login form and verifies the dashboard loads:

```bash
# Navigate to the login page
orca goto --url https://app.example.com/login --json

# See what's on the page
orca snapshot --json
# Output includes:
#   [@e1] text input "Email"
#   [@e2] text input "Password"
#   [@e3] button "Sign In"

# Fill the form
orca fill --element @e1 --value "user@example.com" --json
orca fill --element @e2 --value "s3cret" --json

# Submit
orca click --element @e3 --json

# Verify the dashboard loaded
orca snapshot --json
# Output should show dashboard content, not the login form
```

## Troubleshooting

**"Ref not found" / `browser_stale_ref`**
Page changed since the snapshot. Run `orca snapshot --json` again, then use the new refs.

**Element exists but not in snapshot**
It may be off-screen or not yet rendered. Try:

```bash
orca scroll --direction down --amount 1000 --json
orca snapshot --json
# or wait for it:
orca wait --text "..." --json
orca snapshot --json
```

**Click does nothing / overlay swallows the click**
Modals or cookie banners may be blocking. Snapshot, find the dismiss button, click it, then re-snapshot.

**Fill/type doesn't work on a custom input**
Some components intercept key events. Use `keyboard inserttext`:

```bash
orca focus --element @e1 --json
orca exec --command "keyboard inserttext \"text\"" --json
```

**`browser_no_tab` error**
No browser tab is open in the current worktree. Open one with `orca tab create --url <url> --json`.

## Auto-Switch Worktree

Browser commands automatically activate the target worktree in the Orca UI when needed. If the agent issues a browser command targeting a worktree that isn't currently active (e.g., its webviews aren't mounted), Orca will switch to that worktree before executing the command.

This means agents don't need to manually activate a worktree before using browser commands — `tab create`, `goto`, `snapshot`, etc. will work regardless of which worktree the UI is currently showing.

## Tab Create Auto-Activation

When `orca tab create` opens a new tab, it is automatically set as the active tab for the worktree. Subsequent commands (`snapshot`, `click`, etc.) will target the newly created tab without needing an explicit `tab switch`.

## Agent Guidance

- Always use `--json` for machine-driven use.
- Always snapshot before interacting with elements.
- After navigation (`goto`, `back`, `reload`, clicking a link), re-snapshot to get fresh refs.
- After switching tabs, re-snapshot.
- If you get `browser_stale_ref`, re-snapshot and retry with the new refs.
- Use `orca tab list` before `orca tab switch` to know which tabs exist.
- Use `orca wait` to synchronize after actions that trigger async updates (form submits, SPA navigation, modals) instead of arbitrary sleeps.
- Use `orca eval` as an escape hatch for interactions not covered by other commands.
- Use `orca exec --command "help"` to discover extended commands.
- Worktree scoping is automatic — you'll only see tabs from your worktree by default.
- Tab creation auto-activates the new tab — no need for `tab switch` after `tab create`.
- Browser commands auto-switch the active worktree if needed — no manual worktree activation required.
- For full IDE/worktree/terminal commands, see the `orca-cli` skill.
