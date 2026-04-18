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

## Commands

### Navigation

```bash
orca goto --url <url> [--json]           # Navigate to URL, waits for page load
orca back [--json]                       # Go back in browser history
orca reload [--json]                     # Reload the current page
```

### Observation

```bash
orca snapshot [--json]                   # Accessibility tree snapshot with element refs
orca screenshot [--format <png|jpeg>] [--json]  # Viewport screenshot (base64)
```

### Interaction

```bash
orca click --element <ref> [--json]      # Click an element by ref
orca fill --element <ref> --value <text> [--json]  # Clear and fill an input
orca type --input <text> [--json]        # Type at current focus (no element targeting)
orca select --element <ref> --value <value> [--json]  # Select dropdown option
orca scroll --direction <up|down> [--amount <pixels>] [--json]  # Scroll viewport
```

### Tab Management

```bash
orca tab list [--json]                   # List open browser tabs
orca tab switch --index <n> [--json]     # Switch active tab (invalidates refs)
```

### Page Inspection

```bash
orca eval --expression <js> [--json]     # Evaluate JS in page context
```

## `fill` vs `type`

- **`fill`** targets a specific element by ref, clears its value first, then enters text. Use for form fields.
- **`type`** types at whatever currently has focus. Use for search boxes or after clicking into an input.

## Error Codes and Recovery

| Error Code | Meaning | Recovery |
|-----------|---------|----------|
| `browser_no_tab` | No browser tab is open | Open a tab in the Orca UI, or use `orca tab list` to check |
| `browser_stale_ref` | Ref is invalid (page changed since snapshot) | Run `orca snapshot` to get fresh refs |
| `browser_ref_not_found` | Ref was never assigned (typo or out of range) | Run `orca snapshot` to see available refs |
| `browser_tab_not_found` | Tab index does not exist | Run `orca tab list` to see available tabs |
| `browser_navigation_failed` | URL could not be loaded | Check URL spelling, network connectivity |
| `browser_element_not_interactable` | Element is hidden or disabled | Re-snapshot; the element may have changed state |
| `browser_eval_error` | JavaScript threw an exception | Fix the expression and retry |
| `browser_cdp_error` | Internal browser control error | DevTools may be open — close them and retry |
| `browser_debugger_detached` | Tab was closed | Run `orca tab list` to find remaining tabs |
| `browser_timeout` | Operation timed out | Page may be slow to load; retry or check network |

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

## Agent Guidance

- Always use `--json` for machine-driven use.
- Always snapshot before interacting with elements.
- After navigation (`goto`, `back`, `reload`, clicking a link), re-snapshot to get fresh refs.
- After switching tabs, re-snapshot.
- If you get `browser_stale_ref`, re-snapshot and retry with the new refs.
- Use `orca tab list` before `orca tab switch` to know which tabs exist.
- Use `orca eval` as an escape hatch for interactions not covered by other commands.
- For full IDE/worktree/terminal commands, see the `orca-cli` skill.
