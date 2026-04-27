import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const svelteMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.svelte',
  ignoreCase: true,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
    { open: '<', close: '>', token: 'delimiter.angle' }
  ],
  tokenizer: {
    root: [
      [/<script(?=\s|>)/, 'tag', '@scriptOpen.typescript'],
      [/<style(?=\s|>)/, 'tag', '@styleOpen.css'],
      [/<!--/, 'comment', '@comment'],
      [/\{\s*\/(if|each|await|key|snippet)\s*\}/, 'keyword.control'],
      [
        /\{\s*#(if|each|await|key|snippet)\b/,
        { token: 'keyword.control', next: '@svelteBlockExpressionEnter', nextEmbedded: '@pop' }
      ],
      [
        /\{\s*:(else|then|catch)\b/,
        { token: 'keyword.control', next: '@svelteBlockExpressionEnter', nextEmbedded: '@pop' }
      ],
      [
        /\{\s*@(html|debug|const|render)\b/,
        { token: 'keyword.control', next: '@svelteExpressionEnter', nextEmbedded: '@pop' }
      ],
      [
        /\{(?=[^#:/@])/,
        { token: 'delimiter.curly', next: '@svelteExpressionEnter', nextEmbedded: '@pop' }
      ],
      // Svelte has top-level markup instead of a <template> wrapper. Re-enter
      // html after Svelte-specific states pop their embedded tokenizers.
      [/(?=.)/, { token: '', nextEmbedded: 'html' }]
    ],
    comment: [
      [/-->/, 'comment', '@pop'],
      [/[^-]+/, 'comment'],
      [/./, 'comment']
    ],
    svelteExpressionEnter: [
      [/\}/, { token: 'delimiter.curly', next: '@pop' }],
      [/(?=.)/, { token: '', switchTo: '@svelteExpression', nextEmbedded: 'typescript' }]
    ],
    svelteExpression: [
      // Nested braces keep object literals inside {expr} from closing the
      // Svelte expression at the first inner `}`.
      [/\{/, 'delimiter.curly', '@svelteExpressionNestedBrace'],
      [/\}/, { token: 'delimiter.curly', next: '@pop', nextEmbedded: '@pop' }]
    ],
    svelteExpressionNestedBrace: [
      [/\{/, 'delimiter.curly', '@push'],
      [/\}/, 'delimiter.curly', '@pop']
    ],
    svelteBlockExpressionEnter: [
      [/\}/, { token: 'keyword.control', next: '@pop' }],
      [/(?=.)/, { token: '', switchTo: '@svelteBlockExpression', nextEmbedded: 'typescript' }]
    ],
    svelteBlockExpression: [
      [/\{/, 'delimiter.curly', '@svelteExpressionNestedBrace'],
      [/\}/, { token: 'keyword.control', next: '@pop', nextEmbedded: '@pop' }]
    ],
    scriptOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', switchTo: '@scriptBody.$S2', nextEmbedded: '$S2' }],
      [/lang(?=\s*=)/, { token: 'attribute.name', switchTo: '@scriptLangBeforeEquals.$S2' }],
      { include: '@tagAttributes' }
    ],
    scriptLangBeforeEquals: [
      [/=/, { token: 'delimiter', switchTo: '@scriptLangValue.$S2' }],
      [/\s+/, 'white'],
      [/(?=.)/, { token: '', switchTo: '@scriptOpen.$S2' }]
    ],
    scriptLangValue: [
      [/"(?:js|javascript)"/, { token: 'attribute.value', switchTo: '@scriptOpen.javascript' }],
      [/'(?:js|javascript)'/, { token: 'attribute.value', switchTo: '@scriptOpen.javascript' }],
      [
        /(?:js|javascript)(?=\s|\/|>|$)/,
        { token: 'attribute.value', switchTo: '@scriptOpen.javascript' }
      ],
      [/"(?:ts|typescript)"/, { token: 'attribute.value', switchTo: '@scriptOpen.typescript' }],
      [/'(?:ts|typescript)'/, { token: 'attribute.value', switchTo: '@scriptOpen.typescript' }],
      [
        /(?:ts|typescript)(?=\s|\/|>|$)/,
        { token: 'attribute.value', switchTo: '@scriptOpen.typescript' }
      ],
      [/[^\s/>]+/, { token: 'attribute.value', switchTo: '@scriptOpen.$S2' }],
      [/"[^"]*"/, { token: 'attribute.value', switchTo: '@scriptOpen.$S2' }],
      [/'[^']*'/, { token: 'attribute.value', switchTo: '@scriptOpen.$S2' }],
      [/\s+/, 'white']
    ],
    scriptBody: [[/<\/script\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]],
    styleOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', switchTo: '@styleBody.$S2', nextEmbedded: '$S2' }],
      [/lang(?=\s*=)/, { token: 'attribute.name', switchTo: '@styleLangBeforeEquals.$S2' }],
      { include: '@tagAttributes' }
    ],
    styleLangBeforeEquals: [
      [/=/, { token: 'delimiter', switchTo: '@styleLangValue.$S2' }],
      [/\s+/, 'white'],
      [/(?=.)/, { token: '', switchTo: '@styleOpen.$S2' }]
    ],
    styleLangValue: [
      [/"scss"/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/'scss'/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/scss(?=\s|\/|>|$)/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/"sass"/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/'sass'/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/sass(?=\s|\/|>|$)/, { token: 'attribute.value', switchTo: '@styleOpen.scss' }],
      [/"less"/, { token: 'attribute.value', switchTo: '@styleOpen.less' }],
      [/'less'/, { token: 'attribute.value', switchTo: '@styleOpen.less' }],
      [/less(?=\s|\/|>|$)/, { token: 'attribute.value', switchTo: '@styleOpen.less' }],
      [/"css"/, { token: 'attribute.value', switchTo: '@styleOpen.css' }],
      [/'css'/, { token: 'attribute.value', switchTo: '@styleOpen.css' }],
      [/css(?=\s|\/|>|$)/, { token: 'attribute.value', switchTo: '@styleOpen.css' }],
      [/[^\s/>]+/, { token: 'attribute.value', switchTo: '@styleOpen.$S2' }],
      [/"[^"]*"/, { token: 'attribute.value', switchTo: '@styleOpen.$S2' }],
      [/'[^']*'/, { token: 'attribute.value', switchTo: '@styleOpen.$S2' }],
      [/\s+/, 'white']
    ],
    styleBody: [[/<\/style\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]],
    tagAttributes: [
      [/[^\s/>=]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"[^"]*"/, 'attribute.value'],
      [/'[^']*'/, 'attribute.value'],
      [/\s+/, 'white']
    ]
  }
}

export const svelteLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { blockComment: ['<!--', '-->'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
    ['<', '>']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
    { open: '<', close: '>' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
    { open: '<', close: '>' }
  ]
}

export function registerSvelteLanguage(monaco: MonacoModule): void {
  const svelteAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'svelte')
  if (svelteAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: 'svelte',
    extensions: ['.svelte'],
    aliases: ['Svelte']
  })
  monaco.languages.setMonarchTokensProvider('svelte', svelteMonarchLanguage)
  monaco.languages.setLanguageConfiguration('svelte', svelteLanguageConfiguration)
}
