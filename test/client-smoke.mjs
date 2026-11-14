/**
 * 浏览器半侧的离线自测（不开浏览器、不起 DSH）。
 *
 * 用本地 DSH 源码 checkout 里的 React 走一遍注册流程：
 *   1. 伪造 window.__ModuleLoader__，捕获 bundle 注册；
 *   2. 执行 factory，检查导出；
 *   3. 用假 ctx 调 apply，检查「右侧栏标签类型 + 正文槽位」真的注册了（id / kind / guide / slot key）；
 *   4. 用 react-dom/server 渲染正文，捕捉组件级报错（useEffect 不跑，所以不会发请求）。
 *
 * React 找不到时跳过（退出码 0）。
 *
 *   node test/client-smoke.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
/**
 * 打勾。第二个参数是**布尔**时当断言用（false → 记失败），
 * 其余类型（字符串/数字/对象）只当附注打印。
 *
 * 为什么这么写：早期有一批断言写成 `ok('xxx', 条件)`，而 ok 当时无条件打勾，
 * 于是条件为 false 也只是少打一行「— true」，**永远是绿的**。改成按类型分派后，
 * 老写法自动变成真断言，不用逐个改写。
 */
const ok = (label, cond) => {
  if (typeof cond === 'boolean') {
    if (!cond) { failures++; console.log(`  ✗ ${label}`); return }
    console.log(`  ✓ ${label}`)
    return
  }
  const detail = cond === undefined || cond === null || cond === '' ? '' : String(cond)
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}
const bad = (label, detail = '') => { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
const skip = (label) => console.log(`  – ${label}（跳过）`)

/** 在候选 checkout 里找 react / react-dom（pnpm 布局：.pnpm 下的 <name>@<ver> 目录）。 */
function findPackage(root, name) {
  const store = join(root, 'node_modules', '.pnpm')
  let entries
  try { entries = readdirSync(store) } catch { return null }
  const match = entries
    .filter((entry) => entry === name || entry.startsWith(name + '@'))
    .sort((a, b) => b.localeCompare(a))[0]
  if (!match) return null
  const dir = join(store, match, 'node_modules', name)
  try {
    readdirSync(dir)
    return dir
  } catch {
    return null
  }
}

const candidates = [
  process.env.DSH_CHECKOUT,
  'C:\\Users\\29491\\Documents\\Codex\\2026-08-19\\nih\\deepseek-harness'
].filter(Boolean)

let reactDir = null
let reactDomDir = null
for (const root of candidates) {
  const react = findPackage(root, 'react')
  const reactDom = findPackage(root, 'react-dom')
  if (react && reactDom) { reactDir = react; reactDomDir = reactDom; break }
}

if (!reactDir || !reactDomDir) {
  skip('未找到可用的 React（设置 DSH_CHECKOUT 后可启用渲染自测）')
  process.exit(0)
}

const React = await import(pathToFileURL(join(reactDir, 'index.js')).href)
const ReactDOMServer = await import(pathToFileURL(join(reactDomDir, 'server.js')).href)
console.log(`使用 React ${React.version || '?'}`)

let registration = null
globalThis.window = { __ModuleLoader__: { load(reg) { registration = reg } }, location: undefined }
await import('../lib/client.js')

console.log('1) bundle 注册')
registration && registration.id === 'dsh-plugin-moling-latex'
  ? ok('__ModuleLoader__.load 注册', registration.id)
  : bad('未注册或 id 不符', JSON.stringify(registration && registration.id))
if (!registration) {
  console.log('\n失败 1 项')
  process.exit(1)
}

console.log('2) factory 导出')
const bundle = registration.factory(function (spec) {
  if (spec === 'react') return React
  throw new Error(`client bundle 不该 require ${spec}`)
})
typeof bundle.apply === 'function' ? ok('导出 apply') : bad('缺少 apply')
Array.isArray(bundle.inject) ? ok('导出 inject', bundle.inject.join(',')) : bad('缺少 inject')
bundle.KIND === 'moling' ? ok('KIND', bundle.KIND) : bad('KIND 不符', String(bundle.KIND))

console.log('3) 右侧栏注册')
const seen = { types: [], slots: [] }
const fakeCtx = {
  effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  get() { return undefined },
  sidebarRightTabs: {
    register(options) { seen.types.push(options); return () => {} }
  },
  slots: {
    inject(key, callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {} },
    register(spec, component) { seen.slots.push({ spec, component }); return () => {} }
  }
}
bundle.apply(fakeCtx)

const type = seen.types[0]
if (!type) bad('未注册标签类型')
else {
  type.id === 'dsh-plugin-moling-latex' ? ok('类型 id', type.id) : bad('类型 id 不符', String(type.id))
  type.kind === 'moling' ? ok('类型 kind', type.kind) : bad('类型 kind 不符', String(type.kind))
  Array.isArray(type.guide) && type.guide.length === 1 ? ok('指南卡片入口', String(type.guide[0].title())) : bad('缺少 guide 入口')
  type.keepMounted === true ? ok('keepMounted') : bad('keepMounted 未开')
}

const slot = seen.slots[0]
if (!slot) bad('未注册正文槽位')
else {
  slot.spec.name === 'sidebar.right.pane.tab' ? ok('槽位 sidebar.right.pane.tab') : bad('槽位名不符', slot.spec.name)
  slot.spec.key === 'dsh-plugin-moling-latex' ? ok('槽位 key = 类型 id') : bad('槽位 key 不符', String(slot.spec.key))
}

console.log('4) 启动页（默认视图，不应自动进入某个项目）')
try {
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  const checks = [
    ['大标题', html.includes('ml-h1') && html.includes('墨灵 LaTeX')],
    ['标题区带墨灵 logo（内联 SVG）',
      html.includes('ml-brand') && html.includes('ml-brand-mark') &&
      html.includes('viewBox="0 0 512 512"') && html.includes('ml-brand-grad')],
    ['副标题', html.includes('本地一体化')],
    ['启动：新建文档', html.includes('新建文档')],
    ['启动：打开文件夹', html.includes('打开文件夹')],
    ['启动：打开文件', html.includes('打开文件…')],
    ['快捷键提示', html.includes('Ctrl+N') && html.includes('Ctrl+K')],
    ['空历史提示', html.includes('还没有打开记录')],
    ['提示栏', html.includes('提示') && html.includes('TeX 环境')],
    ['没有自动进入工作台（无右栏）', !html.includes('width:45%')],
    ['没有自动进入工作台（无 PDF 页签）', !html.includes('>PDF<')],
    ['不带默认工作区路径', !html.includes('车辆动力学软件')]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
  console.log(`     渲染 HTML ${html.length} 字节`)
} catch (error) {
  bad('启动页渲染抛错', String(error.message))
}

console.log('5) 启动页：最近 / 模板卡片')
try {
  const store = bundle.__store
  const now = Date.now()
  store.view = 'welcome'
  store.recents = [
    // 故意让文件比工作区更新：分组后必须仍是「工作区」在前、「文件」在后
    { kind: 'file', root: 'E:/proj/paper', value: 'main.tex', title: 'main.tex', at: now - 60000 },
    { kind: 'dir', value: 'E:/proj/paper', title: 'paper', at: now - 120000 }
  ]
  store.workspaces = [{ path: 'E:/proj/paper', title: 'paper', kind: 'workspace' }]
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))

  const rowCount = (html.match(/class="ml-row"/g) || []).length
  const checks = [
    ['「最近」小节', html.includes('>最近<')],
    ['分组小标题：工作区', html.includes('工作区 · ')],
    ['分组小标题：文件', html.includes('文件 · ')],
    ['工作区组排在文件组前（不混排）',
      html.indexOf('工作区 · ') > -1 && html.indexOf('工作区 · ') < html.indexOf('文件 · ')],
    ['最近项目行', html.includes('paper') && html.includes('E:/proj/paper')],
    ['最近文件行', html.includes('main.tex')],
    ['已去掉 DSH 工作区列表', !html.includes('DSH 工作区')],
    ['「模板」入口卡（浏览模板库）', html.includes('浏览模板库') && html.includes('中文论文 · 英文论文 · 简历 · 幻灯片 · 实验报告等内置模板')],
    ['启动页不再罗列模板（模板清单只在二级弹窗里）', !html.includes('ml-tpl-card') && !html.includes('ml-tpl-search') && !html.includes('ml-tpl-grid')],
    ['空白 ctexart 骨架入口仍在启动页', html.includes('新建中文文档') && html.includes('ctexart')],
    ['行样式已就位（ml-row 多条）', rowCount >= 5]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 上限：7 个工作区 + 7 个文件 → 每组最多 5 条（总行数 = 3 启动行 + 5 + 5 = 13）
  store.recents = Array.from({ length: 7 }, function (_, i) {
    return { kind: 'dir', value: 'E:/proj/w' + i, title: 'w' + i, at: now - i }
  }).concat(Array.from({ length: 7 }, function (_, i) {
    return { kind: 'file', root: 'E:/proj/paper', value: 'f' + i + '.tex', title: 'f' + i + '.tex', at: now - i }
  }))
  const cappedHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  const cappedRows = (cappedHtml.match(/class="ml-row"/g) || []).length
  ok('两组各最多展示 5 条', cappedRows === 13)
  ok('超出的第 6 条以后不渲染',
    !cappedHtml.includes('w5.tex') && !cappedHtml.includes('>w5<') && !cappedHtml.includes('f5.tex') &&
    cappedHtml.includes('>w2<') && cappedHtml.includes('f2.tex'))
} catch (error) {
  bad('启动页列表渲染抛错', String(error.message))
}

console.log('6) 工作台：tex|pdf 两栏 + 高亮 + 行号 + 软换行')
try {
  const store = bundle.__store
  store.view = 'workbench'
  store.root = 'E:/proj/paper'
  store.tabs = [{
    id: 't1',
    root: 'E:/proj/paper',
    rel: 'main.tex',
    name: 'main.tex',
    text: [
      '% 注释行',
      '\\section{Introduction}',
      '\\begin{equation}',
      '  E = mc^2',
      '\\end{equation}',
      '\\cite{zhang2020} 与 $x_1$ 共 3 处'
    ].join('\n'),
    dirty: false
  }]
  store.activeId = 't1'
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  // 主编辑器是 CodeMirror（只在浏览器里挂载，SSR 渲染的是它的宿主 div）；
  // 语法着色/行号/换行这些断言针对回退实现，直接渲染回退组件来验证。
  const ed = ReactDOMServer.renderToStaticMarkup(
    React.createElement(bundle.__LegacyEditor, { tab: store.tabs[0], store: store }))

  const checks = [
    ['首页按钮', html.includes('首页')],
    ['「目录」按钮已去掉', !html.includes('>目录<')],
    ['文件树开关（按钮名是「文件树」不是「树」）', html.includes('>文件树<')],
    ['文件大纲开关（按钮名是「文件大纲」不是「提纲」）', html.includes('>文件大纲<')],
    ['编译按钮', html.includes('编译')],
    ['日志页签', html.includes('日志')],
    ['PDF 页签', html.includes('PDF')],
    ['状态行', html.includes('就绪')],
    ['左右两栏（右栏 45.0%）', html.includes('width:45.0%')],
    ['tex/pdf 分隔条可拖动', html.includes('col-resize')],
    ['挂载 CodeMirror 宿主', html.includes('ml-cm')],
    ['渲染出 1~6 行行号', ed.includes('data-line="1"') && ed.includes('data-line="6"')],
    ['命令着色（桌面版紫 #c678dd）', ed.includes('#c678dd')],
    ['环境名着色（同桌面版命令紫，不再是红色）', ed.includes('dsw-alias-label-secondary') && !ed.includes('dsw-alias-state-error-primary, #e06c5a); font-weight: 500')],
    ['引用键着色（桌面版转义青 #56b6c2）', ed.includes('#56b6c2')],
    ['数学着色（桌面版字符串绿 #98c379）', ed.includes('#98c379')],
    ['数字着色（桌面版数字橙 #d19a66）', ed.includes('#d19a66')],
    ['注释着色（label-secondary）', ed.includes('dsw-alias-label-secondary')],
    ['章节行加粗', ed.includes('font-weight:600')],
    ['数学环境跨行传递（equation 内无未闭合）', !ed.includes('undefined')],
    ['textarea 软换行', ed.includes('white-space:pre-wrap')],
    ['行号与正文同偏移', ed.includes('padding:6px 8px 6px 56px')],
    ['已去掉路径输入行', !html.includes('回车打开')],
    ['没有旧 gutter', !ed.includes('width:34px')]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
  console.log(`     渲染 HTML ${html.length} 字节 / 回退编辑器 ${ed.length} 字节`)

  store.tabs = []
  store.activeId = null
} catch (error) {
  bad('工作台渲染抛错', String(error.message))
}

console.log('7) 词法单元：真论文片段')
try {
  const tokenize = bundle.__tokenize
  const lines = tokenize([
    'Platoon risk studies on controller design \\cite{somaksak2020-01_liu2026}.',
    '\\begin{align}',
    'a &= b \\\\',
    '\\end{align}',
    '占比 100\\% 的样本，见 \\ref{sec:intro}'
  ].join('\n'))

  const find = (index, text) => (lines[index].segments.find((segment) => segment.text === text) || {})
  const keySeg = find(0, 'somaksak2020-01_liu2026')
  const envSeg = find(1, 'align')
  const cmdSeg = find(1, '\\begin')
  const endEnv = find(3, 'align')
  const line3AllMath = lines[2].segments.length > 0 && lines[2].segments.every((segment) => segment.style && /#98c379/.test(segment.style.color))

  const checks = [
    ['\\cite 命令着色（桌面版紫 #c678dd）', Boolean(cmdSeg.style && /#c678dd/.test(cmdSeg.style.color))],
    ['\\cite 键单独着色（桌面版转义青 #56b6c2）', Boolean(keySeg.style && /#56b6c2/.test(keySeg.style.color))],
    ['\\begin 的 align 环境名着色（桌面版命令紫 #c678dd）', Boolean(envSeg.style && /#c678dd/.test(envSeg.style.color))],
    ['环境内公式跨行按数学着色（桌面版字符串绿 #98c379）', line3AllMath],
    ['\\end 的环境名同样着色', Boolean(endEnv.style && /#c678dd/.test(endEnv.style.color))],
    ['\\% 转义不会把整行变注释', lines[4].segments.some((segment) => segment.style === null && segment.text.indexOf('的样本') >= 0)],
    ['\\ref 键着色', Boolean((find(4, 'sec:intro') || {}).style)],
    ['行数一致', lines.length === 5]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
} catch (error) {
  bad('词法单元抛错', String(error.message))
}

console.log('8) 最近文件的绝对路径（修复「文件不存在」）')
try {
  const abs = bundle.__absolutePath
  const recent = bundle.__recentAbsolute
  const cases = [
    ['相对路径拼绝对路径', abs('E:/proj/paper', 'main.tex') === 'E:\\proj\\paper\\main.tex'],
    ['去掉根目录尾部分隔符', abs('E:\\proj\\paper\\', 'main.tex') === 'E:\\proj\\paper\\main.tex'],
    ['子目录相对路径转换', abs('E:/proj', 'chap/a.tex') === 'E:\\proj\\chap\\a.tex'],
    ['老记录（只有相对路径）能补全', recent({ kind: 'file', root: 'E:/proj', value: 'main.tex' }) === 'E:\\proj\\main.tex'],
    ['新记录直接用 abs', recent({ kind: 'file', abs: 'E:\\proj\\x.tex', value: 'x.tex', root: 'E:/proj' }) === 'E:\\proj\\x.tex'],
    ['绝对路径原样保留', recent({ kind: 'file', value: 'C:\\abs\\z.tex' }) === 'C:\\abs\\z.tex']
  ]
  for (const [label, passed] of cases) passed ? ok(label) : bad(label)
} catch (error) {
  bad('路径单元抛错', String(error.message))
}

console.log('9) 高亮行级缓存（打字不全量重排）')
try {
  const build = bundle.__buildHighlight
  const lines = []
  for (let i = 0; i < 2000; i++) lines.push(`Line ${i} \\cite{k${i}} and $x_${i}$`)
  const doc1 = lines.join('\n')

  const t0 = Date.now()
  const first = build(doc1, 'tab-perf')
  const buildMs = Date.now() - t0

  // 改中间一行的一个字符（模拟打字）
  lines[1000] = lines[1000] + 'z'
  const doc2 = lines.join('\n')
  const t1 = Date.now()
  const second = build(doc2, 'tab-perf')
  const editMs = Date.now() - t1

  const caseList = [
    ['元素数量不变', first.length === 2000 && second.length === 2000],
    ['未改动的行复用同一元素', second[0] === first[0] && second[1999] === first[1999]],
    ['被改的行重新构建', second[1000] !== first[1000]],
    ['改一行远快于全量', editMs <= Math.max(5, buildMs)],
    ['全量构建耗时可接受', buildMs < 2000]
  ]
  for (const [label, passed] of caseList) passed ? ok(label) : bad(label)
  console.log(`     2000 行：全量 ${buildMs}ms / 单行编辑 ${editMs}ms`)
} catch (error) {
  bad('缓存测试抛错', String(error.message))
}

console.log('10) 换行开关 + 滚动条宽度补偿（光标错位修复的守卫）')
try {
  const store = bundle.__store
  // 这些断言针对回退实现的样式（主编辑器是 CodeMirror，样式由内核自己带）
  const render = () => ReactDOMServer.renderToStaticMarkup(
    React.createElement(bundle.__LegacyEditor, { tab: store.tabs[0], store: store }))
  const renderPanel = () => ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  store.view = 'workbench'
  store.tabs = [{ id: 't-wrap', root: 'E:/x', rel: 'a.tex', name: 'a.tex', text: 'a\nb', dirty: false }]
  store.activeId = 't-wrap'

  store.wrap = true
  const onHtml = render()
  store.wrap = false
  const offHtml = render()
  const panelHtml = renderPanel()

  const checks = [
    ['换行开关按钮存在', panelHtml.includes('换行')],
    ['换行开：pre-wrap', /white-space:pre-wrap/.test(onHtml)],
    ['换行关：white-space:pre', /white-space:pre(?!-wrap)/.test(offHtml)],
    ['换行关：word-break 复位', /word-break:normal/.test(offHtml)],
    ['两层都用 overflow-wrap', /overflow-wrap:break-word/.test(onHtml)],
    ['高亮层带 padding-right（预留滚动条）', /padding-right:\d+px/.test(onHtml)]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  store.wrap = true
  store.tabs = []
  store.activeId = null
} catch (error) {
  bad('换行/滚动条测试抛错', String(error.message))
}

console.log('11) PDF 预览：降分辨率图片（不把整份 PDF 交给内置阅读器）')
try {
  const store = bundle.__store
  const render = () => ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  store.view = 'workbench'
  store.pane = 'pdf'
  store.tabs = [{ id: 't-pdf', root: 'E:/p/paper', rel: 'main.tex', name: 'main.tex', text: 'x', dirty: false }]
  store.activeId = 't-pdf'
  store.pdfRoot = 'E:/p/paper'
  store.pdfRel = 'main.pdf'
  store.pdfRev = '1712345678'
  store.pdfPages = 3
  store.pdfRaster = true
  store.pdfDpi = 96
  store.pdfUrl = ''   // 走图片预览时不需要 blob

  const html = render()
  const pageUrl = bundle.__pdfPageUrl(1)
  const checks = [
    ['页数决定图片张数', (html.match(/<img /g) || []).length === 3],
    ['单页地址走 /moling/api/pdf-page', pageUrl.startsWith('/moling/api/pdf-page?')],
    ['带 dpi 参数', pageUrl.includes('dpi=96')],
    ['带 mtime 版本号（可长期缓存）', pageUrl.includes('v=1712345678')],
    ['首屏立即加载、其余懒加载', /loading="eager"/.test(html) && /loading="lazy"/.test(html)],
    ['不再用 iframe 预览', !/<iframe/.test(html)],
    ['清晰度三档 72/96/144', bundle.__DPI_CHOICES.map((choice) => choice.value).join() === '72,96,144'],
    ['按加载前占位比例（防跳动）', /aspect-ratio:1\/1\.414/.test(html) || /aspect-ratio:1 \/ 1\.414/.test(html)]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 中文目录要编码，否则 query 里的 & 与中文都会出问题
  store.pdfRel = '论文/main.pdf'
  const encoded = bundle.__pdfPageUrl(1)
  encoded.includes(encodeURIComponent('论文/main.pdf')) && !encoded.includes('论文')
    ? ok('中文路径按 encodeURIComponent 编码')
    : bad('中文路径没编码', encoded)

  // poppler 不可用 / 取图失败 → 回退浏览器内置阅读器
  store.pdfRel = 'main.pdf'
  store.pdfRaster = false
  store.pdfUrl = 'blob:fake'
  const fallback = render()
  const fallbackOk = /<iframe/.test(fallback) && fallback.includes('blob:fake')
  fallbackOk ? ok('回退路径仍是内置阅读器') : bad('回退路径没渲染 iframe')

  store.pdfRaster = true
  store.pdfUrl = ''
  store.pdfPages = 0
  store.pdfRel = ''
  store.pdfRoot = ''
  store.pdfRev = ''
  store.tabs = []
  store.activeId = null
} catch (error) {
  bad('PDF 预览测试抛错', String(error.message))
}

console.log('12) 空工作台不炸（没有打开的 tex 时 textarea 不存在）')
try {
  const store = bundle.__store
  const render = () => ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  store.view = 'workbench'
  store.tabs = []
  store.activeId = null
  store.pdfRel = ''
  store.pdfRoot = ''
  store.error = ''

  let html = ''
  let failure = null
  try { html = render() } catch (error) { failure = error }
  const checks = [
    ['无标签也能渲染工作台', !failure],
    ['给出预览占位提示', !failure && html.includes('编译成功后在这里预览 PDF')],
    ['工具栏仍在（首页/编译）', !failure && html.includes('首页') && html.includes('编译')],
    ['有错误兜底边界（不会再整块空白）', bundle.__hasBoundary === true]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label, failure ? String(failure.message) : '')
} catch (error) {
  bad('空工作台测试抛错', String(error.message))
}

console.log('13) 编辑器：CodeMirror 内核 + 回退实现')
try {
  const store = bundle.__store
  const render = () => ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  store.view = 'workbench'
  store.tabs = [{ id: 't-ed', root: 'E:/p', rel: 'main.tex', name: 'main.tex', text: '\\section{a}\n\\begin{equation}x\\end{equation}\n% c', dirty: false }]
  store.activeId = 't-ed'

  const html = render()
  const assetUrl = bundle.__kernelAssetUrl()
  const withoutKernel = (function () {
    // 模拟「内核不存在」：这时区域组件必须退回 textarea 实现
    const saved = globalThis.window.__molingCM
    delete globalThis.window.__molingCM
    const markup = ReactDOMServer.renderToStaticMarkup(
      React.createElement(bundle.__EditorArea, { tab: store.tabs[0], store: store }))
    globalThis.window.__molingCM = saved
    return markup
  })()
  const checks = [
    ['内核已内联进 client.js', typeof globalThis.window.__molingCM === 'object'],
    ['内核地址走 /moling/api/asset', assetUrl.startsWith('/moling/api/asset?name=cm6.js')],
    ['内核地址带版本号', /[?&]v=\d/.test(assetUrl)],
    ['默认挂载 CodeMirror 宿主', html.includes('ml-cm')],
    ['没内核时退回 textarea', withoutKernel.includes('<textarea')],
    ['回退实现仍有语法着色', withoutKernel.includes('#c678dd')],
    ['回退实现仍有行号 class', withoutKernel.includes('ml-hl-num')],
    ['编辑器容器在位', html.includes('ml-editor')],
    ['编辑器跳转桥可注册', typeof bundle.__editorBridge === 'object' && 'jumpTo' in bundle.__editorBridge]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 回退编辑器的根节点必须绝对铺满：以前套了一层 flex:1，父级不是 flex 容器 → 高度 0 → 整个编辑区空白
  const legacy = ReactDOMServer.renderToStaticMarkup(
    React.createElement(bundle.__LegacyEditor, { tab: store.tabs[0], store: store }))
  const legacyFilled = /position:absolute;inset:0/.test(legacy)
  const legacyCollapsed = /flex:1;position:relative/.test(legacy)
  legacyFilled && !legacyCollapsed
    ? ok('回退编辑器根节点绝对铺满（不会塌成 0 高）')
    : bad('回退编辑器根节点样式不对', legacy.slice(0, 140))

  // 回退编辑器在 CodeMirror 存在时应让路（区域组件按内核状态切换）
  globalThis.window.__molingCM = { create() {}, destroy() {}, setWrap() {}, setDoc() {}, gotoLine() {} }
  const withKernel = ReactDOMServer.renderToStaticMarkup(
    React.createElement(bundle.__EditorArea, { tab: store.tabs[0], store: store }))
  delete globalThis.window.__molingCM
  withKernel.includes('ml-cm') && !withKernel.includes('<textarea')
    ? ok('有内核时挂载 CodeMirror 宿主')
    : bad('有内核时没切到 CodeMirror', withKernel.slice(0, 120))

  store.tabs = []
  store.activeId = null
} catch (error) {
  bad('编辑器测试抛错', String(error.message))
}

console.log('14) 顶栏按钮 / 编译下拉 / PDF 缩放与定位环')
try {
  const store = bundle.__store
  const render = () => ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  store.view = 'workbench'
  store.pane = 'pdf'
  store.tabs = [{ id: 't-ux', root: 'E:/p', rel: 'main.tex', name: 'main.tex', text: 'a', dirty: true }]
  store.activeId = 't-ux'
  store.pdfRel = 'main.pdf'
  store.pdfRoot = 'E:/p'
  store.pdfRev = '99'
  store.pdfPages = 2
  store.pdfRaster = true
  store.pdfDpi = 96
  store.pdfZoom = 2
  store.syncMark = { page: 1, x: 100, y: 200 }
  store.pdfPageSize = { width: 595.276, height: 841.89 }

  const html = render()
  const percent = bundle.__syncPercent
  // 展开编译方式下拉，验证三种模式在菜单里
  store.compileMenu = true
  const compileMenuHtml = render()
  store.compileMenu = false
  const checks = [
    ['顶栏有「换行」', html.includes('>换行<')],
    ['顶栏有「保存」分体按钮（默认手动保存）', html.includes('>手动保存<') && html.includes('>▾<')],
    // 顶栏分组：文件树+文件大纲 一个圆角底色区，换行+保存+新建+自编 另一个
    ['分组一：文件树 + 文件大纲 同底色圆角区', (function () {
      const from = html.indexOf('data-btn-group="view"')
      const to = html.indexOf('data-btn-group="edit"')
      const seg = from > -1 && to > from ? html.slice(from, to) : ''
      return seg.includes('>文件树<') && seg.includes('>文件大纲<')
    })()],
    ['分组二：换行 + 保存 + 新建 + 自编 同底色圆角区', (function () {
      const from = html.indexOf('data-btn-group="edit"')
      if (from < 0) return false
      const at = (text) => html.indexOf(text, from)
      const wrap = at('>换行<')
      const save = at('>手动保存<')
      const create = at('>新建<')
      const auto = at('>自编<')
      return wrap > from && save > wrap && create > save && auto > create
    })()],
    ['组内按钮不带独立边框（btnFlat 透明边框）', html.includes('border:1px solid transparent')],
    // 两组各自一色：style 属性写在 data-btn-group 标记之前，所以按位置夹逼
    ['分组一（树｜提纲）是蓝色（rgba 兜底 + brand token 增强）', (function () {
      const blue = html.indexOf('background-color:rgba(77,139,248,0.15)')
      const view = html.indexOf('data-btn-group="view"')
      const brand = html.indexOf('var(--dsw-alias-brand-primary')
      return blue > -1 && view > blue && brand > -1 && brand < view
    })()],
    ['分组二（换行｜保存｜新建）是橙色（rgba 兜底 + warn token 增强）', (function () {
      const amber = html.indexOf('background-color:rgba(240,160,60,0.15)')
      const view = html.indexOf('data-btn-group="view"')
      const edit = html.indexOf('data-btn-group="edit"')
      const warn = html.indexOf('var(--dsw-alias-state-warn-primary')
      return amber > view && amber < edit && warn > view && warn < edit
    })()],
    ['组内竖分隔线：树 | 提纲 一条、换行 | 保存 | 新建 | 自编 三条', (function () {
      const viewFrom = html.indexOf('data-btn-group="view"')
      const editFrom = html.indexOf('data-btn-group="edit"')
      const viewSeg = viewFrom > -1 && editFrom > viewFrom ? html.slice(viewFrom, editFrom) : ''
      const editSeg = editFrom > -1 ? html.slice(editFrom, editFrom + 2200) : ''
      const count = (text) => (text.match(/data-btn-sep/g) || []).length
      return count(viewSeg) === 1 && count(editSeg) === 3
    })()],
    // 顶栏所有圆角矩形外高统一 24px（首页按钮 / 工作区下拉 / 两个按钮组 / 连接胶囊 / 编译按钮）
    ['顶栏控件外高统一 24px（≥6 处）', (html.match(/height:24px/g) || []).length >= 6],
    ['左右两条顶栏同高（文件标签条 / pdf 工具栏各 28px）', (html.match(/height:28px/g) || []).length === 2],
    // 工具栏里所有矩形的圆角统一 6px（按钮/下拉/两个组/连接胶囊/编译按钮/状态栏切换）
    ['工具栏圆角统一 6px（不再有 8/12 混用）',
      !html.includes('border-radius:8px') && !html.includes('border-radius:12px') &&
      (html.match(/border-radius:6px/g) || []).length >= 6],
    ['组内按钮 18px（24 − 组内边距 4 − 组边框 2）', html.includes('height:18px')],
    // 日志 / PDF 切换挪到状态栏最右：出现在「就绪」之后，且接近文档结尾
    ['日志/PDF 在状态栏', html.indexOf('>日志<') > html.indexOf('就绪') || /日志 \(\d\)/.test(html.slice(html.indexOf('就绪')))],
    ['状态栏在文档尾部', (function () {
      const tail = html.slice(Math.max(0, html.length - 900))
      return tail.includes('>日志<') || /日志 \(\d\)/.test(tail)
    })()],
    ['编译是分体按钮（编译 3/4 在左、三角 1/4 在右）',
      html.includes('width:75%') && html.includes('width:25%') && html.indexOf('width:75%') < html.indexOf('width:25%')],
    ['右侧是小三角', html.includes('>▾<')],
    ['编译按钮贴着四字标签（86px 且不换行）', html.includes('width:86px') && html.includes('white-space:nowrap')],
    ['下拉与按钮等宽、左右边对齐', compileMenuHtml.includes('position:absolute;top:100%;left:0;right:0')],
    ['展开后有三种方式', compileMenuHtml.includes('完整编译') && compileMenuHtml.includes('快速编译') && compileMenuHtml.includes('从头编译')],
    ['按钮上显示当前编译方式', html.includes('>完整编译<') || html.includes('>快速编译<') || html.includes('>从头编译<')],
    ['右键菜单默认不显示', !html.includes('定位到 PDF 位置')],
    ['缩放到 200% 时页面宽度翻倍', html.includes('width:200.00%')],
    ['页面容器不再被 maxWidth:100% 卡死（放大可超出窗口、可横向拖动）',
      html.includes('position:relative;margin:0 auto 10px') && !html.includes('margin:0 auto 10px;max-width:100%')],
    ['显示缩放百分比', html.includes('200%')],
    ['右栏有缩放按钮', html.includes('>－<') && html.includes('>＋<')],
    ['顶栏有「适应窗口」按钮', html.includes('>适应<') && html.includes('整页适应当前窗口')],
    ['定位环渲染在页面上', html.includes('border-radius:50%')],
    ['定位环按页面尺寸换算百分比', percent(100, 595.276) === '16.799%' && percent(200, 841.89) === '23.756%'],
    ['页面可点击定位（crosshair 光标）', html.includes('crosshair')],
    ['编译方式常量是三档', bundle.__COMPILE_MODES.map((x) => x[0]).join() === 'full,quick,clean']
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label, label.includes('百分比') ? String(percent(100, 595.276)) : '')

  // 右键菜单：基础编辑功能 + 定位
  store.menu = { x: 40, y: 60, line: 3 }
  const menuHtml = render()
  const menuOk = menuHtml.includes('定位到 PDF 位置（第 3 行）') && menuHtml.includes('position:fixed')
  menuOk ? ok('右键菜单渲染「定位到 PDF 位置」') : bad('右键菜单没渲染', menuHtml.slice(-300))
  const baseItems = ['撤销', '重做', '剪切', '复制', '粘贴', '全选']
  const missing = baseItems.filter((label) => !menuHtml.includes(label))
  missing.length === 0 ? ok('右键菜单带基础编辑功能') : bad('缺基础菜单项', missing.join('/'))
  store.menu = null

  // 编译结果条：底部状态栏居中，成功绿、失败红
  store.notice = '编译成功 · pdflatex · 3.1s · 2 趟'
  store.noticeOk = true
  const okHtml = render()
  store.noticeOk = false
  const failHtml = render()
  const noticeChecks = [
    ['结果条居中（绝对定位 + translateX）', okHtml.includes('translateX(-50%)') && okHtml.includes('left:50%')],
    ['成功是绿色', okHtml.includes('编译成功') && okHtml.includes('state-success-primary')],
    ['失败是红色', failHtml.includes('state-error-primary')],
    ['结果条只出现一次（不再挤在预览区底部）', (okHtml.match(/>编译成功 · pdflatex/g) || []).length === 1]
  ]
  for (const [label, passed] of noticeChecks) passed ? ok(label) : bad(label)
  store.notice = ''
  store.noticeOk = true

  // 提纲浮层
  store.outlineOpen = true
  store.outline = {
    rel: 'main.tex',
    lines: 40,
    labels: 2,
    cites: 3,
    sections: [
      { level: 2, command: 'section', title: '引言', line: 3 },
      { level: 3, command: 'subsection', title: '车辆模型', line: 12 }
    ]
  }
  const outlineHtml = render()
  const outlineChecks = [
    ['顶栏有「文件大纲」按钮', outlineHtml.includes('>文件大纲<')],
    ['顶栏有「新建」按钮（文件大纲旁边）', outlineHtml.includes('>新建<') && outlineHtml.indexOf('>文件大纲<') < outlineHtml.indexOf('>新建<')],
    ['顶栏有「自编」按钮（自动编译开关，在新建右边）',
      outlineHtml.includes('>自编<') && outlineHtml.indexOf('>新建<') < outlineHtml.indexOf('>自编<')],
    ['浮层显示章节标题', outlineHtml.includes('引言') && outlineHtml.includes('车辆模型')],
    ['浮层显示行号', outlineHtml.includes('>12<') || outlineHtml.includes('>3<')],
    ['浮层贴左下角', outlineHtml.includes('bottom:8') && outlineHtml.includes('left:8')],
    ['浮层可关闭', outlineHtml.includes('>×<')]
  ]
  for (const [label, passed] of outlineChecks) passed ? ok(label) : bad(label)

  // 提纲解析是客户端做的（不依赖宿主端点）
  const parsed = bundle.__parseOutlineText([
    '% \\section{注释里的不算}',
    '\\section{引言}',
    '\\label{sec:intro}',
    '\\subsection{车辆模型}',
    '\\subsubsection{轮胎}'
  ].join('\n'))
  const titles = parsed.sections.map((item) => item.title).join('|')
  titles === '引言|车辆模型|轮胎' && parsed.sections[1].line === 4
    ? ok('客户端提纲解析（跳过注释、层级与行号）', titles)
    : bad('提纲解析不对', JSON.stringify(parsed.sections))
  store.outlineOpen = false
  store.outline = null

  store.pdfZoom = 1
  store.syncMark = null
  store.pdfPageSize = null
  store.pdfRel = ''
  store.pdfPages = 0
  store.tabs = []
  store.activeId = null
} catch (error) {
  bad('顶栏/缩放测试抛错', String(error.message))
}

console.log('15) DSH 工作区连接状态 + 发送选中内容')
try {
  const store = bundle.__store
  const connectionOf = bundle.__connectionOf
  const normalizePath = bundle.__normalizePath
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const render = () => ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  store.view = 'workbench'
  store.root = 'E:/proj/paper'
  store.tabs = [{ id: 't-link', root: 'E:/proj/paper', rel: 'main.tex', name: 'main.tex', text: '\\section{a}\nline2\nline3', dirty: false }]
  store.activeId = 't-link'

  const linked = connectionOf('E:/proj/paper', [{ path: 'e:\\proj\\paper', title: 'paper' }])
  const none = connectionOf('E:/proj/paper', [{ path: 'E:\\other\\novel', title: 'novel' }])
  const conflict = connectionOf('E:/proj/paper', [{ path: 'D:\\backup\\paper', title: 'paper' }])
  const unknown = connectionOf('E:/proj/paper', [])
  // 只是插件打开过的目录（kind: 'opened'）不算「已连接工作区」—— 之前就错在这里
  const openedOnly = connectionOf('E:/proj/paper', [{ path: 'E:/proj/paper', title: 'paper', kind: 'opened' }])
  const checks = [
    ['路径命中 → 已连接', linked.state === 'linked' && linked.text.includes('已连接')],
    ['没有交集 → 未连接', none.state === 'none' && none.text.includes('未连接')],
    ['同名不同路径 → 冲突', conflict.state === 'conflict'],
    ['列表为空 → 未知', unknown.state === 'unknown'],
    ['kind:opened 不算已连接', openedOnly.state !== 'linked'],
    ['路径归一化（斜杠/大小写/尾斜杠）', normalizePath('E:/Proj/Paper/') === 'e:\\proj\\paper']
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 顶栏悬浮状态胶囊
  store.workspaces = [{ path: 'E:/proj/paper', title: 'paper', kind: 'workspace' }]
  const linkedHtml = render()
  store.workspaces = [{ path: 'E:/other/novel', title: 'novel', kind: 'workspace' }]
  const noneHtml = render()
  store.workspaces = [{ path: 'E:/proj/paper', title: 'paper', kind: 'opened' }]
  const openedHtml = render()
  const pillChecks = [
    ['已连接时显示绿字', linkedHtml.includes('已连接 DSH 工作区')],
    ['未连接时提示导入', noneHtml.includes('未连接 DSH 工作区')],
    ['只有 opened 目录时也算未连接', openedHtml.includes('未连接 DSH 工作区')],
    ['状态胶囊带说明（title）', linkedHtml.includes('这个项目已在左侧工作区')],
    ['未连接时胶囊可点提示导入', noneHtml.includes('点一下把')]
  ]
  for (const [label, passed] of pillChecks) passed ? ok(label) : bad(label)

  // 右键菜单里的发送项 + 生成的消息体
  store.menu = { x: 10, y: 10, line: 2 }
  const menuHtml = render()
  store.menu = null
  menuHtml.includes('发送选中内容到对话框')
    ? ok('右键菜单有「发送选中内容到对话框」')
    : bad('右键菜单缺发送项')
  !menuHtml.includes('只发文件引用')
    ? ok('「带全文」那个形态已去掉（只留一行引用）')
    : bad('右键菜单还留着旧的带全文形态')

  // 发出去的形态：一行 `@文件:行范围 「选中内容」` —— 引用 + 选中文字，不糊代码块
  const compact = bundle.__formatSelectionCompact('main.tex', 20, 20, '动作值函数')
  compact.startsWith('@main.tex:20')
    && compact.includes('`动作值函数`')
    && !compact.includes('```')
    && compact.split('\n')[0] === '@main.tex:20 `动作值函数`'
    ? ok('一行：@文件:行范围 + 选中的那段文字') : bad('紧凑形态不对', JSON.stringify(compact))
  bundle.__formatSelectionCompact('main.tex', 5, 5, '  a\n  b  ').split('\n')[0] === '@main.tex:5 `a b`'
    ? ok('选中文字压成一行（换行/缩进归一）') : bad('选中文字没归一')
  bundle.__formatSelectionCompact('main.tex', 5, 5, 'x'.repeat(200)).length < 200
    ? ok('超长选中内容会截断（≤120 字）') : bad('超长没截断')
  !bundle.__formatSelectionCompact('main.tex', 5, 5, '').includes('`')
    ? ok('没选中文字时只剩引用（不出现空反引号）') : bad('空选区还带反引号')
  bundle.__formatSelectionCompact('main.tex', 5, 5, 'a`b').split('\n')[0].includes('ˋ')
    ? ok('选中文字里的反引号会被替换（不破格式）') : bad('反引号没处理')
  bundle.__formatSelectionMention('sub\\a b.tex', 1, 2) === '@sub/a b.tex:1-2'
    ? ok('引用里反斜杠转正斜杠') : bad('反斜杠没转')

  // 真 chip：走作用域事件 slash/input-insert-reference（这是唯一能造 occurrence 的入口）
  ok('发了 slash/input-insert-reference 事件',
    src.includes("actx.bail(actx, 'slash/input-insert-reference'")
    && src.includes("appearance: 'file'"))
  // 顺序断言用 indexOf，别用固定字符窗口：中间隔多少行会随注释增长而变
  const setDraftAt = src.indexOf('actions.setDraft(draft)')
  const bailAt = src.indexOf("actx.bail(actx, 'slash/input-insert-reference'")
  ok('chip 之前先 setDraft 把 @引用 写进草稿', setDraftAt > 0 && bailAt > setDraftAt)
  ok('span 用 setDraft 之后的 draftRev（CAS 不能拿旧 rev）',
    src.includes('draftRev: rev')
    && src.includes("typeof after.draftRev === 'number'"))
  ok('chip 失败要能退回纯文本（不能没反应）',
    src.includes('chip.ok') && src.includes("how: 'chip 方框'"))
  ok('chip 失败原因写进状态栏（不再静默）', src.includes("'｜chip 未成：' + ((chip && chip.why) || '未知')"))
  ok('setDraft 之后等 React 喂回新 rev 再发事件（同帧读必是旧值）',
    src.includes('var waitRev = function') && /setTimeout\(waitRev, 16\)/.test(src))
  ok('等不到新 rev 就撤回草稿', /actions\.setDraft\(base\)[\s\S]{0,300}等不到新 draftRev/.test(src))
  ok('事件没被接受时把草稿撤回（不留半截）',
    /if \(!ok\)[\s\S]{0,200}actions\.setDraft\(base\)/.test(src))
  ok('会话 id 从 tab body 的注入属性里拿',
    src.includes('face.sessionId || face.session || (face.session && face.session.id)'))
  ok('inject 里声明了 sessions（不声明就拿不到服务）',
    /var inject = \[[^\]]*'sessions'/.test(src))
  // 注入面在 props.props 里（Workbench 收到的是 { props, store } 包装层）
  ok('注入属性统一走 injected(props)（读包装层会永远 undefined）',
    /function injected\(props\)/.test(src)
    && src.includes('injected(props).inputActions')
    && !/var actions = props\.inputActions/.test(src))
  ok('草稿/draftRev 从 useInput 桥接的 store.inputSnap 读（inputActions 上没有 state）',
    src.includes('store.inputSnap') && src.includes("'读不到输入框草稿（useInput 没注入）'"))
  ok('useInput 只在渲染期调（桥组件 InputBridge），不在事件处理里调',
    /function InputBridge\(props\)[\s\S]{0,200}props\.useInput\(/.test(src)
    && !/sendSelection[\s\S]{0,2000}props\.useInput\(/.test(src))
  // 带全文的格式化函数仍在（导出给测试/未来用），但**右键菜单不再走它**
  const full = bundle.__formatSelectionPayload('main.tex', 2, 3, 'a & b\n')
  full.includes('@main.tex:2-3') && full.includes('```latex\na & b\n```')
    ? ok('带全文形态的格式化函数仍可用（菜单不再调用）') : bad('带全文格式化坏了')
  !/formatSelectionPayload\(rel/.test(src.slice(src.indexOf('var sendSelection'), src.indexOf('var sendSelection') + 3000))
    ? ok('sendSelection 不再调用带全文形态') : bad('sendSelection 还在调用带全文形态')

  store.tabs = []
  store.activeId = null
  store.root = ''
  store.workspaces = []
} catch (error) {
  bad('连接状态测试抛错', String(error.message))
}

console.log('16) hook 顺序回归（React #310：提前 return 之后不能再调 hook）')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 按 4 空格缩进的 function/class 切出每个组件/函数体
  const starts = []
  const decl = /^    (?:function|class) (\w+)/gm
  let matched
  while ((matched = decl.exec(src)) !== null) starts.push({ name: matched[1], at: matched.index })
  const offenders = []
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at
    const to = i + 1 < starts.length ? starts[i + 1].at : src.length
    const body = src.slice(from, to).split('\n')
    let guard = -1
    body.forEach((line, idx) => {
      // 组件顶层的提前返回（6 空格 = 函数体第一层；嵌套回调里的 return 缩进更深，不算）
      if (guard === -1 && /^ {6}if \(.*\) return/.test(line)) { guard = idx; return }
      if (guard !== -1 && /^ {6}(?:React\.use\w+\(|use[A-Z]\w+\()/.test(line)) {
        offenders.push(`${starts[i].name} +${idx + 1} 行：${line.trim()}`)
      }
    })
  }
  offenders.length === 0
    ? ok('没有任何组件在提前 return 之后调用 hook', `扫描 ${starts.length} 个函数`)
    : bad('hook 写在了提前 return 之后（会抛 React #310）', offenders.join(' ｜ '))
} catch (error) {
  bad('hook 顺序扫描抛错', String(error.message))
}

console.log('17) 进入项目文件夹自动打开主 tex')
try {
  const pick = bundle.__pickMainTex
  const checks = [
    ['没有 .tex → 什么都不开', pick([{ rel: 'a.pdf' }, { rel: 'README.md' }]) === null],
    ['空清单 / null → 不开', pick([]) === null && pick(null) === null],
    ['根目录 main.tex 被选中', pick([{ rel: 'sub/other.tex' }, { rel: 'main.tex' }]) === 'main.tex'],
    ['子目录只有 main.tex 也选它', pick([{ rel: 'chap/main.tex' }]) === 'chap/main.tex'],
    ['根目录 main 优先于子目录 main', pick([{ rel: 'a/main.tex' }, { rel: 'main.tex' }]) === 'main.tex'],
    ['不区分大小写（MAIN.TEX）', pick([{ rel: 'MAIN.TEX' }]) === 'MAIN.TEX'],
    ['唯一一个非 main 的 .tex 也选它', pick([{ rel: 'paper.tex' }, { rel: 'ref.bib' }]) === 'paper.tex'],
    ['反斜杠路径也能识别', pick([{ rel: 'sub\\main.tex' }]) === 'sub\\main.tex'],
    // ↓ 本轮新增：没有 main.tex 时也要能挑出"最像主文件"的那个
    ['最近打开过的文件优先（用户上次看的那个）',
      pick([{ rel: 'a.tex', size: 10 }, { rel: 'b.tex', size: 99 }],
        { root: 'E:/p', recents: [{ kind: 'file', root: 'E:/p', value: 'a.tex' }] }) === 'a.tex'],
    // ↓ 关键回归：目录里躺着 main.tex 也不能抢走用户上次在看的那个
    //   （踩过的坑：模板导入散出的 main.tex 每次进项目都被自动打开，看着像"删了没删掉"）
    ['最近打开过的文件优先于 main.tex（不唯 main 马首是瞻）',
      pick([{ rel: 'main.tex', size: 999 }, { rel: 'Safety_MARL框架.tex', size: 10 }],
        { root: 'E:/p', recents: [{ kind: 'file', root: 'E:/p', value: 'Safety_MARL框架.tex' }] }) === 'Safety_MARL框架.tex'],
    ['没有最近记录时 main.tex 仍然优先', pick([{ rel: 'main.tex' }, { rel: 'other.tex', size: 999 }]) === 'main.tex'],
    ['最近记录指向的文件已被删 → 退回 main.tex',
      pick([{ rel: 'main.tex' }, { rel: 'gone.tex' }],
        { root: 'E:/p', recents: [{ kind: 'file', root: 'E:/p', value: 'deleted.tex' }] }) === 'main.tex'],
    ['最近记录属于别的项目时不认',
      pick([{ rel: 'a.tex', size: 10 }, { rel: 'b.tex', size: 99 }],
        { root: 'E:/p', recents: [{ kind: 'file', root: 'E:/other', value: 'a.tex' }] }) === 'b.tex'],
    ['根目录只有一个 .tex 时选它（章节在子目录）',
      pick([{ rel: 'sub/ch1.tex' }, { rel: 'thesis.tex' }]) === 'thesis.tex'],
    ['有多个同层 .tex → 选体积最大的（真正的论文结构）',
      pick([{ rel: 'Safety_MARL框架.tex', size: 10037 }, { rel: '问题场景定义.tex', size: 316 }]) === 'Safety_MARL框架.tex'],
    ['体积并列时结果稳定（字典序）',
      pick([{ rel: 'b.tex', size: 5 }, { rel: 'a.tex', size: 5 }]) === 'a.tex']
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 接线：enterRoot 里真的调了挑主 tex，且「打开具体文件 / 新建文档」两处关掉自动开
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const enter = src.slice(src.indexOf('function enterRoot'), src.indexOf('function openDirectory'))
  const offCount = (src.match(/autoOpen: false/g) || []).length
  ok('enterRoot 接线（loadTree 后挑主 tex + autoOpen 开关）',
    enter.includes('pickMainTex(state.files, { root: root, recents: state.recents })') && enter.includes('autoOpen === false'))
  ok('打开具体文件/新建文档/模板落地不被抢（3 处 autoOpen:false）', offCount === 3)
} catch (error) {
  bad('自动打开主 tex 测试抛错', String(error.message))
}

console.log('18) 面板互换功能已整体移除（不留死代码）')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const checks = [
    ['没有互换圆钮组件', !src.includes('SwapButton') && !src.includes('SWAP_ICON')],
    ['没有 grid 列位/轨道改写代码', !src.includes('gridArea =') && !src.includes('gridTemplateColumns =')],
    ['没有互换状态与观察者', !src.includes('swapOn') && !src.includes('swapState') && !src.includes('__swappedTemplate')],
    ['没有互换提示文案', !src.includes('已还原') && !src.includes('ml-swap')]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
} catch (error) {
  bad('互换移除检查抛错', String(error.message))
}

console.log('19) PDF 一键适应窗口（比例计算）')
try {
  const fit = bundle.__fitZoomFor
  const A4 = { width: 595.276, height: 841.89 }
  const checks = [
    ['宽高都放得下 → 100%', fit(500, 707, A4) === 1],
    ['高度放不下 → 按高度缩（800×900 → 80%）', fit(800, 900, A4) === 0.8],
    ['矮到超出下限 → 夹到 0.5', fit(500, 350, A4) === 0.5],
    ['量不到尺寸（0 / NaN）→ 回 100%', fit(0, 100, A4) === 1 && fit(500, NaN, A4) === 1],
    ['没有页面尺寸 → 按 A4 比例兜底', fit(800, 900, null) === 0.8]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
} catch (error) {
  bad('适应窗口测试抛错', String(error.message))
}

console.log('20) 切换项目文件夹：上一个项目的 tex / PDF 同步关闭')
try {
  const store = bundle.__store
  const enterRoot = bundle.__enterRoot
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('function enterRoot'), src.indexOf('function openDirectory'))

  ok('enterRoot 接了关闭逻辑（只有 root 变了才关）',
    body.includes('normalizePath(root) !== normalizePath(state.root)') && body.includes('closeProjectFiles()'))

  /** 造一个「上一个项目开着东西」的现场：两个 tex 标签 + PDF + 日志 + 提纲 + 右键菜单。 */
  const seedProject = (root) => Object.assign(store, {
    root,
    tabs: [
      { id: 'c-t1', root, rel: 'main.tex', name: 'main.tex', text: 'x', dirty: false },
      { id: 'c-t2', root, rel: 'chap/a.tex', name: 'a.tex', text: 'y', dirty: true }
    ],
    activeId: 'c-t1',
    tree: { name: 'a', children: [] },
    files: [{ rel: 'main.tex' }],
    total: 1,
    pdfUrl: 'blob:moling-test',
    pdfRel: 'main.pdf',
    pdfRoot: root,
    pdfRev: '123',
    pdfFor: root + '|main.pdf|123',
    pdfPages: 3,
    pdfPageSize: { width: 1, height: 1 },
    log: { success: true },
    outline: { sections: [] },
    outlineOpen: true,
    menu: { x: 1, y: 2, line: 3 },
    notice: '已保存 main.tex',
    syncNotice: '第 1 页',
    busy: 'compile',
    error: '旧错误'
  })
  /** enterRoot 会去拉宿主（离线自测里必然失败）：吞掉拒绝，只看同步做的那部分。 */
  const pendingEnters = []
  const tryEnter = (root) => {
    try {
      const pending = enterRoot(root)
      if (pending && typeof pending.then === 'function') {
        // 收下 promise：enterRoot 期间会挂起外部同步闸门（enteringRoot），
        // 不等它落定就进下一节，同步会被闸门挡掉、整节假红。
        pendingEnters.push(pending.then(() => {}, () => {}))
      }
    } catch (error) { /* 离线环境没有数据通道，忽略 */ }
  }

  // 换一个项目文件夹 → 上一个项目的东西全关
  seedProject('E:/proj/a')
  tryEnter('E:/proj/b')
  ok('换项目后 tex 标签全关', store.tabs.length === 0 && store.activeId === null)
  ok('换项目后 PDF 预览关掉',
    store.pdfRel === '' && store.pdfRoot === '' && store.pdfUrl === '' && store.pdfFor === '' && store.pdfPages === 0)
  ok('换项目后日志 / 提纲 / 右键菜单 / 定位提示清空',
    store.log === null && store.outline === null && store.outlineOpen === false
    && store.menu === null && store.syncNotice === '')
  ok('换项目后旧文件树放下（不残留上一个项目的文件）',
    store.tree === null && store.files.length === 0 && store.busy === '')
  ok('root 已切成新项目', store.root === 'E:/proj/b')
  // 用户 2026-11-14 要求：进项目不再默认顶出文件树抽屉（要点「文件树」才开）
  ok('进项目默认不展开文件树（treeOpen 保持关）', store.treeOpen === false)
  ok('enterRoot 默认值是「不自动开树」',
    body.includes("treeOpen: settings.treeOpen === true") && !body.includes('settings.treeOpen !== false'))

  // 还是同一个项目（大小写不同也算同一个）→ 标签与 PDF 留着
  seedProject('E:/Proj/B')
  tryEnter('e:/proj/b')
  ok('同一个项目重进：标签与 PDF 不受影响',
    store.tabs.length === 2 && store.pdfRel === 'main.pdf' && store.log && store.root === 'e:/proj/b')

  // 收摊：把 store 还原，别影响后面的断言
  await Promise.all(pendingEnters)   // 等 enterRoot 的闸门放下，否则下一节同步全被挡
  Object.assign(store, {
    root: '', tabs: [], activeId: null, tree: null, files: [], total: 0,
    pdfUrl: '', pdfRel: '', pdfRoot: '', pdfRev: '', pdfFor: '',
    pdfPages: 0, pdfPageSize: null, log: null,
    outline: null, outlineOpen: false, menu: null,
    notice: '', syncNotice: '', busy: '', error: ''
  })
} catch (error) {
  bad('切换项目关闭逻辑测试抛错', String(error.message))
}

console.log('21) 外部改动同步（大模型改 tex → 编辑区自动刷新）')
try {
  const store = bundle.__store
  const sync = bundle.__syncExternalChanges
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  ok('轮询接线（boot 起 2 秒定时器 + 面板挂载兜底 + 窗口重获焦点补一次）',
    /startWatch\(\)\s*\/\/ 外部改动轮询/.test(src)
    && src.includes('startWatch()   // 双保险')
    && /var onFocus = function \(\) \{\s*loadWorkspaces\(\)\s*syncExternalChanges\(\)/.test(src))

  // 打桩 fetch：磁盘状态全由下面这几个变量演
  const disk = { text: 'old' }
  let mtime = 1
  let pdfMtime = 101
  const extra = []                       // 额外文件（模拟大模型新建文件）
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const endpoint = String(url).split('/').pop()
    const body = opts && opts.body ? JSON.parse(opts.body) : {}
    calls.push(endpoint)
    const reply = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (endpoint === 'tree') {
      const files = [
        { rel: 'main.tex', name: 'main.tex', size: disk.text.length, mtime, editable: true },
        { rel: 'main.pdf', name: 'main.pdf', size: 5, mtime: pdfMtime, editable: false }
      ].concat(extra)
      return reply({
        root: body.root, count: files.length, total: files.length, skipped: 0, truncated: false,
        files, tree: { name: 'w', rel: '', type: 'dir', children: [] }
      })
    }
    if (endpoint === 'read-file') {
      return reply({ path: 'x', rel: body.path, name: body.path, text: disk.text, size: disk.text.length, mtime })
    }
    if (endpoint === 'pdf') {
      return reply({ rel: body.path, bytes: 5, mtime: pdfMtime, pages: 1, raster: true, pageSize: null })
    }
    return reply({})
  }

  Object.assign(store, {
    view: 'workbench',
    root: 'E:/proj/w',
    tree: { name: 'w', rel: '', type: 'dir', children: [] },
    files: [],
    tabs: [{ id: 'w-1', root: 'E:/proj/w', rel: 'main.tex', name: 'main.tex', text: 'old', dirty: false, loading: false }],
    activeId: 'w-1',
    pdfRel: 'main.pdf',
    pdfRoot: 'E:/proj/w',
    pdfFor: '',
    pdfRev: '',
    notice: '',
    noticeOk: true,
    outlineOpen: false
  })

  // 第一轮：只记版本戳，不重载（内容刚打开过）
  await sync()
  ok('第一轮只记版本戳（不无谓重载）',
    bundle.__stampOf('main.tex') === '1' && store.tabs[0].text === 'old')
  ok('同步走的是 tree 通道（不再依赖 stat 端点）', calls.includes('tree') && !calls.includes('stat'))
  ok('同步成功后指示灯变绿', store.syncOk === true && store.syncError === '')

  // 大模型改了磁盘 → 下一轮把新内容读进编辑区
  disk.text = 'new content from the LLM'
  mtime = 2
  await sync()
  ok('磁盘变了 → 编辑区自动同步', store.tabs[0].text === 'new content from the LLM')
  ok('状态栏给出同步提示', String(store.notice).includes('已同步') && store.noticeOk === true)
  ok('同步后版本戳跟着更新', bundle.__stampOf('main.tex') === '2')

  // 没变化的轮询不该重复动编辑区
  await sync()
  ok('没变化就不动', store.tabs[0].text === 'new content from the LLM')

  // 标签有未保存改动 → 只提醒，绝不覆盖
  store.tabs[0].dirty = true
  disk.text = 'LLM wrote again'
  mtime = 3
  await sync()
  ok('脏标签不被外部改动覆盖', store.tabs[0].text === 'new content from the LLM')
  ok('脏标签给出红色提醒', String(store.notice).includes('未保存') && store.noticeOk === false)

  // PDF 被（大模型）重新编译 → 自动换图
  pdfMtime = 102
  await sync()
  ok('PDF 重新编译后自动换图', store.pdfRev === '102' && calls.includes('pdf'))

  // 大模型新建了文件 → 文件清单变 → 树跟着换
  extra.push({ rel: 'new-chapter.tex', name: 'new-chapter.tex', size: 12, mtime: 5, editable: true })
  await sync()
  ok('新建文件后文件树跟着更新', store.files.length === 3 && store.files.some((file) => file.rel === 'new-chapter.tex'))

  // 通道挂掉不能静默：要亮红灯 + 写原因
  const stubFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) })
  await sync()
  ok('同步失败会亮红灯并写原因', store.syncOk === false && /boom/.test(store.syncError))
  globalThis.fetch = stubFetch
  await sync()
  ok('恢复后指示灯回绿', store.syncOk === true)

  // 收摊：还原 fetch 与 store
  globalThis.fetch = realFetch
  Object.assign(store, {
    root: '', view: 'welcome', tabs: [], activeId: null, tree: null, files: [],
    pdfRel: '', pdfRoot: '', pdfRev: '', pdfFor: '', pdfPages: 0, pdfPageSize: null,
    notice: '', noticeOk: true, outlineOpen: false, busy: '', error: '', syncOk: null, syncError: ''
  })
} catch (error) {
  bad('外部改动同步测试抛错', String(error.message))
}

console.log('22) 外部改动标绿：改了哪几行（diff 纯函数 + 接线）')
try {
  const diff = bundle.__diffLineRanges
  const many = (n) => Array.from({ length: n }, (_, i) => 'line ' + (i + 1)).join('\n')
  const fmt = (ranges) => JSON.stringify(ranges)

  const checks = [
    ['文本没变 → 不标', fmt(diff('a\nb', 'a\nb')) === '[]'],
    ['中间改一行 → 只标那一行', fmt(diff('a\nb\nc', 'a\nB\nc')) === '[{"from":2,"to":2}]'],
    ['末尾追加两行 → 标新增的两行', fmt(diff('a\nb', 'a\nb\nc\nd')) === '[{"from":3,"to":4}]'],
    ['中间插入 → 标插入处', fmt(diff('a\nz', 'a\nb\nz')) === '[{"from":2,"to":2}]'],
    ['纯删除 → 标删除处紧跟的一行', fmt(diff('a\nb\nc', 'a\nc')) === '[{"from":2,"to":2}]'],
    ['空文档 → 全算新增', fmt(diff('', 'x\ny')) === '[{"from":1,"to":2}]'],
    ['顺序变了（行集相同）→ 兜底给一整块', diff('a\nb', 'b\na').length > 0],
    ['null/undefined 不炸', Array.isArray(diff(null, undefined)) && diff(null, null).length === 0]
  ]
  // 关键用例：1000 行里第 10 行与第 500 行各改一处 → 两段，不能把中间 490 行全刷绿
  const base = many(1000).split('\n')
  const edited = base.slice()
  edited[9] = 'CHANGED-10'
  edited[499] = 'CHANGED-500'
  const far = diff(base.join('\n'), edited.join('\n'))
  checks.push(['远隔两处改动 → 两段区间', fmt(far) === '[{"from":10,"to":10},{"from":500,"to":500}]'])

  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // queueFlash → takeFlash 配对（编辑器同步 effect 消费）
  bundle.__queueFlash('t1', 'a\nb', 'a\nB')
  const taken = bundle.__takeFlash('t1')
  ok('queueFlash → takeFlash 配对', taken && taken.tabId === 't1' && taken.ranges[0].from === 2)
  ok('takeFlash 只消费一次', bundle.__takeFlash('t1') === null)
  bundle.__queueFlash('t2', 'a', 'b')
  ok('别人的排队不消费', bundle.__takeFlash('t9') === null && bundle.__takeFlash('t2') !== null)

  // 接线扫描
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('接线：reloadTab 算改动行 → 编辑器同步 effect 涂绿',
    src.includes('queueFlash(tab.id, live.text, data.text)') && src.includes('var flash = takeFlash(tab.id)'))
  ok('CM 路径：视口滚动补涂 + 换标签清绿底',
    src.includes('onViewport: function () { repaintFlash() }') && src.includes('if (flashState.owner === view) clearFlash()'))
  ok('回退（textarea）路径同样标绿', src.includes('startFlash(flash.tabId, flash.ranges, container, container'))
  const kernelSrc = readFileSync(new URL('../lib/vendor/entry.js', import.meta.url), 'utf8')
  ok('不动内核：entry.js 里没有标绿代码（刷新页面即生效，不用重建 cm6.js）',
    !kernelSrc.includes('startFlash') && !kernelSrc.includes('FLASH_GREEN'))
} catch (error) {
  bad('标绿测试抛错', String(error.message))
}

console.log('23) 同步不被标绿拖垮 + 绿底涂/摘（假 DOM）')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  // 回归：外部 setDoc 会走内核 onChange，不挡住就会把标签标脏 → 之后每次外部改动
  // 都被 reloadTab 的「有未保存改动」拦住（症状就是"同步突然不工作了"）
  ok('onChange 认得「刚同步下去的文本」，不标脏',
    /if \(suppressDirtyText !== null && text === suppressDirtyText\)/.test(src)
    && /setTab\(tab\.id, \{ text: text, dirty: true \}\)/.test(src))
  ok('setDoc 前先记下预期文本', src.includes('suppressDirtyText = tab.text'))
  const reloadAt = src.indexOf('setTab(tab.id, { text: data.text, loading: false })')
  const flashAt = src.indexOf('try { queueFlash(tab.id, live.text, data.text) }')
  ok('同步先落地、标绿后置且自带 try（标绿出错不拖垮同步）',
    reloadAt > 0 && flashAt > reloadAt && src.includes('try { queueFlash(tab.id, live.text, data.text) }'))

  // 涂/摘：用假 DOM 走一遍 startFlash → paintFlash → clearFlash
  const mkNode = (line) => ({
    style: {},
    getAttribute(name) { return name === 'data-line' ? String(line) : null }
  })
  const a = mkNode(2)
  const b = mkNode(3)
  const c = mkNode(9)
  const container = { querySelectorAll: () => [a, b, c] }
  const owner = {}
  const readLine = (node) => Number(node.getAttribute('data-line'))

  bundle.__startFlash('t', [{ from: 2, to: 4 }], owner, container, readLine)
  ok('区间内的行涂上绿底', a.style.backgroundColor === bundle.__FLASH_GREEN && b.style.backgroundColor === bundle.__FLASH_GREEN)
  ok('区间外的行不涂', c.style.backgroundColor === undefined)
  ok('涂了渐隐用的 transition', a.style.transition.includes('background-color'))
  bundle.__clearFlash()
  ok('clearFlash 摘掉绿底（由 transition 渐隐）', a.style.backgroundColor === '' && b.style.backgroundColor === '')
  bundle.__clearFlash()
  ok('clearFlash 幂等（连点两次不炸）', true)

  // 防御：readLine 抛异常 / 容器不对 / 没有范围，都不能把 effect 弄崩
  const bad = mkNode(5)
  bundle.__startFlash('t', [{ from: 1, to: 9 }], owner, { querySelectorAll: () => [bad] }, () => { throw new Error('boom') })
  ok('readLine 抛异常 → 不涂但不炸', bad.style.backgroundColor === undefined)
  bundle.__clearFlash()
  bundle.__startFlash('t', [{ from: 1, to: 9 }], owner, {}, readLine)
  ok('容器没有 querySelectorAll → 直接跳过', true)
  bundle.__clearFlash()
  bundle.__startFlash('t', [], owner, container, readLine)
  ok('没有改动行 → 不进涂刷流程', a.style.backgroundColor === '' || a.style.backgroundColor === undefined)
  bundle.__clearFlash()
} catch (error) {
  bad('标绿/同步回归测试抛错', String(error.message))
}

console.log('24) 同步观感：视口不跳 + 绿标行号换算')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  ok('setDoc 前后接了 capture/restore（整篇替换不再把页面甩走）',
    /var keep = Date\.now\(\) < suppressRestoreUntil \? null : captureViewport\(view\)/.test(src)
    && /kernel\.setDoc\(view, tab\.text\)\s*\n\s*if \(keep\) \{\s*\n\s*restoreViewport\(view, keep\)/.test(src))
  ok('下一帧再补一次还原（等布局稳定）', /requestAnimationFrame\(function \(\) \{ restoreViewport\(/.test(src))
  // 注释里提到 posAtDOM 是允许的（说明"为什么不用它"），要排除注释再断言；
  // 文件末尾还内联着 CodeMirror 内核（它自己就用 posAtDOM），所以先切掉内核那一段
  const kernelAt = src.indexOf('/* ===== 编辑器内核')
  const panelOnly = kernelAt > 0 ? src.slice(0, kernelAt) : src
  const codeOnly = panelOnly.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok('行号换算不再以 posAtDOM 为主路',
    !codeOnly.includes('posAtDOM') && codeOnly.includes('posAtCoords') && src.includes('lineReaderFor(view)'))

  // 假 view：100 行、每行 10 个字符位置，视口首行 = 第 6 行
  const doc = {
    lines: 100,
    line: (n) => ({ from: (n - 1) * 10 }),
    lineAt: (pos) => ({ number: Math.max(1, Math.floor(pos / 10) + 1) })
  }
  const nodes = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]
  const scrollDOM = { scrollTop: 250 }
  const view = {
    scrollDOM,
    state: { doc },
    viewport: { from: 50 },              // → 第 6 行
    contentDOM: { querySelectorAll: () => nodes },
    lineBlockAtHeight: () => ({ top: 200, from: 50 }),
    lineBlockAt: () => ({ top: 900 }),
    posAtCoords: () => null
  }

  const keep = bundle.__captureViewport(view)
  ok('captureViewport 记下「首行 + 行内偏移」', keep && keep.line === 6 && keep.delta === 50)
  bundle.__restoreViewport(view, keep)
  ok('restoreViewport 把滚动位置挪回去', scrollDOM.scrollTop === 950)
  bundle.__restoreViewport(view, { line: 999, delta: 0 })
  ok('视口行号超界时夹到最后一行、不炸', scrollDOM.scrollTop === 900)
  ok('拿不到布局时 capture 返回 null（宁可不还原）',
    bundle.__captureViewport(null) === null && bundle.__captureViewport({}) === null)

  // 行号换算：DOM 顺序优先
  const reader = bundle.__lineReaderFor(view)
  ok('第 1 个 .cm-line → 视口首行', reader(nodes[0]) === 6)
  ok('第 3 个 .cm-line → 首行 + 2', reader(nodes[2]) === 8)

  // 兜底：DOM 顺序找不到 → 用中心点反查；中心点也拿不到 → -1（不涂但不炸）
  const stray = { getBoundingClientRect: () => ({ left: 0, top: 0, height: 10 }) }
  ok('DOM 顺序里找不到 → 中心点反查失败给 -1', reader(stray) === -1)
  const view2 = Object.assign({}, view, { posAtCoords: () => 95 })
  ok('中心点反查可用时能算出第 10 行', bundle.__lineReaderFor(view2)(stray) === 10)

  // 跳转要"看得见"：收起盖住编辑区的浮层 + 让目标行闪一下
  ok('jumpTo 会收起文件树/提纲/右键菜单并标记目标行',
    /if \(state\.treeOpen\) next\.treeOpen = false/.test(src)
    && /flashLine: line, flashAt: Date\.now\(\)/.test(src))
  ok('CM 与回退编辑器都会闪目标行（两个 flashAt effect）',
    (src.match(/\}, \[store\.flashAt\]\)/g) || []).length === 2)
} catch (error) {
  bad('视口/行号测试抛错', String(error.message))
}

console.log('25) 回归：自动打开主 tex 不被轮询干扰 + 发送选中内容有备份')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const store = bundle.__store
  const realFetch = globalThis.fetch

  const files = [
    { rel: 'paper-main.tex', name: 'paper-main.tex', size: 10, mtime: 1, editable: true },
    { rel: 'refs.bib', name: 'refs.bib', size: 5, mtime: 1, editable: true }
  ]
  let served = files
  globalThis.fetch = async (url, opts) => {
    const endpoint = String(url).split('/').pop()
    const body = opts && opts.body ? JSON.parse(opts.body) : {}
    const reply = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (endpoint === 'workspaces') {
      return reply({ workspaces: [{ path: body.root || '', title: 'w', kind: 'workspace' }], openedRoots: [], allowedRoots: [], defaultRoot: null })
    }
    if (endpoint === 'tree') {
      return reply({
        root: body.root, count: served.length, total: served.length, skipped: 0, truncated: false,
        files: served, tree: { name: 'w', rel: '', type: 'dir', children: [] }
      })
    }
    if (endpoint === 'read-file') {
      return reply({ path: 'x', rel: body.path, name: body.path, text: '% ' + body.path + '\n', size: 10, mtime: 1 })
    }
    return reply({})
  }

  Object.assign(store, {
    root: '', view: 'welcome', tabs: [], activeId: null, tree: null, files: [],
    pdfRel: '', pdfFor: '', pdfRev: '', notice: '', syncOk: null, syncError: ''
  })

  // 1) 进项目自动打开主 tex（唯一 .tex）
  await bundle.__enterRoot('E:/proj/auto')
  ok('进项目自动打开主 tex（唯一 .tex）', store.tabs.length === 1 && store.tabs[0].rel === 'paper-main.tex')

  // 2) 轮询绝不能把开着的标签关掉（只提示）
  served = []
  await bundle.__syncExternalChanges()
  ok('文件从清单里消失也不关标签（只提示）',
    store.tabs.length === 1 && /找不到了/.test(String(store.notice)))
  served = files
  await bundle.__syncExternalChanges()
  ok('文件回来之后标签与提示都稳定', store.tabs.length === 1)

  // 3) 接线：进项目期间暂停轮询 / 自动打开失败补一次并说明原因
  ok('进项目期间暂停轮询（enteringRoot 闸门）',
    src.includes('enteringRoot = true') && src.includes('if (enteringRoot) return Promise.resolve(false)'))
  ok('自动打开失败会补一次、没主 tex 时给出说明',
    src.includes('if (!findTab(root, rel)) return openTab(root, rel)')
    && src.includes('这个项目里没有 .tex，需要自己从「文件树」里选文件'))

  // 4) 发送选中内容：右键那一刻就把选区抓下来，菜单期间丢了还有备份
  ok('右键抓下选区（菜单后丢失也能发）',
    src.includes('selection: selection') && src.includes('var captured = store.menu && store.menu.selection'))
  ok('发送失败不再静默', src.includes('发送选中内容失败：'))

  globalThis.fetch = realFetch
  Object.assign(store, {
    root: '', view: 'welcome', tabs: [], activeId: null, tree: null, files: [],
    notice: '', syncOk: null, syncError: ''
  })
} catch (error) {
  bad('回归测试抛错', String(error.message))
}

console.log('26) 「自编」自动编译：触发点与防抖')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const checks = [
    ['默认关闭，并进 localStorage', src.includes('autoCompile: false')
      && src.includes('autoCompile: state.autoCompile === true')
      && src.includes('autoCompile: saved.autoCompile === true')],
    ['防抖 900ms，正忙时跳过（不排队堆积）',
      src.includes('}, 900)') && /if \(state\.busy\) return\n\s+if \(!activeTab\(\)\) return/.test(src)],
    ['关着的时候不排期', src.includes('if (state.autoCompile !== true) return')],
    ['保存成功后触发', /scheduleAutoCompile\(\)\s*\/\/ 「自编」开着就顺手编一次/.test(src)],
    ['外部改动同步后触发', /scheduleAutoCompile\(\)\s*\/\/ 「自编」开着：大模型改完就自动编一次/.test(src)],
    ['换项目 / 手动关闭时清掉待触发的定时器',
      src.includes('if (autoCompileTimer) { clearTimeout(autoCompileTimer); autoCompileTimer = null }')],
    ['按钮在「换行｜保存｜新建」同组内（橙色分组）', (function () {
      const group = src.indexOf("S.btnGroupAmber")
      const spacer = src.indexOf('S.spacer', group)
      const newBtn = src.indexOf("}, '新建')", group)
      const autoBtn = src.indexOf("}, '自编')", group)
      return group > -1 && newBtn > group && autoBtn > newBtn && (spacer === -1 || autoBtn < spacer)
    })()]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
  ok('store 默认 autoCompile = false', bundle.__store.autoCompile === false)

  // 开关按钮：开/关两态都显式写 border（别混用 border 简写 + borderColor 长写）
  ok('开关按钮用 toggleBtnStyle 统一两态（树/提纲/换行/自编 4 个）',
    (src.match(/toggleBtnStyle\(store\./g) || []).length === 4
    && src.includes('? { border: \'1px solid \' + C.accent, color: C.accent }')
    && src.includes(': { border: \'1px solid transparent\', color: C.text })'))
  ok('保存分体：整块自带边框（三角与文字同一圈框）',
    /saveSplitWrap: \{[\s\S]{0,220}border: '1px solid ' \+ C\.line/.test(src)
    && src.includes("borderRadius: '5px 0 0 5px'"))
  ok('保存分体：自动档把整圈边框染成 accent',
    src.includes("store.saveMode === 'auto' ? { borderColor: C.accent } : null"))
  ok('组内按钮不再靠移除 borderColor 关掉高亮', !/S\.btnOn\s*:\s*null/.test(src))
  ok('组内按钮吃掉浏览器焦点框（否则点过的开关会留白圈）', /outline: 'none'/.test(src))

  // 「保存」分体按钮：手动 / 自动两档
  const saveChecks = [
    ['保存方式默认手动，并进 localStorage', src.includes("saveMode: 'manual'")
      && src.includes("saveMode: state.saveMode === 'auto' ? 'auto' : 'manual'")
      && src.includes("saveMode: saved.saveMode === 'auto' ? 'auto' : 'manual'")],
    ['两档文案就在按钮上（手动保存 / 自动保存）',
      src.includes("['manual', '手动保存']") && src.includes("['auto', '自动保存']")
      && src.includes("store.saveMode === 'auto' ? '自动保存' : '手动保存'")],
    ['小三角开合与菜单项（✓ 标当前档）',
      src.includes('patch({ saveMenu: !store.saveMenu, compileMenu: false })')
      && src.includes("(store.saveMode === pair[0] ? '✓ ' : '') + pair[1]")],
    ['点别处 / Esc 关菜单', /}, \[store\.saveMenu\]\)/.test(src)],
    ['下拉与按钮等宽（left/right 都为 0，不设 minWidth）', (function () {
      const at = src.indexOf('saveMenu: {')
      const seg = at > -1 ? src.slice(at, at + 300) : ''
      return seg.includes('left: 0') && seg.includes('right: 0') && !seg.includes('minWidth')
    })()],
    ['自动保存的唯一触发点：标签变脏', src.includes('if (next && next.dirty === true) scheduleAutoSave(id)')],
    ['自动模式才存、停手 1.2 秒', src.includes("if (state.saveMode !== 'auto') return") && src.includes('}, 1200)')],
    ['切到自动时立刻把脏标签存一次', src.includes("if (next === 'auto' && live && live.dirty) saveTab(live.id)")],
    ['换项目清掉待触发的自动保存', src.includes('if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null }')]
  ]
  for (const [label, passed] of saveChecks) passed ? ok(label) : bad(label)
  ok('store 默认 saveMode = manual', bundle.__store.saveMode === 'manual')
} catch (error) {
  bad('自编测试抛错', String(error.message))
}

console.log('27) 模板库：清单 / 搜索分类 / 按模板落地')
try {
  const store = bundle.__store
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const render = () => ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))

  const list = [
    { id: 'zh-article', name: '中文论文', description: '中文期刊论文通用模板', category: '中文论文', engine: 'xelatex', accent: '#2563eb', layout: 'column', main: 'main.tex', files: 1, bytes: 1594 },
    { id: 'resume-en', name: '英文简历', description: 'One page resume for internship', category: '简历', engine: 'xelatex', accent: '#16a34a', layout: 'stack', main: 'main.tex', files: 1, bytes: 3436 },
    { id: 'slides-course', name: '课程报告', description: 'Beamer slides for course report', category: '幻灯片', engine: 'xelatex', accent: '#d97706', layout: 'side', main: 'main.tex', files: 1, bytes: 1858 }
  ]

  // 1) 筛选纯函数：分类精确 + 搜索词模糊（名称/描述/分类/引擎）
  const filter = bundle.__filterTemplates
  typeof filter === 'function' ? ok('导出 __filterTemplates') : bad('缺少 __filterTemplates')
  filter(list, '', '简历').length === 1 && filter(list, '', '简历')[0].id === 'resume-en'
    ? ok('分类筛选')
    : bad('分类筛选', JSON.stringify(filter(list, '', '简历').map((item) => item.id)))
  filter(list, 'resume', '').length === 1 && filter(list, 'beamer', '').length === 1 && filter(list, 'xelatex', '').length === 3
    ? ok('搜索命中名称 / 描述 / 引擎')
    : bad('搜索没命中', `${filter(list, 'resume', '').length}/${filter(list, 'beamer', '').length}/${filter(list, 'xelatex', '').length}`)
  filter(list, '  RESUME  ', '').length === 1 && filter(list, '', '').length === 3
    ? ok('大小写与首尾空格不敏感')
    : bad('大小写/空格处理不对')
  filter(list, 'beamer', '简历').length === 0
    ? ok('分类与搜索同时生效（交集）')
    : bad('分类+搜索没取交集')

  // 2) 启动页只留入口，模板清单不铺在启动页（m01453 需求 1）
  store.view = 'welcome'
  store.recents = []
  store.templates = list
  store.templateCategories = ['中文论文', '简历', '幻灯片']
  store.templateQuery = ''
  store.templateCategory = ''
  store.templateBusy = ''
  store.templatesOpen = false
  store.templateStep = 'list'
  store.templatePick = null
  store.templateTarget = ''
  const welcomeHtml = render()
  const welcomeChecks = [
    ['启动页有「浏览模板库」入口', welcomeHtml.includes('浏览模板库') && welcomeHtml.includes('中文论文 · 英文论文 · 简历 · 幻灯片 · 实验报告等内置模板')],
    ['启动页不罗列模板（无搜索框 / 无卡片网格）',
      !welcomeHtml.includes('ml-tpl-search') && !welcomeHtml.includes('ml-tpl-card') && !welcomeHtml.includes('ml-tpl-grid') && !welcomeHtml.includes('ml-modal')],
    ['启动页仍有空白 ctexart 骨架入口', welcomeHtml.includes('新建中文文档') && welcomeHtml.includes('ctexart')]
  ]
  for (const [label, passed] of welcomeChecks) passed ? ok(label) : bad(label)

  // 3) 二级弹窗：点开后有分类导航 / 搜索 / 卡片网格
  store.templatesOpen = true
  const html = render()
  const cardCount = (html.match(/class="ml-tpl-card"/g) || []).length
  const navCount = (html.match(/class="ml-tpl-navitem/g) || []).length
  const modalChecks = [
    ['弹窗挂到 Body 层（有遮罩 + 卡片）', html.includes('class="ml-modal-mask"') && html.includes('class="ml-modal"')],
    ['弹窗标题 = 模板库', /class="ml-modal-title"[^>]*>模板库</.test(html)],
    ['左侧分类导航含「全部模板」+ 3 个分类', navCount === 4 && html.includes('全部模板')],
    ['导航高亮当前分类（默认全部）', /class="ml-tpl-navitem ml-tpl-nav-on"[^>]*><span>全部模板</.test(html)],
    ['渲染搜索框', html.includes('class="ml-tpl-search"') && html.includes('搜索模板名称或描述')],
    ['卡片数量 = 模板数', cardCount === 3],
    ['卡片带名称 / 分类·引擎 / 描述', html.includes('中文论文') && html.includes('xelatex') && html.includes('中文期刊论文通用模板')],
    ['计数显示 3 / 3', html.includes('3 / 3')],
    ['弹窗里也有空白骨架入口（模板之外还能一键新建）', html.includes('新建中文文档') && html.includes('ctexart')],
    ['底部提示引导选存放文件夹', html.includes('选择模板存放的文件夹')]
  ]
  for (const [label, passed] of modalChecks) passed ? ok(label) : bad(label)

  // 4) 搜索过滤：只剩命中项，计数跟着变
  store.templateQuery = 'resume'
  const searched = render()
  const searchedCards = (searched.match(/class="ml-tpl-card"/g) || []).length
  searchedCards === 1 && searched.includes('英文简历') && !searched.includes('课程报告') && searched.includes('1 / 3')
    ? ok('搜索后只剩命中项，计数变 1 / 3')
    : bad('搜索过滤不对', String(searchedCards))

  // 5) 分类切换：导航高亮 + 只显示该分类
  store.templateQuery = ''
  store.templateCategory = '幻灯片'
  const byCat = render()
  const catCards = (byCat.match(/class="ml-tpl-card"/g) || []).length
  catCards === 1 && byCat.includes('课程报告') && /class="ml-tpl-navitem ml-tpl-nav-on"[^>]*><span>幻灯片</.test(byCat)
    ? ok('分类切换只显示该分类，导航高亮')
    : bad('分类切换不对', String(catCards))

  // 6) 空态两句话：没读到模板 vs 搜索无结果（不能都空白）
  store.templateCategory = ''
  store.templates = []
  store.templateCategories = []
  const emptyHtml = render()
  emptyHtml.includes('没有读到内置模板')
    ? ok('模板清单为空时有说明（不空白、不崩）')
    : bad('空模板态没文案')
  store.templates = list
  store.templateCategories = ['中文论文', '简历', '幻灯片']
  store.templateQuery = 'zzz-not-exist'
  const noneHtml = render()
  noneHtml.includes('没有匹配的模板') && (noneHtml.match(/class="ml-tpl-card"/g) || []).length === 0
    ? ok('搜索无结果时有引导文案')
    : bad('无结果态没文案')
  store.templateQuery = ''

  // 7) 第二步「新建文件」：点卡片 → 让用户选存放位置（m01453 需求 2）
  bundle.__pickTemplate(list[0])
  store.templateStep === 'target' && store.templatePick && store.templatePick.id === 'zh-article'
    ? ok('点卡片进入「新建文件」第二步')
    : bad('没进第二步', `${store.templateStep}/${store.templatePick && store.templatePick.id}`)
  const targetHtml = render()
  const targetChecks = [
    ['标题变「新建文件」', /class="ml-modal-title"[^>]*>新建文件</.test(targetHtml)],
    ['显示选中的模板名', targetHtml.includes('中文论文') && targetHtml.includes('中文论文 · xelatex · 1 个文件')],
    ['显示「存放位置」与「选择文件夹…」', targetHtml.includes('存放位置') && targetHtml.includes('选择文件夹…')],
    ['还没选目录时提示「还没有选择文件夹」', targetHtml.includes('还没有选择文件夹')],
    ['创建按钮存在但未选目录时禁用', targetHtml.includes('>创建<') && /class="ml-modal-btn ml-modal-btn-on" disabled/.test(targetHtml)],
    ['提示 main.tex 命名与「非空目录落子文件夹」规则',
      targetHtml.includes('main.tex') && targetHtml.includes('子文件夹') && targetHtml.includes('绝不把模板文件散进')],
    ['有「返回」回到列表', targetHtml.includes('>返回<')]
  ]
  for (const [label, passed] of targetChecks) passed ? ok(label) : bad(label)

  // 8) 拉清单 / 选目录 / 创建：打桩 fetch 与原生目录选择器
  const realFetch = globalThis.fetch
  const calls = []
  let failTemplates = false
  globalThis.fetch = async (url, opts) => {
    const endpoint = String(url).split('/').pop()
    const body = opts && opts.body ? JSON.parse(opts.body) : {}
    calls.push({ endpoint, body })
    const reply = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (endpoint === 'templates') {
      if (failTemplates) return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }
      return reply({ templates: list, categories: ['中文论文', '简历', '幻灯片'] })
    }
    if (endpoint === 'open-root') return reply({ root: body.root, allowedRoots: [body.root], workspaces: [] })
    if (endpoint === 'use-template') {
      return reply({
        template: { id: body.template, name: '中文论文', category: '中文论文', engine: 'xelatex' },
        root: body.root, main: 'main.tex', files: ['main.tex']
      })
    }
    if (endpoint === 'workspaces') return reply({ workspaces: [] })
    if (endpoint === 'tree') {
      return reply({
        root: body.root, count: 1, total: 1, skipped: 0, truncated: false,
        files: [{ rel: 'main.tex', name: 'main.tex', size: 20, mtime: 1, editable: true }],
        tree: { name: 'chosen', rel: '', type: 'dir', children: [] }
      })
    }
    if (endpoint === 'read-file') {
      return reply({ path: 'x', rel: body.path, name: body.path, text: '\\documentclass{ctexart}', size: 20, mtime: 1 })
    }
    return reply({})
  }

  store.templates = []
  store.templateCategories = []
  store.error = ''
  await bundle.__loadTemplates()
  store.templates.length === 3 && store.templateCategories.length === 3
    ? ok('loadTemplates 填进清单与分类')
    : bad('loadTemplates 没填上', `${store.templates.length}/${store.templateCategories.length}`)

  failTemplates = true
  store.templates = list
  store.templateCategories = ['中文论文']
  store.error = ''
  await bundle.__loadTemplates()
  store.templates.length === 0 && store.error === ''
    ? ok('拉清单失败只清空，不写 store.error（模板区是配菜）')
    : bad('拉清单失败处理不对', `templates=${store.templates.length} error=${store.error}`)
  failTemplates = false

  // 8.1) 「选择文件夹…」走原生目录选择器，并先把目录登记进白名单（否则 use-template 会被拒）
  store.templatesOpen = true
  store.templateStep = 'target'
  store.templatePick = list[0]
  store.templateTarget = ''
  store.error = ''
  calls.length = 0
  let pickCancelled = false
  store.ctx = {
    get: (name) => (name === 'uiWorkspace' ? {
      pickDirectory: async () => (pickCancelled ? null : 'E:/chosen')
    } : null)
  }
  await bundle.__pickTemplateTarget()
  const openRootCall = calls.find((item) => item.endpoint === 'open-root')
  openRootCall && openRootCall.body.root === 'E:/chosen'
    ? ok('选文件夹后先调 open-root 登记白名单', JSON.stringify(openRootCall.body))
    : bad('没调 open-root', JSON.stringify(calls.map((item) => item.endpoint)))
  store.templateTarget === 'E:/chosen'
    ? ok('选中的目录记进 templateTarget')
    : bad('没记住目录', String(store.templateTarget))

  // 8.2) 取消选择（picker 返回 null）→ 不改动已选目录、不报错
  store.templateTarget = 'E:/keep'
  pickCancelled = true
  calls.length = 0
  store.error = ''
  await bundle.__pickTemplateTarget()
  store.templateTarget === 'E:/keep' && store.error === '' && calls.length === 0
    ? ok('取消选择时不动已选目录、不发请求')
    : bad('取消选择处理不对', `target=${store.templateTarget} calls=${calls.length}`)
  pickCancelled = false

  // 8.3) 点「创建」：把用户选的目录当 root 落地，成功后关弹窗
  store.root = 'E:/proj'
  store.engine = 'auto'
  store.view = 'welcome'
  store.tabs = []
  store.activeId = null
  store.templateTarget = 'E:/chosen'
  store.templateStep = 'target'
  store.templatePick = list[0]
  store.templatesOpen = true
  calls.length = 0
  await bundle.__createFromTemplate()
  const usedCall = calls.find((item) => item.endpoint === 'use-template')
  usedCall && usedCall.body.root === 'E:/chosen' && usedCall.body.template === 'zh-article'
    ? ok('用「用户选的目录」调 use-template（不是当前项目）', JSON.stringify(usedCall.body))
    : bad('use-template 参数不对', JSON.stringify(usedCall && usedCall.body))
  store.engine === 'xelatex'
    ? ok('引擎跟着模板走（auto → xelatex）')
    : bad('引擎没跟模板', String(store.engine))
  store.root === 'E:/chosen'
    ? ok('进到模板落地的新目录', store.root)
    : bad('没进新目录', String(store.root))
  store.tabs.length === 1 && store.tabs[0].rel === 'main.tex'
    ? ok('自动打开落地后的 main.tex')
    : bad('没打开 main.tex', JSON.stringify(store.tabs.map((tab) => tab.rel)))
  const recent = (store.recents || [])[0]
  recent && recent.kind === 'file' && recent.value === 'main.tex' && recent.root === 'E:/chosen'
    ? ok('落地后进「最近」列表')
    : bad('没进最近列表', JSON.stringify(recent))
  store.templatesOpen === false
    ? ok('创建成功后自动关弹窗')
    : bad('弹窗没关', String(store.templatesOpen))

  // 8.4) 没选目录就点创建：只报错、不发请求
  store.root = ''
  store.recents = []
  store.error = ''
  store.tabs = []
  store.templateTarget = ''
  store.templateStep = 'target'
  store.templatePick = list[0]
  store.templatesOpen = true
  calls.length = 0
  await bundle.__createFromTemplate()
  store.error.includes('先「选择文件夹…」') && calls.length === 0 && store.templatesOpen === true
    ? ok('没选目录时点创建只提示，不发请求、不关弹窗')
    : bad('没拦住无目录时创建', `error=${store.error} calls=${calls.length}`)

  // 8.5) 直接调 newFromTemplate 且不传目录：回退逻辑仍在（无项目、无最近目录 → 提示）
  store.root = ''
  store.recents = []
  store.error = ''
  store.tabs = []
  calls.length = 0
  await bundle.__newFromTemplate(list[0])
  store.error.includes('先选一个存放位置') && calls.length === 0
    ? ok('没有目标目录时先提示，不瞎落地')
    : bad('没拦住在无目录时落地', `error=${store.error} calls=${calls.length}`)

  // 8.6) 关弹窗要清掉第二步状态（下次打开回到列表）
  store.templateStep = 'target'
  store.templatePick = list[0]
  store.templateTarget = 'E:/chosen'
  bundle.__closeTemplates()
  store.templatesOpen === false && store.templateStep === 'list' && store.templatePick === null && store.templateTarget === ''
    ? ok('关闭弹窗时清掉第二步状态')
    : bad('关弹窗没清状态', JSON.stringify({ step: store.templateStep, pick: store.templatePick, target: store.templateTarget }))

  globalThis.fetch = realFetch
  Object.assign(store, {
    root: '', view: 'welcome', tabs: [], activeId: null, tree: null, files: [],
    templates: [], templateCategories: [], templateQuery: '', templateCategory: '', templateBusy: '',
    templatesOpen: false, templateStep: 'list', templatePick: null, templateTarget: '',
    error: '', notice: ''
  })

  // 9) 接线：boot 拉清单；弹窗挂在 Body 层；样式走主题 token
  const wiring = [
    ['boot 里拉模板清单', src.includes('loadTemplates()')],
    ['弹窗挂在 Body 层（启动页与工作台都能弹）', src.includes('h(TemplateDialog, { store: store })')],
    ['弹窗受 store.templatesOpen 控制', src.includes('if (!store.templatesOpen) return null')],
    ['hook 写在提前 return 之前（否则 React #310）',
      /React\.useEffect\(function \(\) \{\s*if \(!state\.templatesOpen\) return undefined[\s\S]{0,600}if \(!store\.templatesOpen\) return null/.test(src)],
    ['模板卡不占用启动页 .ml-row 计数', src.includes("className: 'ml-tpl-grid'")],
    ['弹窗 / 导航 / 搜索 / 卡片 / 路径样式齐全',
      ['.ml-modal-mask', '.ml-modal', '.ml-tpl-nav-on', '.ml-tpl-search', '.ml-tpl-grid', '.ml-tpl-card', '.ml-tpl-path'].every((name) => src.includes(name))],
    ['模板区样式走主题 token（不硬编码白底）',
      /\.ml-tpl-card\{[\s\S]{0,400}--dsw-alias-bg-layer-1/.test(src) && !/\.ml-tpl-(card|grid|search|modal)\{[^}]*#fff/i.test(src)],
    ['忙态不可重复点（防连点落地两份）', src.includes('if (state.templateBusy) return') && src.includes('disabled: busy || !target')],
    ['Esc 关闭（第二步先回列表）', src.includes("event.key !== 'Escape'") && src.includes("if (state.templateStep === 'target') patch({ templateStep: 'list', templatePick: null })")],
    // 窗口尺寸固定：不随模板数量 / 步骤变化（用户要求「固定住，让其不变化」）
    ['弹窗高度固定（height 而非 max-height）',
      /\.ml-modal\{[^}]*height:min\(620px,88%\)/.test(src) && !/\.ml-modal\{[^}]*max-height/.test(src)],
    ['列表步：内容区不外滚，只有卡片网格内部滚',
      /\.ml-modal-body\{[^}]*overflow:hidden/.test(src) && /\.ml-tpl-grid\{[^}]*overflow:auto/.test(src)],
    ['第二步（新建文件）恢复整体滚动',
      /\.ml-modal-body-target\{[^}]*overflow:auto/.test(src) && src.includes("step === 'target' ? ' ml-modal-body-target' : ''")],
    ['「新建中文文档」卡片固定在网格外（不随滚动跑）',
      src.includes("'ml-card ml-tpl-footcard'") && /\.ml-tpl-footcard\{[^}]*flex:none/.test(src)],
    ['左右两栏等高撑满（分类导航与网格各自滚）',
      /\.ml-tpl-layout\{[^}]*align-items:stretch/.test(src) && /\.ml-tpl-nav\{[^}]*overflow:auto/.test(src) && /\.ml-tpl-main\{[^}]*min-height:0/.test(src)]
  ]
  for (const [label, passed] of wiring) passed ? ok(label) : bad(label)
} catch (error) {
  bad('模板库测试抛错', String(error.message))
}

console.log('28) LaTeX 自动补全：命令 / 环境 / 引用 / 宏包')

try {
  const complete = bundle.__completeLatex
  const labels = bundle.__LATEX_COMMANDS.map((item) => item[0])
  const envs = bundle.__LATEX_ENVIRONMENTS.map((item) => item[0])

  // 1) 环境名：\begin{fi → figure；插入时顺手补 \end{}
  const envFigure = complete({ text: '\\begin{fi', pos: '\\begin{fi'.length })
  envFigure && envFigure.from === 7 && envFigure.options.some((item) => item.label === 'figure')
    ? ok('\\begin{fi → figure（from 落在环境名开头）', JSON.stringify(envFigure.from))
    : bad('环境名没补出来', JSON.stringify(envFigure))
  const figureOption = envFigure && envFigure.options.find((item) => item.label === 'figure')
  figureOption && typeof figureOption.snippet === 'string'
    && figureOption.snippet.startsWith('figure}')
    && figureOption.snippet.includes('\\end{figure}')
    ? ok('\\begin{figure 顺手补 \\end{figure}（光标留在中间）')
    : bad('环境 snippet 不对', JSON.stringify(figureOption && figureOption.snippet))

  // 已经打了右花括号：只补名字，别多出一个 }
  const closedText = '\\begin{figure}'
  const envClosed = complete({ text: closedText, pos: closedText.indexOf('}') })
  envClosed && envClosed.to === closedText.length
    && envClosed.options.every((item) => item.to === undefined || item.to === closedText.length)
    ? ok('已有 } 时一起吃掉，不多补一个花括号')
    : bad('右花括号处理不对', JSON.stringify(envClosed && envClosed.to))

  // \end{ → 全部环境名，且不带 snippet（不收尾）
  const envEnd = complete({ text: '\\end{', pos: 5 })
  envEnd && envEnd.options.length === envs.length
    && envEnd.options.every((item) => !item.snippet)
    ? ok('\\end{ → 全部环境名，不带 snippet', String(envEnd.options.length))
    : bad('\\end{ 处理不对', JSON.stringify(envEnd && envEnd.options.length))

  // 2) 命令前缀
  const sec = complete({ text: '\\su', pos: 3 })
  sec && sec.from === 0
    && sec.options.map((item) => item.label).join(',') === '\\subsection,\\subsubsection,\\sum,\\subset'
    ? ok('\\su → subsection / subsubsection / sum / subset')
    : bad('命令前缀过滤不对', JSON.stringify(sec && sec.options.map((item) => item.label)))
  const frac = complete({ text: '\\fr', pos: 3 })
  const fracOption = frac && frac.options[0]
  fracOption && fracOption.snippet && fracOption.snippet.includes('${1:') && fracOption.snippet.includes('\\frac{')
    ? ok('带占位符的命令给 snippet（Tab 跳字段）')
    : bad('snippet 没带上', JSON.stringify(fracOption))
  const emptyPrefix = complete({ text: '\\', pos: 1 })
  emptyPrefix && emptyPrefix.options.length === labels.length
    ? ok('只打一个反斜杠 → 全部命令', String(emptyPrefix.options.length))
    : bad('空前缀没给全量', JSON.stringify(emptyPrefix && emptyPrefix.options.length))

  // 3) \ref{ → 文档里扫出来的 \label
  const doc = '\\section{引言}\\label{sec:intro}\n\\section{方法}\\label{sec:method}\n\\ref{'
  const ref = complete({ text: doc, pos: doc.length })
  ref && ref.options.map((item) => item.label).join(',') === 'sec:intro,sec:method'
    ? ok('\\ref{ → 文档内 \\label（去重保序）')
    : bad('label 没扫出来', JSON.stringify(ref && ref.options.map((item) => item.label)))
  const noLabel = complete({ text: '\\ref{', pos: 5 })
  noLabel === null ? ok('没有 label 时不弹空框（返回 null）') : bad('空标签还弹框', JSON.stringify(noLabel))

  // 4) \cite{a,b → 只补最后一段，from 落在逗号后面
  const citeText = '\\bibitem{knuth1984} \\bibitem{lamport1994} \\cite{knuth1984,la'
  const cite = complete({ text: citeText, pos: citeText.length })
  cite && cite.from === citeText.length - 2 && cite.options.length === 2
    && cite.options[0].label === 'knuth1984'
    ? ok('\\cite{a,b → 只替换最后一段（不吞掉前面的 key）', String(cite.from))
    : bad('多引用补全位置不对', JSON.stringify(cite && cite.from))

  // 5) 宏包 / 文档类
  const pkg = complete({ text: '\\usepackage{ams', pos: '\\usepackage{ams'.length })
  pkg && pkg.options.map((item) => item.label).join(',') === 'amsmath,amssymb,amsthm'
    ? ok('\\usepackage{ams → amsmath / amssymb / amsthm')
    : bad('宏包补全不对', JSON.stringify(pkg && pkg.options.map((item) => item.label)))
  const cls = complete({ text: '\\documentclass{ctex', pos: '\\documentclass{ctex'.length })
  cls && cls.options.some((item) => item.label === 'ctexart')
    ? ok('\\documentclass{ctex → ctexart / ctexrep / ctexbook')
    : bad('文档类补全不对', JSON.stringify(cls && cls.options.map((item) => item.label)))

  // 6) 不该弹的时候不弹
  const plain = complete({ text: '普通文字 and more', pos: 18 })
  plain === null ? ok('普通文字不弹补全（返回 null）') : bad('普通文字也弹了', JSON.stringify(plain))
  const percent = complete({ text: '% 注释里的 \\su', pos: 10 })
  percent && percent.options.length > 0 && percent.options.every((item) => item.label.indexOf('\\su') === 0)
    ? ok('注释行里的命令照常补（不做语法分析，够用即可）')
    : bad('注释行没补', JSON.stringify(percent && percent.options.map((item) => item.label)))

  // 7) 接线与产物
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const entrySrc = readFileSync(new URL('../lib/vendor/entry.js', import.meta.url), 'utf8')
  const kernelSrc = readFileSync(new URL('../lib/vendor/cm6.js', import.meta.url), 'utf8')
  const wiring = [
    ['内核源码补回了 getSegments（重建别丢行内上色）', entrySrc.includes('getSegments')],
    ['内核源码有补全扩展 completionExtension', entrySrc.includes('completionExtension')],
    ['内核产物含 onComplete（重建后确实带上了补全）', kernelSrc.includes('onComplete')],
    ['编辑器把补全源接进 create（onComplete → completeLatex）',
      src.includes('onComplete: function (context)') && src.includes('return completeLatex({ text: context.state.doc.toString(), pos: context.pos })')],
    ['KERNEL_VERSION 加一（打掉浏览器旧缓存）', src.includes("var KERNEL_VERSION = '5'")],
    // 踩过的坑：highlightDocument 返回 {segments,bold} 包装对象，直接递给内核时
    // 内核按「每行一个 segment 数组」迭代 → lines[i].length 是 undefined → 整行跳过
    // → 一条行内样式都没涂，线上只剩 stex 兜底色，\begin{} 环境名/键全是白字。
    ['getSegments 把包装对象摊成 segment 数组（行内上色不能整行被跳过）',
      /getSegments: function \(text\) \{[\s\S]{0,700}?var doc = highlightDocument\(text\)[\s\S]{0,300}?rows\.push\(doc\[i\]\.segments\)/.test(src)],
    ['内核按 segment 数组迭代（lines[i] 必须直接可 for-of）',
      entrySrc.includes('const segments = lines[number - 1]') && !/const segments = lines\[number - 1\][\s\S]{0,80}\.segments/.test(entrySrc)],
    // 用户要求「直接从墨灵tex.exe 搬运套用，别自己瞎编辑」：内核词法换成桌面版
    // Editor.vue 那套自写 StreamLanguage（不再用 legacy-modes 的 stex —— stex 把
    // 环境名和 \label 的键都吐成 atom，跟面板分词对不上）。
    ['内核改用桌面版的 StreamLanguage 词法（不再 import stex）',
      entrySrc.includes('StreamLanguage.define({') && !/from\s+'@codemirror\/legacy-modes/.test(entrySrc)],
    ['内核词法把 \\begin{...} 整体当 keyword（环境名跟着命令一起紫）',
      entrySrc.includes('^\\\\begin\\{[^}]*\\}')],
    ['内核产物里带上了新词法（propertyName/escape 都在）',
      kernelSrc.includes('propertyName') && kernelSrc.includes('escape')],
    ['补全抛错时兜底返回 null（不让补全把编辑器搞崩）',
      /onComplete: function \(context\) \{\s*try \{/.test(src)],
    ['补全弹窗配色复用主题 token（不额外写死颜色）',
      entrySrc.includes('.cm-tooltip-autocomplete') && !/#fff/.test(entrySrc.slice(entrySrc.indexOf('.cm-tooltip')))],
    // 补全源必须只造一次：languageData 的 provider 每次读 facet 都会被调，
    // 在里面 new 函数 → CM 认为源换了 → 每帧重启补全 → 弹窗永远出不来（真踩过）。
    ['补全源只造一次（provider 返回同一个数组）',
      entrySrc.includes('const data = [{ autocomplete: source }]') && entrySrc.includes('EditorState.languageData.of(() => data)')],
    ['补全源不在 provider 里现造函数（否则弹窗永不出现）',
      !/languageData\.of\(\(\)\s*=>\s*\[\{[^}]*autocomplete:\s*\(/.test(entrySrc)],
    ['补全表规模够用（命令 ≥ 80 / 环境 ≥ 40 / 宏包 ≥ 50）',
      labels.length >= 80 && envs.length >= 40 && bundle.__LATEX_PACKAGES.length >= 50]
  ]
  for (const [label, passed] of wiring) passed ? ok(label) : bad(label)
} catch (error) {
  bad('自动补全测试抛错', String(error.message))
}

console.log('29) SyncTeX 不依赖会话工作区（按当前 tex 选同名 PDF + 反向定位按 file 切标签）')
try {
  const pdfFor = bundle.__pdfRelForTab
  const relOf = bundle.__relFromSynctexFile
  const files = [
    { rel: 'main.tex' }, { rel: 'main.pdf' },
    { rel: 'Safety_MARL框架.tex' }, { rel: 'Safety_MARL框架.pdf' },
    { rel: '问题场景定义.tex' }
  ]
  const checks = [
    // 核心回归：一个项目里多个 tex 时，绝不能再盲用「上一次预览的 PDF」
    ['当前 tex 选自己的同名 PDF（不是上一次预览的 main.pdf）',
      pdfFor({ rel: 'Safety_MARL框架.tex' }, files, 'main.pdf') === 'Safety_MARL框架.pdf'],
    ['清单里没有同名 PDF 时，兜底值同名才用',
      pdfFor({ rel: '问题场景定义.tex' }, files, 'main.pdf') === ''],
    ['清单里没有但兜底值同名 → 用兜底（刚编译完树还没刷）',
      pdfFor({ rel: 'a.tex' }, [], 'a.pdf') === 'a.pdf'],
    ['反斜杠路径也认', pdfFor({ rel: 'sub\\x.tex' }, [{ rel: 'sub/x.pdf' }], '') === 'sub/x.pdf'],
    ['没有 tab 时返回空串（调用方给提示，不发注定失败的请求）', pdfFor(null, files, 'main.pdf') === ''],
    ['不是 tex 的标签不配 PDF', pdfFor({ rel: 'a.pdf' }, files, 'main.pdf') === ''],
    // 反向定位：SyncTeX 回的 file 可能是另一个 tex（\input 章节），要能换成项目内相对路径
    ['SyncTeX 返回的绝对路径 → 项目内相对路径',
      relOf('E:/p', 'E:/p/Safety_MARL框架.tex', files) === 'Safety_MARL框架.tex'],
    ['容忍 ./ 这类冗余段',
      relOf('E:/p', 'E:/p/./main.tex', files) === 'main.tex'],
    ['大小写/斜杠不同也认',
      relOf('E:\\p', 'e:/p/main.tex', files) === 'main.tex'],
    ['不在当前项目里的文件 → 空串（只提示不乱跳）',
      relOf('E:/p', 'E:/other/x.tex', files) === '']
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 接线：两个同步入口都必须走 pdfRelForTab，且反向定位真的用了 data.file
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const fwd = src.slice(src.indexOf('var forwardSync = function'), src.indexOf('var backwardSync = function'))
  const bwd = src.slice(src.indexOf('var backwardSync = function'), src.indexOf('// 提纲浮层开着时'))
  const wiring = [
    ['正向定位按 tab 选 PDF（不再盲传 store.pdfRel）',
      fwd.includes('pdfRelForTab(target, state.files, state.pdfRel)') && !/pdf:\s*store\.pdfRel/.test(fwd)],
    ['反向定位按 tab 选 PDF', bwd.includes('pdfRelForTab(target, state.files, state.pdfRel)') && !/pdf:\s*store\.pdfRel/.test(bwd)],
    ['反向定位按 data.file 判断落到了哪个文件', bwd.includes('relFromSynctexFile(target.root, data.file, state.files)')],
    ['落到别的 tex 时先 openTab 再跳（否则跳错位置还显示成功）',
      bwd.includes('openTab(target.root, landed)')],
    ['找不到同名 PDF 时给出明确提示，不静默失败',
      fwd.includes('还没编译出同名 PDF') && bwd.includes('还没编译出同名 PDF')]
  ]
  for (const [label, passed] of wiring) passed ? ok(label) : bad(label)
} catch (error) {
  bad('SyncTeX PDF 配对测试抛错', String(error.message))
}

console.log('30) 文件树抽屉自适应尺寸（高度看行数、宽度看最长文件名）')
try {
  const autoSize = bundle.__treeAutoSize
  const textWidth = bundle.__treeTextWidth

  // 目录树：2 个目录 + 3 个文件；deep/ 里还有一层
  const tree = {
    name: 'proj', rel: '', type: 'dir', children: [
      { name: 'figures', rel: 'figures', type: 'dir', children: [
        { name: 'cat.pdf', rel: 'figures/cat.pdf', type: 'file' }
      ] },
      { name: 'deep', rel: 'deep', type: 'dir', children: [
        { name: 'inner', rel: 'deep/inner', type: 'dir', children: [
          { name: 'x.tex', rel: 'deep/inner/x.tex', type: 'file' }
        ] }
      ] },
      { name: 'main.tex', rel: 'main.tex', type: 'file' },
      { name: '短.tex', rel: '短.tex', type: 'file' }
    ]
  }
  const files = [
    { rel: 'figures/cat.pdf' }, { rel: 'deep/inner/x.tex' },
    { rel: 'main.tex' }, { rel: '短.tex' }
  ]

  // 1) 行数 = 可见节点数（根不算）：figures + cat.pdf + deep + inner + x.tex + main.tex + 短.tex = 7
  const all = autoSize({ tree: tree, expanded: {}, files: files, filter: '' })
  all.rows === 7 ? ok('高度按可见行数算（展开全部 7 行）', String(all.rows)) : bad('行数算错', JSON.stringify(all))
  all.height === 27 + 10 + 7 * 21
    ? ok('高度 = 表头 + 内边距 + 行数 × 行高（不撑满编辑区）', String(all.height))
    : bad('高度算错', JSON.stringify(all))

  // 2) 折叠 deep 之后少 2 行（inner / x.tex；deep 自己还在）
  const folded = autoSize({ tree: tree, expanded: { deep: false }, files: files, filter: '' })
  folded.rows === 5 && folded.height === 27 + 10 + 5 * 21
    ? ok('折叠目录后高度跟着缩（不是固定高度）', String(folded.rows))
    : bad('折叠后行数/高度不对', JSON.stringify(folded))

  // 3) 宽度看最长文件名：全角按 11.5、半角按 6.6，夹在 168…560
  const longName = autoSize({
    tree: { name: 'p', rel: '', type: 'dir', children: [{ name: '2026_DRO_RL_ML_研究综述笔记.md', rel: 'a.md', type: 'file' }] },
    expanded: {}, files: [], filter: ''
  })
  const expectLong = 16 + 15 + textWidth('2026_DRO_RL_ML_研究综述笔记.md')
  longName.width === Math.ceil(Math.min(Math.max(168, expectLong), 560))
    ? ok('宽度 = 最长文件名（中文按全角算）+ 图标与内边距', String(longName.width))
    : bad('宽度没按最长文件名算', JSON.stringify({ got: longName.width, want: expectLong }))
  longName.width > 168 ? ok('长文件名时比最小宽度宽（不被截断）', String(longName.width)) : bad('长名没撑开', String(longName.width))

  // 4) 短文件名时收到最小宽度，不会窄成一条缝
  const tiny = autoSize({ tree: { name: 'p', rel: '', type: 'dir', children: [{ name: 'a', rel: 'a', type: 'file' }] }, expanded: {}, files: [], filter: '' })
  tiny.width === 168 ? ok('文件名都很短时保持最小宽度（表头不挤）', String(tiny.width)) : bad('最小宽度没兜住', String(tiny.width))

  // 5) 超长文件名夹到上限（不让抽屉吃掉整个编辑区）
  const huge = autoSize({
    tree: { name: 'p', rel: '', type: 'dir', children: [{ name: 'x'.repeat(300), rel: 'x', type: 'file' }] },
    expanded: {}, files: [], filter: ''
  })
  huge.width === 560 ? ok('超长文件名夹到上限 560（不占满编辑区）', String(huge.width)) : bad('上限没夹住', String(huge.width))

  // 6) 过滤时按平铺结果算行数与宽度
  const filtered = autoSize({ tree: tree, expanded: {}, files: files, filter: 'main' })
  filtered.rows === 1 ? ok('过滤后只按命中的行算高度', String(filtered.rows)) : bad('过滤后行数不对', JSON.stringify(filtered))
  const filteredWide = autoSize({ tree: tree, expanded: {}, files: files, filter: '.tex' })
  filteredWide.rows === 3 ? ok('过滤命中的行数正确（.tex 3 个）', String(filteredWide.rows)) : bad('过滤命中数不对', JSON.stringify(filteredWide))

  // 7) 空树：只剩表头，不报错
  const empty = autoSize({ tree: { name: 'p', rel: '', type: 'dir', children: [] }, expanded: {}, files: [], filter: '' })
  empty.rows === 0 && empty.height === 37 && empty.width === 168
    ? ok('空目录只留表头高度（不撑出空白区）', JSON.stringify(empty))
    : bad('空目录尺寸不对', JSON.stringify(empty))

  // 8) 接线：抽屉用 px 宽高、拖动记像素、双击回自适应、旧的比例字段彻底不用了
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const boxAt = src.indexOf('var treeBox = treeAutoSize')
  const drawerSrc = boxAt >= 0 ? src.slice(boxAt, boxAt + 600) : ''
  const wiring = [
    ['抽屉宽度用自适应结果（不是百分比）',
      src.includes("width: (store.treeW > 0 ? store.treeW : treeBox.width) + 'px'") && !src.includes("(store.treeWidth * 100).toFixed(1) + '%'")],
    ['抽屉高度用自适应结果（不再 top/bottom 撑满）',
      src.includes('height: treeBox.height +') && !/drawer:\s*\{[^}]*bottom: 8/s.test(src)],
    ['文件多到装不下时才内部滚动（maxHeight 兜住）',
      src.includes("maxHeight: 'calc(100% - 16px)'")],
    ['空目录/读取中时留出最小高度（不缩成一条缝）',
      src.includes('minHeight: (TREE_HEAD_H + TREE_LIST_PAD + TREE_ROW_H * 2)')],
    ['拖动右边框记像素宽（不再记比例）',
      src.includes('patch({ treeW: Math.round(clamp(') && !src.includes('patch({ treeWidth:')],
    ['双击右边框恢复自适应', src.includes('onDoubleClick: function () { patch({ treeW: 0 }); persist() }')],
    ['旧的比例字段 treeWidth 已彻底移除', !src.includes('treeWidth')],
    ['高度按左栏实际可用高度夹一次（窗口矮时不溢出）', drawerSrc.includes('leftRoom')]
  ]
  for (const [label, passed] of wiring) passed ? ok(label) : bad(label)
} catch (error) {
  bad('文件树自适应测试抛错', String(error.message))
}

console.log('31) 会话隔离（A 会话进项目 A，切到 B 会话不受影响，切回 A 原样恢复）')
try {
  const store = bundle.__store
  const switchTo = bundle.__switchSession

  // 先落到一个干净会话，别让前面几十节留下的现场干扰
  switchTo('__iso_a')
  bundle.__closeProjectFiles()

  // 演「A 会话从墨灵进了项目 A」
  store.view = 'workbench'
  store.root = 'E:\\proj-a'
  store.files = [{ rel: 'main.tex' }]
  store.tree = { name: 'proj-a', rel: '', type: 'dir', children: [] }
  store.tabs = [{ id: 901, root: 'E:\\proj-a', rel: 'main.tex', text: 'A 的内容', dirty: false }]
  store.activeId = 901
  store.pdfRel = 'main.pdf'
  store.pdfRev = '11'
  store.engine = 'xelatex'

  // 切到 B：B 从没进过项目 → 必须回启动页，绝不把 A 的项目带过来
  const changed = switchTo('__iso_b')
  changed === true ? ok('切到另一个会话会真的切换（返回 true）', String(changed)) : bad('切会话没生效', String(changed))
  store.view === 'welcome' ? ok('B 会话落到启动页（不继承 A 的项目）', store.view) : bad('B 会话继承了 A 的视图', store.view)
  store.root === '' ? ok('B 会话的工作区是空的', JSON.stringify(store.root)) : bad('B 会话拿到 A 的 root', store.root)
  store.tabs.length === 0 ? ok('B 会话没有 A 的标签页', String(store.tabs.length)) : bad('B 会话看到 A 的标签', String(store.tabs.length))
  store.pdfRel === '' ? ok('B 会话没有 A 的 PDF 预览', JSON.stringify(store.pdfRel)) : bad('B 会话拿到 A 的 PDF', store.pdfRel)
  bundle.__treeSignature() === '' ? ok('B 会话的文件清单签名也清空（不会误判外部改动）', '') : bad('签名串了会话', bundle.__treeSignature())

  // 设置类字段不参与隔离：编译引擎是这台机器的偏好，不该跟着项目走
  store.engine === 'xelatex' ? ok('设置类字段（引擎）不参与隔离，切会话保留', store.engine) : bad('引擎被会话切没了', store.engine)

  // B 自己进项目 B
  store.view = 'workbench'
  store.root = 'E:\\proj-b'
  store.tabs = [{ id: 902, root: 'E:\\proj-b', rel: 'paper.tex', text: 'B 的内容', dirty: false }]
  store.activeId = 902

  // 切回 A：原样恢复
  switchTo('__iso_a')
  store.root === 'E:\\proj-a' ? ok('切回 A，工作区还是项目 A', store.root) : bad('A 的 root 丢了', store.root)
  store.tabs.length === 1 && store.tabs[0].id === 901 && store.tabs[0].text === 'A 的内容'
    ? ok('切回 A，标签页与内容原样恢复', store.tabs[0].rel)
    : bad('A 的标签页没恢复', JSON.stringify(store.tabs))
  store.activeId === 901 ? ok('切回 A，当前标签也恢复', String(store.activeId)) : bad('A 的活动标签丢了', String(store.activeId))
  store.pdfRel === 'main.pdf' && store.pdfRev === '11'
    ? ok('切回 A，PDF 预览状态恢复', store.pdfRel + ' rev=' + store.pdfRev)
    : bad('A 的 PDF 状态没恢复', JSON.stringify({ rel: store.pdfRel, rev: store.pdfRev }))

  // 反过来：再切 B，B 也还是 B（两边各自独立）
  switchTo('__iso_b')
  store.root === 'E:\\proj-b' && store.tabs.length === 1 && store.tabs[0].id === 902
    ? ok('切到 B，B 仍是项目 B（A 没顶掉它）', store.root)
    : bad('B 的状态被 A 污染', JSON.stringify({ root: store.root, tabs: store.tabs.map((t) => t.id) }))

  // 同一个会话重复切 = 空操作（不会白清一遍状态）
  switchTo('__iso_b') === false ? ok('同一个会话重复切换是空操作', 'false') : bad('重复切同一会话还动了状态')

  // 忙闲字段不跟着项目走：上一个会话没跑完的编译/取图不能把新会话永久卡在「忙」
  store.busy = 'compile'
  store.syncBusy = 'tree'
  store.outlineBusy = 'outline'
  store.dragging = true
  switchTo('__iso_a')
  store.busy === '' && store.syncBusy === '' && store.outlineBusy === '' && store.dragging === false
    ? ok('切会话清掉忙闲字段（不会永久卡在「忙」）', 'busy/syncBusy/outlineBusy/dragging 全清')
    : bad('忙闲字段跟着会话跑了', JSON.stringify({ busy: store.busy, syncBusy: store.syncBusy, outlineBusy: store.outlineBusy, dragging: store.dragging }))

  // 接线：Body 只让「屏幕上的那份」动全局 store
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const wiring = [
    ['Body 从注入属性里读会话 id', src.includes("face.sessionId || face.session || (face.session && face.session.id)")],
    ['只有可见的 tab 才切会话（隐藏的 Body 不许抢）', src.includes('if (!visible) return')],
    ['再用 sidebarRight.mounted 兜一层（浮动面板下 visible 可能同时为真）',
      src.includes("state.ctx.get('sidebarRight')") && src.includes('mounted !== sessionId')],
    ['mounted 服务没就绪会重试，不是只试一次', src.includes('tries++ < 20')],
    ['切会话后作废上一个会话的待触发定时器', /pendingFlash = null\s*\n\s*return true/.test(src)],
    ['进项目闸门在切会话时复位（否则轮询永久暂停）', src.includes('enteringRoot = false   // 卡在「进项目」中间被切走')],
    ['设置类字段不在隔离清单里（编译方式/引擎/分栏宽等）',
      !bundle.__SESSION_FIELDS.includes('engine') && !bundle.__SESSION_FIELDS.includes('treeW') && !bundle.__SESSION_FIELDS.includes('mode')],
    ['项目字段在隔离清单里（view/root/tabs/pdfRel）',
      ['view', 'root', 'tabs', 'pdfRel', 'files', 'tree'].every((key) => bundle.__SESSION_FIELDS.includes(key))],
    // 异步回包的护栏：切了会话/切了项目之后，旧请求的结果不许往新会话里灌
    ['loadTree 回包前核对项目没变', /normalizePath\(target\) !== normalizePath\(state\.root\)[\s\S]{0,80}return undefined/.test(src)],
    ['openTab 读盘回包前核对标签还在（切会话就丢弃）', /read-file[\s\S]{0,120}if \(!findTabById\(id\)\) return undefined/.test(src)],
    ['saveTab 写盘回包前核对标签还在', /write-file[\s\S]{0,200}if \(!findTabById\(id\)\) return undefined/.test(src)],
    ['切会话不再回收另一个会话的 PDF blob（否则切回去是破图）',
      !src.slice(src.indexOf('function switchSession'), src.indexOf('function activeTab')).includes('revokeObjectURL')]
  ]
  for (const [label, passed] of wiring) passed ? ok(label) : bad(label)
} catch (error) {
  bad('会话隔离测试抛错', String(error.message))
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
