import { defineConfig, type Project } from '@stablyai/playwright-test'
import { config as loadEnv } from 'dotenv'
import path from 'path'

// Why: load STABLY_API_KEY / STABLY_PROJECT_ID from the repo-root .env so
// `pnpm test:e2e:stably` works locally without a shell export. CI sets these
// as env vars directly (see .github/workflows/e2e.yml), and the file is
// gitignored, so no secret leaks into the repo.
loadEnv({ path: path.resolve(__dirname, '..', '.env') })

/**
 * Playwright config for Orca E2E tests.
 *
 * Run:
 *   pnpm run test:e2e              — build + run all tests (headless)
 *   pnpm run test:e2e:headful      — run with visible window (for pointer-capture tests)
 *   pnpm run test:e2e:stably       — run AI-driven specs (requires STABLY_API_KEY)
 *   SKIP_BUILD=1 pnpm run test:e2e — skip rebuild (faster iteration)
 *
 * globalSetup builds the Electron app and creates a seeded test git repo.
 * globalTeardown cleans up the test repo.
 * Tests use _electron.launch() to start the app — no manual setup needed.
 */
// Why: the `electron-stably` project drives the real UI with agent.act() and
// issues AI assertions (toMatchScreenshotPrompt, page.extract). These calls hit
// Stably's hosted API, so they require STABLY_API_KEY and would flake with a
// clear "401" for every contributor without one. Omit the project entirely when
// the key is missing so `pnpm test:e2e` stays a zero-config default for
// external contributors and fork PRs that don't have the secret.
// Why: mirror the workflow's `env.STABLY_API_KEY != ''` guard (see
// .github/workflows/e2e.yml). `Boolean(...)` would treat a whitespace-only
// value as "enabled", which would register the project and then fail
// authentication instead of quietly skipping. Trim-and-compare keeps local
// behavior identical to CI.
const stablyEnabled = (process.env.STABLY_API_KEY ?? '').trim() !== ''

// Why: extract the Stably project as a typed value (vs inlining it inside a
// conditional spread) so a future tightening of Playwright's `Project` type
// via `@stablyai/playwright-test`'s module augmentation will fail this file
// at compile time rather than silently pass. The conditional spread pattern
// loses the structural check because `[]` is assignable to `Project[]`
// regardless of the branch.
const stablyProject: Project = {
  name: 'electron-stably',
  testDir: './e2e/stably',
  testMatch: '**/*.spec.ts',
  // Why: the Stably AI specs share a single on-disk test repo via
  // TEST_REPO_PATH_FILE (see tests/e2e/helpers/orca-app.ts — `testRepoPath`
  // is a worker-scoped fixture that reads that shared path). Specs under
  // ./e2e/stably (e.g. source-control.spec.ts) mutate that repo with
  // writeFileSync + `git checkout`/`git reset` in seed/cleanup. With the
  // top-level `fullyParallel: true` and `workers: 4` on CI, concurrent
  // workers would race on the same working tree and clobber each other's
  // seeded state. Pin this project to a single serial worker so the AI
  // suite has exclusive ownership of the shared repo for the duration of
  // each test. The headless suites keep their full fan-out.
  fullyParallel: false,
  workers: 1,
  // Why: agent.act() drives real DOM/pointer events, which the
  // headless Electron runs handle unreliably (see
  // terminal-panes.spec.ts's @headful rationale). Run the AI suite
  // in a visible window so pointer capture and focus work.
  metadata: {
    orcaHeadful: true
  }
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Why: this suite launches a fresh Electron app and isolated userData dir per
  // test. Cold-starts late in the run can exceed 60s on CI even when the app is
  // healthy, so the per-test budget needs to cover startup plus assertions.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // Why: the headless Electron specs launch isolated app instances and can
  // safely fan out across workers, which cuts the default E2E runtime
  // substantially. The few visible-window tests that still rely on real
  // pointer interaction are marked serial in their spec file instead.
  fullyParallel: true,
  // Why: Playwright defaults to workers=1 on CI, which would serialize all
  // specs on the ubuntu-latest runner (4 vCPUs) and waste headroom. Each test
  // launches an isolated Electron instance with its own userData dir, so they
  // don't share state — we can safely fan out to match the runner's vCPU count.
  workers: process.env.CI ? 4 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    // Why: this suite intentionally runs with retries disabled so first-failure
    // traces are the only reliable debugging artifact we can collect in CI.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'electron-headless',
      testMatch: '**/*.spec.ts',
      // Why: exclude the AI suite so it never runs by accident under the
      // default `pnpm test:e2e`. The Stably specs need a visible window
      // (agent.act drives real pointer/keyboard events) and an API key, and
      // neither is a requirement for the store-driven default project.
      testIgnore: '**/stably/**',
      grepInvert: /@headful/,
      metadata: {
        orcaHeadful: false
      }
    },
    {
      name: 'electron-headful',
      testMatch: '**/*.spec.ts',
      testIgnore: '**/stably/**',
      grep: /@headful/,
      metadata: {
        orcaHeadful: true
      }
    },
    // Why: only register the Stably project when the API key is present.
    // Playwright runs every declared project by default, so including this
    // unconditionally would fail fork PRs and local runs without credentials
    // instead of being a silent no-op.
    ...(stablyEnabled ? [stablyProject] : [])
  ]
})
