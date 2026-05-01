import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { MarkdownDocument } from '../../../../shared/types'
import {
  createMarkdownDocumentIndex,
  getMarkdownDocLinkTarget,
  resolveMarkdownDocLink
} from './markdown-doc-links'

const DOC_LINK_PLACEHOLDER_PREFIX = '[[ORCA_DOC_LINK:'
const DOC_LINK_PLACEHOLDER_SUFFIX = ']]'

const DOC_LINK_PATTERN = /\[\[([^[\]\r\n|]+)\]\]/g

const docLinkAutoConvertKey = new PluginKey('docLinkAutoConvert')

function isDocLinkResolved(target: string, documents: MarkdownDocument[]): boolean {
  if (documents.length === 0) {
    return false
  }
  const index = createMarkdownDocumentIndex(documents)
  return resolveMarkdownDocLink(target, index).status === 'resolved'
}

export const MarkdownDocLink = Node.create({
  name: 'markdownDocLink',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addStorage() {
    return { documents: [] as MarkdownDocument[] }
  },

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

  addNodeView() {
    const storage = this.storage as { documents: MarkdownDocument[] }
    return ({ node }: { node: { type: { name: string }; attrs: Record<string, unknown> } }) => {
      const getTarget = (n: { attrs: Record<string, unknown> }): string =>
        typeof n.attrs.target === 'string' ? n.attrs.target : ''

      const target = getTarget(node)
      const dom = document.createElement('span')
      dom.setAttribute('data-doc-link-target', target)
      dom.setAttribute('contenteditable', 'false')
      dom.textContent = target

      const applyResolutionClass = (t: string): void => {
        const resolved = isDocLinkResolved(t, storage.documents)
        dom.className = resolved
          ? 'rich-markdown-doc-link'
          : 'rich-markdown-doc-link rich-markdown-doc-link--missing'
      }

      applyResolutionClass(target)

      return {
        dom,
        // Why: this fires on every transaction, including the no-op dispatched
        // when the document list changes in storage. Re-checking resolution
        // here keeps the blue/grey styling current without a full re-render.
        update: (updatedNode: { type: { name: string }; attrs: Record<string, unknown> }) => {
          if (updatedNode.type.name !== 'markdownDocLink') {
            return false
          }
          const newTarget = getTarget(updatedNode)
          dom.setAttribute('data-doc-link-target', newTarget)
          dom.textContent = newTarget
          applyResolutionClass(newTarget)
          return true
        }
      }
    }
  },

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
          const cursor = newState.selection.from
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

              // Why: skip matches where the cursor sits between [[ and ]].
              // The user is still typing the target — converting now would
              // swallow their in-progress text into an atomic node.
              if (cursor > from && cursor < to) {
                continue
              }

              const docLinkNode = nodeType.create({ target })
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
