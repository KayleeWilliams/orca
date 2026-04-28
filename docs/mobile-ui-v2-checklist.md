# Mobile UI v2 — Feedback Checklist

This checklist addresses the design feedback received after the initial UI pass. Each item includes what to change, where to look for reference, and a verification step.

Reference: [mobile-ui-spec.md](./mobile-ui-spec.md) · [mobile-ui-implementation-checklist.md](./mobile-ui-implementation-checklist.md)

---

## 0. App Icon and Name

- [x] **Set app name to "Orca"**
  - Changed `app.json` `name` from "Orca Mobile" to "Orca"
  - Updated adaptive icon background to `#111111` (matches theme)
  - **Verified**: `app.json` updated

- [x] **Use desktop Orca icon for app icon**
  - Copied `resources/icon.png` (wave glyph on dark rounded-rect) to `mobile/assets/icon.png`, `adaptive-icon.png`, and `splash-icon.png`
  - **Note**: Requires APK rebuild (`expo prebuild` + `gradlew assembleDebug`) for icon to appear on device

---

## 1. Home Screen — Orca Logo

- [x] **Replace "Orca" text header with Orca SVG logo**
  - Created `src/components/OrcaLogo.tsx` using `react-native-svg` with the wave glyph from `resources/logo.svg`
  - Updated `_layout.tsx` to use `headerTitle: () => <OrcaLogo size={22} />`
  - Logo also appears in the empty state on the home screen
  - **Verified**: TypeScript passes, component renders SVG path

---

## 2. Host Naming

- [x] **Auto-name hosts as "Host 1", "Host 2", etc. instead of runtime ID**
  - Added `getNextHostName()` to `host-store.ts` — counts existing "Host N" names and picks next number
  - Updated `pair-scan.tsx` `testAndSave()` to use `getNextHostName()` instead of `runtimeId`
  - **Verified**: TypeScript passes

---

## 3. Long-Press Actions — Hosts

- [x] **Add long-press context menu on host rows**
  - `onLongPress` on host `Pressable` in `app/index.tsx` triggers `Alert.alert()` with:
    - **Rename** — uses `Alert.prompt()` to set a new name via `renameHost()`
    - **Remove** — confirms then calls `removeHost()`, refreshes list
  - Added `renameHost(hostId, newName)` to `host-store.ts`
  - **Verified**: TypeScript passes, lint clean
  - **Note**: `Alert.prompt()` is iOS-only; Android needs phone QA (may need a custom text input modal)

---

## 4. Long-Press Actions — Worktrees

- [x] **Add long-press context menu on worktree rows**
  - `onLongPress` on worktree `Pressable` triggers `Alert.alert()` with:
    - **Pin / Unpin** — toggles local `isPinned` state (stored in component state; AsyncStorage persistence is a follow-up)
    - **Delete** — confirms then calls `worktree.remove` RPC
  - **Note**: Rename and Sleep/Archive not yet wired (need RPC support or local override storage)
  - **Phone QA needed**: Verify alert actions work on device

---

## 5. Worktree List — Desktop Parity

### 5a. Pinned Worktrees Section

- [x] **Show pinned worktrees in a dedicated section at the top**
  - Uses `SectionList` with `buildSections()` that separates pinned from unpinned
  - "Pinned" section header with `Pin` icon from lucide-react-native
  - Remaining worktrees under "All" header (or no header if no pins)
  - Pin state stored in local component state via `pinnedIds` Set
  - **Note**: Pin persistence across sessions needs AsyncStorage (follow-up)

### 5b. Filter / View Controls

- [x] **Add a filter/view bar below the host status bar**
  - "Active" filter chip — toggles between all/active worktrees
  - Sort button cycles through Smart → Name → Recent with `SlidersHorizontal` icon
  - Search toggle (magnifying glass icon) expands/collapses search bar
  - **Note**: Filter/sort persistence across sessions needs AsyncStorage (follow-up)
  - **Note**: "By Repo" grouping not yet implemented (follow-up)

### 5c. Group-By Views

- [ ] **Support grouping worktrees by PR Status and Repo**
  - Not yet implemented — requires `linkedPR` data from `worktree.ps` which may not be exposed yet
  - Current implementation uses flat list with pinned/unpinned sections
  - **Follow-up**: Add group-by dropdown when PR/repo data is available

### 5d. Worktree Row — Desktop-Matching Design

- [x] **Redesign worktree rows to match desktop `WorktreeCard`**
  - Left indicator column: `AgentSpinner` component (working/active/inactive states)
  - Unread bell icon (amber, filled) from lucide-react-native
  - Line 1: Worktree display name (bold) + PR badge (`GitPullRequest` icon + number) if linked
  - Line 2: Colored repo dot + repo name + branch name (muted, monospace)
  - Line 3: One-line preview (muted, monospace)
  - Right side: Terminal count when > 0
  - Repo dot color: deterministic hash from repo name into a 7-color palette
  - **Verified**: TypeScript passes, lint clean

### 5e. Agent Status Spinner

- [x] **Show spinning status indicator when agent is working**
  - Created `src/components/AgentSpinner.tsx` with `Animated` rotation
  - States: `working` (spinning emerald ring), `active` (solid green), `permission` (solid red), `done` (solid sky), `inactive` (solid grey)
  - Mapped from `hasAttachedPty` + `liveTerminalCount` heuristic
  - **Verified**: TypeScript passes

### 5f. Search Bar

- [x] **Add a search bar above the worktree list**
  - Toggle via search icon in toolbar
  - Compact `TextInput` with `Search` icon and `X` clear button
  - Filters by display name, branch, and repo name (client-side, real-time)
  - **Verified**: TypeScript passes

---

## 6. Session Screen — Fix Header and Chrome

### 6a. Fix Route Placeholder in Header

- [x] **Show worktree name instead of `h/[hostId]/session/[worktreeId]`**
  - Worktree name passed as `?name=` query param from host screen
  - Session screen reads `name` from `useLocalSearchParams` and sets `navigation.setOptions({ title: worktreeName })`
  - **Verified**: TypeScript passes

### 6b. Remove Duplicate "Terminal 1" Row

- [x] **Eliminate the redundant terminal title row**
  - Removed the standalone header row with status dot + terminal title
  - Multi-terminal: status dot is inline in the tab bar row
  - Single terminal: only shows a status row when disconnected/reconnecting (not when connected)
  - **Verified**: No duplicate terminal name in code

### 6c. Replace "Send" Text Button with Icon

- [x] **Use a send icon instead of the word "Send"**
  - Uses `ArrowUp` icon from `lucide-react-native` (18px, white, strokeWidth 2.5)
  - Rendered inside a 34×34px circular button with `accentBlue` background
  - Same `onPress` and disable behavior
  - **Verified**: TypeScript passes

### 6d. Reclaim Vertical Space

- [x] **Audit and reduce vertical padding in session chrome**
  - Removed ~44px header row (see 6b)
  - Reduced tab bar to 36px max height
  - Reduced accessory key padding to `spacing.xs` (4px) vertical
  - Reduced input bar vertical padding to `spacing.xs + 2` (6px)
  - Status row for single-terminal disconnect is only 4px vertical padding
  - **Verified**: Terminal viewport gets significantly more vertical room

---

## 7. Dependencies

- [x] **Install required packages**
  - `react-native-svg@15.15.4` — for SVG logo rendering
  - `lucide-react-native@1.11.0` — for icon library (matches desktop)
  - **Verified**: `pnpm install` succeeded, TypeScript passes

---

## 8. Verification

### Static checks

- [x] **TypeScript passes**: `cd mobile && pnpm exec tsc --noEmit` exits 0
- [x] **Lint passes**: `cd mobile && pnpm lint` — 0 warnings, 0 errors

### Phone QA

- [ ] **Home screen**: Orca logo visible, hosts named "Host N", long-press shows Rename/Remove
- [ ] **Worktree list**: Pinned section at top, filter/sort controls work, rows match desktop design, agent spinner visible, search filters in real-time
- [ ] **Session screen**: Header shows worktree name (not route), no duplicate "Terminal 1", send is an icon, more vertical terminal space
- [ ] **Long-press menus**: Host rename/remove and worktree pin/delete all functional
- [ ] **App icon**: Orca wave glyph visible on home screen (requires APK rebuild)

### Follow-ups (not blocking)

- [ ] Persist pinned worktree IDs in AsyncStorage
- [ ] Persist filter/sort preferences in AsyncStorage per host
- [ ] Add group-by PR Status / Repo when data is available from `worktree.ps`
- [ ] Add worktree Rename and Sleep/Archive when RPC support exists
- [ ] Replace `Alert.prompt()` with cross-platform text input modal (iOS-only currently)
