import { Node, mergeAttributes, InputRule } from '@tiptap/core'
import { getMarkdownDocLinkTarget } from './markdown-doc-links'

const DOC_LINK_PLACEHOLDER_PREFIX = '[[ORCA_DOC_LINK:'
const DOC_LINK_PLACEHOLDER_SUFFIX = ']]'

export const MarkdownDocLink = Node.create({
  name: 'markdownDocLink',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-doc-link-target') ?? ''
      }
    }
  },

  markdownTokenName: 'markdownDocLink',
  markdownTokenizer: {
    name: 'markdownDocLink',
    level: 'inline',
    start: DOC_LINK_PLACEHOLDER_PREFIX,
    tokenize(src: string) {
      if (!src.startsWith(DOC_LINK_PLACEHOLDER_PREFIX)) {
        return undefined
      }

      const endIndex = src.indexOf(DOC_LINK_PLACEHOLDER_SUFFIX, DOC_LINK_PLACEHOLDER_PREFIX.length)
      if (endIndex === -1) {
        return undefined
      }

      const placeholder = src.slice(0, endIndex + DOC_LINK_PLACEHOLDER_SUFFIX.length)
      const target = src.slice(DOC_LINK_PLACEHOLDER_PREFIX.length, endIndex)

      return {
        type: 'markdownDocLink',
        raw: placeholder,
        text: target
      }
    }
  },

  parseMarkdown: (token, helpers) => {
    if (token.type !== 'markdownDocLink') {
      return []
    }
    return helpers.createNode('markdownDocLink', {
      target: typeof token.text === 'string' ? token.text : ''
    })
  },

  renderMarkdown: (node) =>
    `[[${typeof node.attrs?.target === 'string' ? node.attrs.target : ''}]]`,

  addInputRules() {
    return [
      new InputRule({
        // Why: matches [[target]] at the end of input. The regex captures the
        // target text between [[ and ]] so the input rule fires when the user
        // types the closing ]].
        find: /\[\[([^[\]\r\n|]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const target = getMarkdownDocLinkTarget(match[1])
          if (!target) {
            return
          }
          const node = state.schema.nodes.markdownDocLink.create({ target })
          state.tr.replaceWith(range.from, range.to, node)
        }
      })
    ]
  },

  parseHTML() {
    return [{ tag: 'span[data-doc-link-target]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const target = typeof node.attrs.target === 'string' ? node.attrs.target : ''
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-doc-link-target': target,
        contenteditable: 'false',
        class: 'rich-markdown-doc-link'
      }),
      target
    ]
  }
})
