import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './preamble'

describe('buildDispatchPreamble', () => {
  it('substitutes template variables', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_abc123',
      taskSpec: 'Implement the login form',
      coordinatorHandle: 'term_coord'
    })

    expect(result).toContain('task_abc123')
    expect(result).toContain('term_coord')
    expect(result).toContain('Implement the login form')
    expect(result).not.toContain('{{')
  })

  it('includes worker_done command', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c'
    })

    expect(result).toContain('worker_done')
    expect(result).toContain('orchestration send')
    expect(result).toContain('orchestration check')
  })

  it('includes the task spec after separator', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'refactor the auth module',
      coordinatorHandle: 'term_c'
    })

    expect(result).toContain('--- TASK ---')
    expect(result).toContain('refactor the auth module')
  })

  it('uses orca CLI by default when devMode is not set', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c'
    })

    expect(result).toContain('orca orchestration send')
    expect(result).toContain('orca orchestration check')
  })

  it('uses orca-dev CLI when devMode is true', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      devMode: true
    })

    expect(result).toContain('orca-dev orchestration send')
    expect(result).toContain('orca-dev orchestration check')
    // Ensure no bare "orca " (without -dev) appears as a CLI command.
    // We split on "orca-dev" first so those occurrences don't produce
    // false positives, then check the remaining fragments.
    const fragments = result.split('orca-dev')
    for (const fragment of fragments) {
      expect(fragment).not.toMatch(/orca orchestration/)
    }
  })

  it('uses orca CLI when devMode is false', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      devMode: false
    })

    expect(result).toContain('orca orchestration send')
    expect(result).toContain('orca orchestration check')
  })

  it('appends a BASE DRIFT section when baseDrift.behind > 0', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      baseDrift: {
        base: 'origin/main',
        behind: 7,
        recentSubjects: ['fix: A', 'feat: B', 'chore: C']
      }
    })

    expect(result).toContain('--- BASE DRIFT ---')
    expect(result).toContain('7 commits behind origin/main')
    expect(result).toContain('  - fix: A')
    expect(result).toContain('  - feat: B')
    expect(result).toContain('  - chore: C')
    // drift section must appear before the task spec
    expect(result.indexOf('--- BASE DRIFT ---')).toBeLessThan(result.indexOf('--- TASK ---'))
  })

  it('omits the drift section when baseDrift.behind is 0', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      baseDrift: {
        base: 'origin/main',
        behind: 0,
        recentSubjects: []
      }
    })

    expect(result).not.toContain('--- BASE DRIFT ---')
    expect(result).not.toContain('commits behind')
  })

  it('omits the drift section when baseDrift is undefined', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c'
    })

    expect(result).not.toContain('--- BASE DRIFT ---')
    expect(result).not.toContain('commits behind')
  })

  it('lists drift subjects in the order provided, each prefixed with two spaces and dash', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_x',
      taskSpec: 'do stuff',
      coordinatorHandle: 'term_c',
      baseDrift: {
        base: 'origin/main',
        behind: 3,
        recentSubjects: ['first', 'second', 'third']
      }
    })

    const firstIdx = result.indexOf('  - first')
    const secondIdx = result.indexOf('  - second')
    const thirdIdx = result.indexOf('  - third')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
    expect(thirdIdx).toBeGreaterThan(secondIdx)
  })
})
