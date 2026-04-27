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
    // Entry state. No embed is active yet, so structural rules must NOT pop
    // an embedded tokenizer (Monaco throws on `nextEmbedded: '@pop'` when no
    // embed is on the stack). The first piece of template markup transitions
    // into `markup`, where the html embed is active and structural rules pop
    // it cleanly.
    root: [
      [/<script(?=\s|>)/, 'tag', '@scriptOpen.typescript'],
      [/<style(?=\s|>)/, 'tag', '@styleOpen.css'],
      [/<!--/, 'comment', '@comment'],
      [/\{\s*\/(if|each|await|key|snippet)\s*\}/, 'keyword.control'],
      [
        /\{\s*#(if|each|await|key|snippet)\b/,
        { token: 'keyword.control', next: '@svelteBlockExpressionEnter' }
      ],
      [
        /\{\s*:(else|then|catch)\b/,
        { token: 'keyword.control', next: '@svelteBlockExpressionEnter' }
      ],
      [
        /\{\s*@(html|debug|const|render)\b/,
        { token: 'keyword.control', next: '@svelteExpressionEnter' }
      ],
      [/\{(?=[^#:/@])/, { token: 'delimiter.curly', next: '@svelteExpressionEnter' }],
      // First markup character: switch into `markup` and start the html embed.
      [/(?=.)/, { token: '', switchTo: '@markup', nextEmbedded: 'html' }]
    ],
    // html-embedded markup state. Structural rules end the embed before
    // pushing into script/style/comment/svelte states; the catch-all
    // re-enters html when those states pop back.
    markup: [
      [/<script(?=\s|>)/, { token: 'tag', next: '@scriptOpen.typescript', nextEmbedded: '@pop' }],
      [/<style(?=\s|>)/, { token: 'tag', next: '@styleOpen.css', nextEmbedded: '@pop' }],
      [/<!--/, { token: 'comment', next: '@comment', nextEmbedded: '@pop' }],
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
      [/(?=.)/, { token: '', nextEmbedded: 'html' }]
    ],
    comment: [
      [/-->/, 'comment', '@pop'],
      [/[^-]+/, 'comment'],
      [/./, 'comment']
    ],
    // Once the typescript embed is active inside an expression, Monaco only
    // consults parent rules whose action ends the embed. That means a brace
    // counter cannot run from inside the embed, so expressions containing
    // nested braces (e.g. `class={{ active: foo }}` or `{foo({ bar: 1 })}`)
    // close at the first inner `}` and the trailing `}` falls into markup.
    // Matches the RFC's note that regex-based grammars have edge cases;
    // the common single-brace case `{count}` works correctly.
    svelteExpressionEnter: [
      [/\}/, { token: 'delimiter.curly', next: '@pop' }],
      [/(?=.)/, { token: '', switchTo: '@svelteExpression', nextEmbedded: 'typescript' }]
    ],
    svelteExpression: [[/\}/, { token: 'delimiter.curly', next: '@pop', nextEmbedded: '@pop' }]],
    svelteBlockExpressionEnter: [
      [/\}/, { token: 'keyword.control', next: '@pop' }],
      [/(?=.)/, { token: '', switchTo: '@svelteBlockExpression', nextEmbedded: 'typescript' }]
    ],
    svelteBlockExpression: [
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
