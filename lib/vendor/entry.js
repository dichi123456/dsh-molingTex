// 墨灵 LaTeX 的编辑器内核：把 CodeMirror 6 打包成一个挂在 window.__molingCM 上的门面，
// 供 lib/client.js（经典脚本，只能 require react）以普通 <script> 方式加载后调用。
//
// 设计约束：
//   · 只用 CodeMirror 自己的 API，不碰 DSH 任何包；
//   · 主题全部走 DSH 的 CSS 变量（--dsw-alias-*），亮/暗自动跟随；
//   · 对外只暴露少数几个方法，插件侧不需要知道 CodeMirror 的细节。

import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { defaultKeymap, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle, indentOnInput, StreamLanguage } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { tags } from '@lezer/highlight'

// @codemirror/lang-latex 在当前 registry 上 404，改用 CodeMirror 5 时代成熟的 stex 模式
// （同样是 LaTeX 语法：命令、环境、数学、注释都有 token），配 StreamLanguage 使用。
const latexMode = StreamLanguage.define(stex)

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace'

/** 编辑器外观：全部取 DSH 主题变量，亮/暗自动跟随，不写死颜色。 */
const molingTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: MONO,
    lineHeight: '18px',
    overflow: 'auto'
  },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--dsw-alias-label-primary, #e6e6e6)' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
    paddingLeft: '4px'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 4px', minWidth: '34px' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--dsw-alias-label-primary, #e6e6e6)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-label-primary, #e6e6e6)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(120, 170, 255, 0.28)'
  },
  '.cm-selectionMatch': { backgroundColor: 'rgba(120, 170, 255, 0.14)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(120, 170, 255, 0.20)',
    outline: 'none'
  },
  '.cm-searchMatch': { backgroundColor: 'rgba(217, 154, 43, 0.28)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(217, 154, 43, 0.45)' },
  '.cm-panels': {
    backgroundColor: 'var(--dsw-alias-bg-layer-1, #232323)',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)'
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--dsw-alias-border-l1, #3a3a3a)' },
  '.cm-textfield': {
    backgroundColor: 'transparent',
    color: 'inherit',
    border: '1px solid var(--dsw-alias-border-l1, #3a3a3a)',
    borderRadius: '4px'
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    border: '1px solid var(--dsw-alias-border-l1, #3a3a3a)',
    borderRadius: '4px'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--dsw-alias-bg-overlay, #2b2b2b)',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    border: '1px solid var(--dsw-alias-border-l1, #3a3a3a)'
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--dsw-alias-bg-layer-2, #333)',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)'
  }
}, { dark: true })

/** 语法着色：与旧版自研高亮同一套配色思路（命令/环境/键/数学/注释/数字）。 */
const molingHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--dsw-alias-brand-primary, #6aa9ff)' },
  { tag: tags.tagName, color: 'var(--dsw-alias-state-error-primary, #e06c5a)' },
  { tag: tags.typeName, color: 'var(--dsw-alias-state-error-primary, #e06c5a)' },
  { tag: tags.labelName, color: 'var(--dsw-alias-state-warn-primary, #d99a2b)' },
  { tag: tags.number, color: 'var(--dsw-alias-state-success-primary, #57b46b)' },
  { tag: tags.bool, color: 'var(--dsw-alias-state-success-primary, #57b46b)' },
  { tag: tags.string, color: 'var(--dsw-alias-state-success-primary, #57b46b)' },
  { tag: tags.comment, color: 'var(--dsw-alias-label-secondary, #9aa0a6)', fontStyle: 'italic' },
  { tag: tags.bracket, color: 'var(--dsw-alias-label-secondary, #9aa0a6)' },
  { tag: tags.meta, color: 'var(--dsw-alias-label-secondary, #9aa0a6)' },
  { tag: tags.heading, fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--dsw-alias-brand-primary, #6aa9ff)' },
  { tag: tags.invalid, color: 'var(--dsw-alias-state-error-primary, #e06c5a)' }
])

const wrapCompartment = new Compartment()
const readOnlyCompartment = new Compartment()

function wrapExtension(on) {
  return on ? EditorView.lineWrapping : []
}

/**
 * 造一个编辑器实例。
 * opts: { doc, onChange(text), onSave(), onCompile(), wrap?:boolean, readOnly?:boolean }
 * 返回 EditorView（CM 原生对象），外面只当黑盒传回下面的 helper。
 */
function create(parent, opts) {
  const options = opts || {}
  const customKeys = keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => { if (options.onSave) options.onSave(); return true }
    },
    {
      key: 'F5',
      preventDefault: true,
      run: () => { if (options.onCompile) options.onCompile(); return true }
    }
  ])

  const state = EditorState.create({
    doc: options.doc || '',
    extensions: [
      customKeys,
      basicSetup,
      latexMode,
      molingTheme,
      syntaxHighlighting(molingHighlight),
      indentOnInput(),
      readOnlyCompartment.of(EditorState.readOnly.of(Boolean(options.readOnly))),
      wrapCompartment.of(wrapExtension(options.wrap !== false)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && options.onChange) {
          options.onChange(update.state.doc.toString())
        }
        if (update.viewportChanged && options.onViewport) options.onViewport()
      })
    ]
  })

  const view = new EditorView({ state, parent: parent })
  // 默认焦点放过首行，避免点进面板后还要再点一下
  if (options.autofocus) view.focus()
  return view
}

/** 外部替换整篇文档（例如从磁盘重新读取）。不触发 onChange。 */
function setDoc(view, text) {
  if (!view) return
  const current = view.state.doc.toString()
  if (current === text) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    // 保持光标不越界
    selection: { anchor: Math.min(view.state.selection.main.anchor, text.length) }
  })
}

function getDoc(view) {
  return view ? view.state.doc.toString() : ''
}

function setWrap(view, on) {
  if (!view) return
  view.dispatch({ effects: wrapCompartment.reconfigure(wrapExtension(on !== false)) })
}

function setReadOnly(view, on) {
  if (!view) return
  view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(Boolean(on))) })
}

/** 跳到第 line 行（1 起）并居中。 */
function gotoLine(view, line) {
  if (!view) return
  const total = view.state.doc.lines
  const target = Math.max(1, Math.min(total, Number(line) || 1))
  const info = view.state.doc.line(target)
  view.dispatch({
    selection: { anchor: info.from },
    effects: EditorView.scrollIntoView(info.from, { y: 'center' })
  })
  view.focus()
}

function focus(view) {
  if (view) view.focus()
}

function destroy(view) {
  if (view) view.destroy()
}

function undoAction(view) { if (view) undo(view) }
function redoAction(view) { if (view) redo(view) }

window.__molingCM = {
  version: '6',
  create,
  setDoc,
  getDoc,
  setWrap,
  setReadOnly,
  gotoLine,
  focus,
  destroy,
  undo: undoAction,
  redo: redoAction
}
