import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { getMarkdownDocLinkTarget } from './markdown-doc-links'

const DOC_LINK_PLACEHOLDER_PREFIX = '[[ORCA_DOC_LINK:'
const DOC_LINK_PLACEHOLDER_SUFFIX = ']]'

const DOC_LINK_PATTERN = /\[\[([^[\]\r\n|]+)\]\]/g

const docLinkAutoConvertKey = new PluginKey('docLinkAutoConvert')

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

  // Why: a ProseMirror plugin (not an input rule) so that [[target]] typed in
  // any order — brackets first then target, paste, etc. — converts to a doc
  // link node. Input rules only fire on sequential append at the cursor.
  addProseMirrorPlugins() {
    const nodeType = this.type
    return [
      new Plugin({
        key: docLinkAutoConvertKey,
        appendTransaction(_transactions, _oldState, newState) {
          const { tr } = newState
          let modified = false

          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'text' || !node.text) {
              return
            }

            DOC_LINK_PATTERN.lastIndex = 0
            let match: RegExpExecArray | null = null
            while ((match = DOC_LINK_PATTERN.exec(node.text)) !== null) {
              const target = getMarkdownDocLinkTarget(match[1])
              if (!target) {
                continue
              }

              const from = pos + match.index
              const to = from + match[0].length
              const docLinkNode = nodeType.create({ target })

              // Why: earlier replacements shift positions. Map through the
              // transaction's current mapping so subsequent matches land at
              // the correct offset.
              tr.replaceWith(tr.mapping.map(from), tr.mapping.map(to), docLinkNode)
              modified = true
            }
          })

          return modified ? tr : null
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
