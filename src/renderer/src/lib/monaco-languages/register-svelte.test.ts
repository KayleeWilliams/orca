import { describe, expect, it, vi } from 'vitest'
import {
  registerSvelteLanguage,
  svelteLanguageConfiguration,
  svelteMonarchLanguage
} from './register-svelte'

type MonarchAction = {
  next?: string
  nextEmbedded?: string
  switchTo?: string
}
type MonarchRule = [RegExp, string | MonarchAction, string?] | { include: string }

function normalizeState(nextState: string): string {
  return nextState.startsWith('@') ? nextState.slice(1) : nextState
}

function isRuleEntry(rule: MonarchRule): rule is [RegExp, string | MonarchAction, string?] {
  return Array.isArray(rule)
}

function getRuleAction(rule: [RegExp, string | MonarchAction, string?]): MonarchAction | undefined {
  const [, action, nextStateShortcut] = rule
  return typeof action === 'object'
    ? action
    : nextStateShortcut
      ? { next: nextStateShortcut }
      : undefined
}

function findRuleAction(state: string, source: string): MonarchAction | undefined {
  const tokenizer = svelteMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const stateRules = tokenizer[state] ?? tokenizer[state.split('.')[0]]
  const matchedRule = stateRules.find((rule) => {
    if (!isRuleEntry(rule)) {
      return false
    }
    const [regexp] = rule
    regexp.lastIndex = 0
    const match = regexp.exec(source)
    return match !== null && match.index === 0
  })

  return matchedRule && isRuleEntry(matchedRule) ? getRuleAction(matchedRule) : undefined
}

function collectFixtureRuleActions(source: string): string[] {
  const ruleActions: string[] = []
  const tokenizer = svelteMonarchLanguage.tokenizer as Record<string, MonarchRule[]>
  const lines = source.split('\n')
  const checks: { line: number; state: string; pattern: string }[] = [
    { line: 1, state: 'root', pattern: '<script' },
    { line: 1, state: 'scriptOpen.typescript', pattern: '>' },
    { line: 4, state: 'scriptBody.typescript', pattern: '</script>' },
    { line: 6, state: 'root', pattern: '' },
    { line: 7, state: 'root', pattern: '{#if' },
    { line: 7, state: 'svelteBlockExpression', pattern: '}' },
    { line: 8, state: 'root', pattern: '{' },
    { line: 8, state: 'svelteExpression', pattern: '}' },
    { line: 9, state: 'root', pattern: '{:else' },
    { line: 9, state: 'svelteBlockExpressionEnter', pattern: '}' },
    { line: 11, state: 'root', pattern: '{/if}' },
    { line: 13, state: 'root', pattern: '{' },
    { line: 13, state: 'svelteExpression', pattern: '{' },
    { line: 13, state: 'svelteExpressionNestedBrace', pattern: '}' },
    { line: 14, state: 'root', pattern: '{@html' },
    { line: 14, state: 'svelteExpression', pattern: '}' },
    { line: 16, state: 'root', pattern: '<style' },
    { line: 16, state: 'styleOpen.css', pattern: '>' },
    { line: 18, state: 'styleBody.css', pattern: '</style>' }
  ]

  checks.forEach((check) => {
    const line = lines.at(check.line - 1) ?? ''
    const stateRules = tokenizer[check.state] ?? tokenizer[check.state.split('.')[0]]
    const matchedRule = stateRules.find((rule) => {
      if (!isRuleEntry(rule)) {
        return false
      }
      const [regexp] = rule
      regexp.lastIndex = 0
      const match = regexp.exec(line)
      return match !== null && match[0] === check.pattern
    })
    if (!matchedRule || !isRuleEntry(matchedRule)) {
      return
    }

    const actionObject = getRuleAction(matchedRule)

    const nextState = actionObject?.next ? normalizeState(actionObject.next) : '-'
    const nextEmbedded = actionObject?.nextEmbedded ?? '-'
    const switchTo = actionObject?.switchTo ? normalizeState(actionObject.switchTo) : '-'
    ruleActions.push(
      `${check.line}:${check.state}:${check.pattern || '<html>'} -> next=${nextState}, embedded=${nextEmbedded}, switch=${switchTo}`
    )
  })

  return ruleActions
}

describe('registerSvelteLanguage registration', () => {
  it('registers the svelte language, Monarch tokenizer, and configuration once', () => {
    const languages: { id: string }[] = [{ id: 'typescript' }]
    const register = vi.fn((entry: { id: string }) => {
      languages.push({ id: entry.id })
    })
    const setMonarchTokensProvider = vi.fn()
    const setLanguageConfiguration = vi.fn()
    const getLanguages = vi.fn(() => languages)
    const monacoMock = {
      languages: {
        register,
        setMonarchTokensProvider,
        setLanguageConfiguration,
        getLanguages
      }
    }

    registerSvelteLanguage(monacoMock as never)
    registerSvelteLanguage(monacoMock as never)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith({
      id: 'svelte',
      extensions: ['.svelte'],
      aliases: ['Svelte']
    })
    expect(setMonarchTokensProvider).toHaveBeenCalledTimes(1)
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('svelte', svelteMonarchLanguage)
    expect(setLanguageConfiguration).toHaveBeenCalledTimes(1)
    expect(setLanguageConfiguration).toHaveBeenCalledWith('svelte', svelteLanguageConfiguration)
  })
})

describe('svelte tokenizer transitions', () => {
  it('captures Svelte tokenizer transitions for a representative SFC fixture', () => {
    const fixture = `<script lang="ts">
  let count = 0
  $: doubled = count * 2
</script>

<h1>Counter</h1>
{#if count > 0}
  <p>{count} clicked</p>
{:else}
  <p>not yet</p>
{/if}

<div class={{ active: count > 0 }}>{count}</div>
{@html '<em>raw</em>'}

<style>
  h1 { color: rebeccapurple; }
</style>`

    const ruleActions = collectFixtureRuleActions(fixture)

    expect(ruleActions).toMatchInlineSnapshot(`
      [
        "1:root:<script -> next=scriptOpen.typescript, embedded=-, switch=-",
        "1:scriptOpen.typescript:> -> next=-, embedded=$S2, switch=scriptBody.$S2",
        "4:scriptBody.typescript:</script> -> next=pop, embedded=@pop, switch=-",
        "6:root:<html> -> next=-, embedded=html, switch=-",
        "7:root:{#if -> next=svelteBlockExpressionEnter, embedded=@pop, switch=-",
        "7:svelteBlockExpression:} -> next=pop, embedded=@pop, switch=-",
        "8:root:{ -> next=svelteExpressionEnter, embedded=@pop, switch=-",
        "8:svelteExpression:} -> next=pop, embedded=@pop, switch=-",
        "9:root:{:else -> next=svelteBlockExpressionEnter, embedded=@pop, switch=-",
        "9:svelteBlockExpressionEnter:} -> next=pop, embedded=-, switch=-",
        "11:root:{/if} -> next=-, embedded=-, switch=-",
        "13:root:{ -> next=svelteExpressionEnter, embedded=@pop, switch=-",
        "13:svelteExpression:{ -> next=svelteExpressionNestedBrace, embedded=-, switch=-",
        "13:svelteExpressionNestedBrace:} -> next=pop, embedded=-, switch=-",
        "14:root:{@html -> next=svelteExpressionEnter, embedded=@pop, switch=-",
        "14:svelteExpression:} -> next=pop, embedded=@pop, switch=-",
        "16:root:<style -> next=styleOpen.css, embedded=-, switch=-",
        "16:styleOpen.css:> -> next=-, embedded=$S2, switch=styleBody.$S2",
        "18:styleBody.css:</style> -> next=pop, embedded=@pop, switch=-",
      ]
    `)
  })
})

describe('svelte embedded language attributes', () => {
  it('tracks embedded languages from Svelte block attributes and expressions', () => {
    expect(findRuleAction('svelteExpressionEnter', 'count }')).toMatchObject({
      nextEmbedded: 'typescript',
      switchTo: '@svelteExpression'
    })
    expect(findRuleAction('svelteBlockExpressionEnter', 'count > 0}')).toMatchObject({
      nextEmbedded: 'typescript',
      switchTo: '@svelteBlockExpression'
    })
    expect(findRuleAction('svelteExpression', '{ active: true }')).toMatchObject({
      next: '@svelteExpressionNestedBrace'
    })
    expect(findRuleAction('svelteExpressionNestedBrace', '}')).toMatchObject({
      next: '@pop'
    })
    expect(findRuleAction('scriptLangValue.typescript', '"js"')).toMatchObject({
      switchTo: '@scriptOpen.javascript'
    })
    expect(findRuleAction('scriptLangValue.javascript', '"ts"')).toMatchObject({
      switchTo: '@scriptOpen.typescript'
    })
    expect(findRuleAction('scriptLangValue.typescript', 'js')).toMatchObject({
      switchTo: '@scriptOpen.javascript'
    })
    expect(findRuleAction('styleLangValue.css', '"scss"')).toMatchObject({
      switchTo: '@styleOpen.scss'
    })
    expect(findRuleAction('styleLangValue.css', 'less')).toMatchObject({
      switchTo: '@styleOpen.less'
    })
    expect(findRuleAction('styleLangValue.css', "'sass'")).toMatchObject({
      switchTo: '@styleOpen.scss'
    })
    expect(findRuleAction('styleLangValue.scss', '"css"')).toMatchObject({
      switchTo: '@styleOpen.css'
    })
  })
})
