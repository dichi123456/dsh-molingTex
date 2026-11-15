// 墨灵 LaTeX 的编辑器内核：把 CodeMirror 6 打包成一个挂在 window.__molingCM 上的门面，
// 供 lib/client.js（经典脚本，只能 require react）以普通 <script> 方式加载后调用。
//
// 设计约束：
//   · 只用 CodeMirror 自己的 API，不碰 DSH 任何包；
//   · 主题全部走 DSH 的 CSS 变量（--dsw-alias-*），亮/暗自动跟随；
//   · 对外只暴露少数几个方法，插件侧不需要知道 CodeMirror 的细节。

import { EditorState, Compartment, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { EditorView, keymap, Decoration, ViewPlugin } from '@codemirror/view'
import { snippetCompletion } from '@codemirror/autocomplete'
import { basicSetup } from 'codemirror'
import { defaultKeymap, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle, indentOnInput, StreamLanguage } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { tags } from '@lezer/highlight'

// LaTeX 词法：**直接搬自桌面版墨灵TeX**（src/components/Editor.vue 里的 latexLanguage），
// 不再用 @codemirror/legacy-modes 的 stex。为什么换：
//   · stex 把 \begin{...} 的环境名、\label 的键都吐成 atom，跟面板分词对不上，
//     线上表现就是「begin{} 里没高亮」；
//   · 用户明确要求「直接从墨灵tex.exe 搬运套用，别自己瞎编辑」——桌面版这套
//     token 映射（命令 keyword、数学 string、数字 number、可选参数 propertyName、
//     转义 escape、注释 comment）已经在墨灵TeX 里用了很久，观感是用户认可的。
const latexMode = StreamLanguage.define({
  name: 'latex',
  startState: () => ({ inMath: false, inComment: false }),
  token(stream, state) {
    if (stream.sol()) state.inComment = false
    if (state.inComment) {
      while (!stream.eol()) {
        if (stream.match(/^.*?%/)) {
          state.inComment = false
          return 'comment'
        }
        stream.next()
      }
      return 'comment'
    }
    // 数学区间要排在注释判断**之前**：$5\%$ 里的 % 是百分号字面量，不是注释起点。
    // 用户 2026-11-14 报的「\% 之后整行变灰斜体」就是这两条顺序颠倒造成的。
    if (state.inMath) {
      if (stream.match(/^\$\$/)) {
        state.inMath = false
        return 'keyword'
      }
      if (stream.match(/^\$/)) {
        state.inMath = false
        return 'keyword'
      }
      // 数学里的转义（\% \_ \{ …）按 escape 上色，同样不能落到注释分支
      if (stream.match(/^\\./)) return 'escape'
      if (stream.match(/^%.*$/)) return 'comment'
      stream.next()
      return 'string'
    }
    if (stream.match(/^\$\$/)) {
      state.inMath = true
      return 'keyword'
    }
    if (stream.match(/^\$/)) {
      state.inMath = true
      return 'keyword'
    }
    if (stream.match(/^\\begin\{[^}]*\}/) || stream.match(/^\\end\{[^}]*\}/)) {
      return 'keyword'
    }
    if (stream.match(/^\\[a-zA-Z@]+\*?/)) {
      return 'keyword'
    }
    // 转义（\% \$ \\ \_ …）要排在注释判断前面，否则行内 \% 后面的正文被吞成注释。
    if (stream.match(/^\\./)) {
      return 'escape'
    }
    // 注释：真正的 % （此时已排除 \% 这种转义）
    if (stream.match(/^%/)) {
      state.inComment = true
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match(/^\\./)) {
      return 'escape'
    }
    if (stream.match(/^[{}]/)) {
      return 'brace'
    }
    if (stream.match(/^\[[^\]]*\]/)) {
      return 'propertyName'
    }
    stream.next()
    return null
  },
  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"'] }
  }
})

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
    overflow: 'auto',
    // 细滚动条（用户 2026-11-14 要求「tex/pdf 之间的分割线太粗」）：
    // 原来没有 ::-webkit-scrollbar 规则 → Chromium 默认 15px 浅灰方角条，
    // 正好压在 tex 与 pdf 的交界处，看着就是一条粗分割线。这里做成 8px 圆角细条。
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(128,128,128,0.45) transparent'
  },
  '.cm-scroller::-webkit-scrollbar': { width: '8px', height: '8px' },
  '.cm-scroller::-webkit-scrollbar-track': { background: 'transparent' },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    background: 'rgba(128,128,128,0.42)',
    borderRadius: '4px'
  },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': { background: 'rgba(128,128,128,0.62)' },
  '.cm-scroller::-webkit-scrollbar-corner': { background: 'transparent' },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--dsw-alias-label-primary, #e6e6e6)' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
    paddingLeft: '2px'
  },
  // 行号列收窄（用户 2026-11-14 要求「显示行号的面板窄一点」）：
  // 原来 minWidth 34px + 左右内边距 4/10px，一行号就吃掉 40 多像素；
  // 现在 22px + 2/6px ≈ 26px，三四位数行号仍按内容自然变宽，不会截断。
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 2px', minWidth: '22px' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--dsw-alias-label-primary, #e6e6e6)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-label-primary, #e6e6e6)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(120, 170, 255, 0.28)'
  },
  // 选中相同词的高亮（basicSetup 里的 highlightSelectionMatches 涂的）。
  // 0.14 太淡，深色主题下几乎看不见；提到 0.3 并加一圈淡边，才符合
  // 用户 2026-11-15 说的「高亮显示被选中内容」。
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(120, 170, 255, 0.30)',
    outline: '1px solid rgba(120, 170, 255, 0.45)',
    borderRadius: '2px'
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(120, 170, 255, 0.20)',
    outline: 'none'
  },
  // 匹配色：照搬桌面版（src/components/Editor.vue:516/520）——
  // 全部命中是琥珀底 + 细描边，**当前那一条是红底**，这样「现在停在哪一处」
  // 一眼就能看出来（原来两种都是橙色，只差一点透明度，用户 2026-11-15 报
  // 「高亮显示被选中内容」看不出来）。
  '.cm-searchMatch': {
    backgroundColor: 'rgba(245, 158, 11, 0.35)',
    outline: '1px solid rgba(245, 158, 11, 0.6)',
    borderRadius: '2px'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(239, 68, 68, 0.35)',
    outline: '1px solid rgba(239, 68, 68, 0.65)'
  },
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

/**
 * 语法着色：**调色板直接搬自桌面版墨灵TeX**（src/components/Editor.vue 的 highlightStyle）。
 * 用户要求「直接从墨灵tex.exe 搬运套用，别自己瞎编辑」——所以这里不再自编一套
 * 「命令蓝/环境金/键青绿/数学浅蓝」，而是照抄桌面版那套 One Dark 系配色：
 * 命令紫、数学绿、数字橙、可选参数红、转义青、注释灰斜体。
 * 桌面版用 var(--text-tertiary) 这类自己的主题变量，这里换成 DSH 的 --dsw-alias-*。
 */
const HL = {
  comment: 'var(--dsw-alias-label-secondary, #9aa0a6)',
  keyword: '#c678dd',
  string: '#98c379',
  number: '#d19a66',
  func: '#61afef',
  typeName: '#e5c07b',
  property: '#e06c75',
  invalid: '#f44747',
  escape: '#56b6c2'
}
const molingHighlight = HighlightStyle.define([
  { tag: tags.comment, color: HL.comment, fontStyle: 'italic' },
  { tag: tags.keyword, color: HL.keyword },
  { tag: tags.operator, color: 'var(--dsw-alias-label-primary, #e6e6e6)' },
  { tag: tags.string, color: HL.string },
  { tag: tags.number, color: HL.number },
  { tag: tags.definition(tags.variableName), color: HL.func },
  { tag: tags.function(tags.variableName), color: HL.func },
  { tag: tags.typeName, color: HL.typeName },
  { tag: tags.propertyName, color: HL.property },
  { tag: tags.className, color: HL.typeName },
  { tag: tags.invalid, color: HL.invalid },
  { tag: tags.meta, color: HL.keyword },
  { tag: tags.processingInstruction, color: HL.keyword },
  { tag: tags.escape, color: HL.escape },
  { tag: tags.brace, color: 'var(--dsw-alias-label-secondary, #9aa0a6)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.link, color: HL.func, textDecoration: 'underline' }
])

const wrapCompartment = new Compartment()
const readOnlyCompartment = new Compartment()

function wrapExtension(on) {
  return on ? EditorView.lineWrapping : []
}

/**
 * 行内样式装饰器：面板自己分词（highlightDocument）算好每行每段的样式，
 * 通过 opts.getSegments(text) 交进来，这里按可见行涂到行内 span 上。
 * 为什么不用 CM 自己的高亮类：DSH 页面里样式类会被别的编辑器实例覆盖。
 */
function segmentsExtension(options) {
  const styleOf = (obj) => Object.keys(obj || {})
    .map((key) => key.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase()) + ': ' + obj[key])
    .join('; ')
  const build = (view) => {
    const builder = new RangeSetBuilder()
    let lines = null
    try {
      lines = options.getSegments ? options.getSegments(view.state.doc.toString()) : null
    } catch (error) {
      lines = null
    }
    if (!lines || !lines.length) return builder.finish()
    for (const range of view.visibleRanges) {
      const first = view.state.doc.lineAt(range.from).number
      const last = view.state.doc.lineAt(range.to).number
      for (let number = first; number <= last; number++) {
        const segments = lines[number - 1]
        if (!segments || !segments.length) continue
        const line = view.state.doc.line(number)
        let pos = line.from
        for (const segment of segments) {
          const length = segment && segment.text ? segment.text.length : 0
          if (length <= 0) continue
          const to = Math.min(pos + length, line.to)
          if (to > pos && segment.style) {
            builder.add(pos, to, Decoration.mark({ attributes: { style: styleOf(segment.style) } }))
          }
          pos = to
          if (pos >= line.to) break
        }
      }
    }
    return builder.finish()
  }
  class SegmentsPlugin {
    constructor(view) { this.decorations = build(view) }
    update(update) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view)
    }
  }
  return ViewPlugin.fromClass(SegmentsPlugin, { decorations: (plugin) => plugin.decorations })
}

/**
 * LaTeX 自动补全：词表与匹配逻辑都在面板侧（opts.onComplete），内核只负责
 * 把它接进 CodeMirror 的 languageData（basicSetup 里已经装好 autocompletion，
 * 追加一个 provider 就会用上，不需要再 autocompletion() 一次）。
 * onComplete(context) 返回 { from, options:[{ label, type, detail, info, snippet? }] } 或 null；
 * 带 snippet 的项在这里转成 snippetCompletion，Tab 跳占位符由 CM 自己处理。
 */
function completionExtension(options) {
  if (!options.onComplete) return []
  // 源函数必须只造一次：languageData 的 provider 每次读 facet 都会被调，
  // 若在里面 new 一个函数，CM 会认为「补全源换了」→ 每帧重启补全，弹窗永远出不来。
  const source = (context) => {
    let result = null
    try {
      result = options.onComplete(context)
    } catch (error) {
      result = null
    }
    if (!result || !Array.isArray(result.options) || !result.options.length) return null
    const from = typeof result.from === 'number' ? result.from : context.pos
    return {
      from,
      options: result.options.map((option) => (
        option && option.snippet ? snippetCompletion(option.snippet, option) : option
      ))
    }
  }
  const data = [{ autocomplete: source }]
  return EditorState.languageData.of(() => data)
}

/**
 * 造一个编辑器实例。
 * opts: { doc, onChange(text), onSave(), onCompile(), wrap?:boolean, readOnly?:boolean,
 *         getSegments(text), onComplete(context) }
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
    },
    // 查找 / 替换交给面板自己的浮层（用户要求照搬墨灵桌面版那套 UI），
    // 所以这里必须先把 CM 自带面板的 Mod-f 抢下来（basicSetup 里的 searchKeymap
    // 也绑了 Mod-f，谁在前谁生效 —— customKeys 排在最前面）。
    {
      key: 'Mod-f',
      preventDefault: true,
      run: () => { if (options.onSearch) options.onSearch('find'); return true }
    },
    {
      key: 'Mod-h',
      preventDefault: true,
      run: () => { if (options.onSearch) options.onSearch('replace'); return true }
    },
    // F3 / Shift+F3 = 下一个 / 上一个（桌面版就是 CM 的 searchKeymap 绑的 F3，
    // 但那条会弹 CM 自带面板，所以这里先抢下来转给浮层）
    {
      key: 'F3',
      preventDefault: true,
      run: () => {
        if (!options.onSearchStep) return false
        options.onSearchStep(1)
        return true
      }
    },
    {
      key: 'Shift-F3',
      preventDefault: true,
      run: () => {
        if (!options.onSearchStep) return false
        options.onSearchStep(-1)
        return true
      }
    },
    // Esc：浮层开着就关掉（返回 false 时交还给 CM，不影响别的 Esc 行为）
    {
      key: 'Escape',
      run: () => (options.onSearchEscape ? options.onSearchEscape() : false)
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
      // 面板分词结果涂到行内（见 segmentsExtension）；自动补全源（见 completionExtension）
      segmentsExtension(options),
      completionExtension(options),
      // 查找匹配的着色层（面板自己算位置，这里只负责涂；见 setSearchMarks）
      searchMarkField,
      readOnlyCompartment.of(EditorState.readOnly.of(Boolean(options.readOnly))),
      wrapCompartment.of(wrapExtension(options.wrap !== false)),
      // 双击 → 行号（可选）；右键 → 行号 + 事件（面板据此弹自己的"定位到 PDF"菜单）
      EditorView.domEventHandlers({
        dblclick: (event, view) => {
          if (!options.onDblClick) return false
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos == null) return false
          options.onDblClick(view.state.doc.lineAt(pos).number)
          return false
        },
        contextmenu: (event, view) => {
          if (!options.onContextMenu) return false
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos == null) return false
          event.preventDefault()
          options.onContextMenu(view.state.doc.lineAt(pos).number, event)
          return true
        }
      }),
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

/* ------------------------------------------------------------------ *
 * 查找 / 替换（面板自己画 UI，这里只提供「选中一段」「改多处」「涂匹配色」）
 * ------------------------------------------------------------------ */

/**
 * 涂搜索匹配：ranges = [{from, to}]（文档内绝对位置），current = 当前命中下标。
 * 用 Decoration.mark 而不是 CM 自带的搜索面板高亮 —— 自带高亮只在 openSearchPanel
 * 之后才涂（searchHighlighter 里判 `if (!panel ...) return Decoration.none`），
 * 而我们不要那个面板，所以自己维护一份 DecorationSet。
 * 颜色复用 molingTheme 里已有的 .cm-searchMatch / .cm-searchMatch-selected。
 */
const setSearchMarksEffect = StateEffect.define()

function buildSearchDeco(ranges, current) {
  const list = Array.isArray(ranges) ? ranges : []
  const marks = []
  for (let i = 0; i < list.length; i++) {
    const range = list[i]
    const from = Math.max(0, Number(range && range.from) || 0)
    const to = Math.max(from, Number(range && range.to) || 0)
    if (to <= from) continue      // 零宽匹配涂不出东西，跳过
    marks.push(Decoration.mark({
      class: i === current ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch'
    }).range(from, to))
  }
  marks.sort((a, b) => a.from - b.from)
  return Decoration.set(marks, true)
}

const searchMarkField = StateField.define({
  create() { return Decoration.none },
  update(deco, tr) {
    // 文档变了位置就跟着挪（替换后标记不会错位），再让显式 setSearchMarks 覆盖
    let next = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setSearchMarksEffect)) next = buildSearchDeco(effect.value.ranges, effect.value.current)
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

/** 涂匹配（传空数组即清空）。 */
function setSearchMarks(view, ranges, current) {
  if (!view) return
  view.dispatch({ effects: setSearchMarksEffect.of({ ranges: ranges || [], current: Number(current) || 0 }) })
}

/** 选中 [from, to) 并滚到中间 —— 查找「下一个/上一个」用它。 */
function selectRange(view, from, to) {
  if (!view) return
  const length = view.state.doc.length
  const start = Math.max(0, Math.min(length, Number(from) || 0))
  const end = Math.max(start, Math.min(length, Number(to) == null ? start : Number(to)))
  view.dispatch({
    selection: { anchor: start, head: end },
    effects: EditorView.scrollIntoView(start, { y: 'center' })
  })
  view.focus()
}

/**
 * 一次性改多处：edits = [{from, to, insert}]（位置都按**改之前**的文档算，跟 CM 的 changes 一致）。
 * 替换全部就靠这个 —— 分多次 dispatch 会让后面的位置全错。
 */
function applyEdits(view, edits, cursor) {
  if (!view || !Array.isArray(edits) || edits.length === 0) return
  const changes = []
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    if (!edit) continue
    changes.push({ from: Number(edit.from) || 0, to: Number(edit.to) || 0, insert: String(edit.insert == null ? '' : edit.insert) })
  }
  if (changes.length === 0) return
  const spec = { changes: changes }
  if (typeof cursor === 'number') spec.selection = { anchor: Math.max(0, Math.min(view.state.doc.length, cursor)) }
  view.dispatch(spec)
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

/**
 * 右键菜单用的标准编辑动作：撤销/重做/剪切/复制/粘贴/全选。
 * 面板把原生右键菜单接管了，所以要自己把这些"基础功能"补回来。
 */
function runCommand(view, name) {
  if (!view) return
  view.focus()
  if (name === 'selectAll') {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    return
  }
  if (name === 'undo') { undo(view); return }
  if (name === 'redo') { redo(view); return }
  if (name === 'paste') {
    const clip = window.navigator && window.navigator.clipboard
    if (clip && typeof clip.readText === 'function') {
      clip.readText().then((text) => {
        if (text) view.dispatch(view.state.replaceSelection(text))
      }).catch(() => { /* 没有剪贴板权限就算了 */ })
      return
    }
    try { document.execCommand('paste') } catch (error) { /* 忽略 */ }
    return
  }
  try { document.execCommand(name) } catch (error) { /* 忽略 */ }
}

/**
 * 当前选区（行号 1 起）。面板右键菜单「发送选中内容到对话框」用它取文本与来源行。
 */
function getSelection(view) {
  if (!view) return { text: '', fromLine: 0, toLine: 0 }
  const range = view.state.selection.main
  const text = view.state.sliceDoc(range.from, range.to)
  const fromLine = view.state.doc.lineAt(range.from).number
  const toLine = view.state.doc.lineAt(range.to).number
  return { text, fromLine, toLine }
}

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
  redo: redoAction,
  runCommand,
  getSelection,
  selectRange,
  applyEdits,
  setSearchMarks
}
