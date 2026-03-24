import React, { useRef, useCallback, useEffect } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import '@/lib/monaco-setup'

type MonacoEditorProps = {
  filePath: string
  content: string
  language: string
  onContentChange: (content: string) => void
  onSave: (content: string) => void
}

export default function MonacoEditor({
  filePath,
  content,
  language,
  onContentChange,
  onSave
}: MonacoEditorProps): React.JSX.Element {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor

      // Add Cmd+S save keybinding
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        const value = editor.getValue()
        onSave(value)
      })

      editor.focus()
    },
    [onSave]
  )

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        onContentChange(value)
      }
    },
    [onContentChange]
  )

  // Update editor options when settings change
  useEffect(() => {
    if (!editorRef.current || !settings) {
      return
    }
    editorRef.current.updateOptions({
      fontSize: settings.terminalFontSize,
      fontFamily: settings.terminalFontFamily || 'monospace'
    })
  }, [settings])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent).detail as
        | { filePath?: string; line?: number; column?: number | null }
        | undefined
      if (!detail || detail.filePath !== filePath || !detail.line) {
        return
      }
      const editor = editorRef.current
      if (!editor) {
        return
      }
      const targetColumn = Math.max(1, detail.column ?? 1)
      const targetLine = Math.max(1, detail.line)
      editor.revealPositionInCenter({ lineNumber: targetLine, column: targetColumn })
      editor.setPosition({ lineNumber: targetLine, column: targetColumn })
      editor.focus()
    }

    window.addEventListener('orca:editor-reveal-location', handler as EventListener)
    return () => window.removeEventListener('orca:editor-reveal-location', handler as EventListener)
  }, [filePath])

  return (
    <Editor
      height="100%"
      language={language}
      value={content}
      theme={isDark ? 'vs-dark' : 'vs'}
      onChange={handleChange}
      onMount={handleMount}
      options={{
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        fontSize: settings?.terminalFontSize ?? 13,
        fontFamily: settings?.terminalFontFamily || 'monospace',
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        automaticLayout: true,
        tabSize: 2,
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'off',
        padding: { top: 8 }
      }}
      path={filePath}
    />
  )
}
