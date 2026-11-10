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
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
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
    ['「模板」卡片', html.includes('新建中文文档') && html.includes('ctexart')],
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
    ['树开关', html.includes('树')],
    ['编译按钮', html.includes('编译')],
    ['日志页签', html.includes('日志')],
    ['PDF 页签', html.includes('PDF')],
    ['状态行', html.includes('就绪')],
    ['左右两栏（右栏 45.0%）', html.includes('width:45.0%')],
    ['tex/pdf 分隔条可拖动', html.includes('col-resize')],
    ['挂载 CodeMirror 宿主', html.includes('ml-cm')],
    ['渲染出 1~6 行行号', ed.includes('data-line="1"') && ed.includes('data-line="6"')],
    ['命令着色（brand-primary）', ed.includes('dsw-alias-brand-primary')],
    ['环境名着色（state-error-primary）', ed.includes('dsw-alias-state-error-primary')],
    ['引用键着色（state-warn-primary）', ed.includes('dsw-alias-state-warn-primary')],
    ['数学着色（state-success-primary）', ed.includes('dsw-alias-state-success-primary')],
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
  const line3AllMath = lines[2].segments.length > 0 && lines[2].segments.every((segment) => segment.style && /state-success/.test(segment.style.color))

  const checks = [
    ['\\cite 命令着色', Boolean(cmdSeg.style && /brand-primary/.test(cmdSeg.style.color))],
    ['\\cite 键单独着色', Boolean(keySeg.style && /state-warn/.test(keySeg.style.color))],
    ['\\begin 的 align 环境名着色', Boolean(envSeg.style && /state-error/.test(envSeg.style.color))],
    ['环境内公式跨行按数学着色', line3AllMath],
    ['\\end 的环境名同样着色', Boolean(endEnv.style && /state-error/.test(endEnv.style.color))],
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
    ['回退实现仍有语法着色', withoutKernel.includes('dsw-alias-brand-primary')],
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
    ['顶栏有「保存」', html.includes('>保存<')],
    // 顶栏分组：树+提纲 一个圆角底色区，换行+保存+新建 另一个
    ['分组一：树 + 提纲 同底色圆角区', (function () {
      const from = html.indexOf('data-btn-group="view"')
      const to = html.indexOf('data-btn-group="edit"')
      const seg = from > -1 && to > from ? html.slice(from, to) : ''
      return seg.includes('>树<') && seg.includes('>提纲<')
    })()],
    ['分组二：换行 + 保存 + 新建 同底色圆角区', (function () {
      const from = html.indexOf('data-btn-group="edit"')
      const seg = from > -1 ? html.slice(from, from + 1600) : ''
      return seg.includes('>换行<') && seg.includes('>保存<') && seg.includes('>新建<')
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
    ['组内竖分隔线：树 | 提纲 一条、换行 | 保存 | 新建 两条', (function () {
      const viewFrom = html.indexOf('data-btn-group="view"')
      const editFrom = html.indexOf('data-btn-group="edit"')
      const viewSeg = viewFrom > -1 && editFrom > viewFrom ? html.slice(viewFrom, editFrom) : ''
      const editSeg = editFrom > -1 ? html.slice(editFrom, editFrom + 1600) : ''
      const count = (text) => (text.match(/data-btn-sep/g) || []).length
      return count(viewSeg) === 1 && count(editSeg) === 2
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
    ['顶栏有「提纲」按钮', outlineHtml.includes('>提纲<')],
    ['顶栏有「新建」按钮（提纲旁边）', outlineHtml.includes('>新建<') && outlineHtml.indexOf('>提纲<') < outlineHtml.indexOf('>新建<')],
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

  const payload = bundle.__formatSelectionPayload('main.tex', 2, 3, 'a & b\n')
  const payloadOk = payload.includes('> 来自 main.tex 第 2–3 行') && payload.includes('```latex\na & b\n```')
  payloadOk ? ok('消息体带出处与 latex 代码块') : bad('消息体格式不对', JSON.stringify(payload))

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
    ['多个非 main 的 .tex 拿不准 → 不开', pick([{ rel: 'a.tex' }, { rel: 'b.tex' }]) === null],
    ['反斜杠路径也能识别', pick([{ rel: 'sub\\main.tex' }]) === 'sub\\main.tex']
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 接线：enterRoot 里真的调了挑主 tex，且「打开具体文件 / 新建文档」两处关掉自动开
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const enter = src.slice(src.indexOf('function enterRoot'), src.indexOf('function openDirectory'))
  const offCount = (src.match(/autoOpen: false/g) || []).length
  ok('enterRoot 接线（loadTree 后挑主 tex + autoOpen 开关）',
    enter.includes('pickMainTex(state.files)') && enter.includes('autoOpen === false'))
  ok('打开具体文件/新建文档不被抢（2 处 autoOpen:false）', offCount === 2)
} catch (error) {
  bad('自动打开主 tex 测试抛错', String(error.message))
}

console.log('18) 分界线互换圆钮（墨灵面板 ↔ 对话框）')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const checks = [
    ['圆钮组件（SwapButton）在场', src.includes('function SwapButton(props)')],
    ['图标 = 上下重叠的两支左右双箭头（两条 path）',
      src.includes('M1.8 4.4 H11.2') && src.includes('M1.8 8.6 H11.2')],
    ['贴分界线：fixed + 实测 [data-moling] 左右缘', src.includes("position: 'fixed'") && src.includes("document.querySelector('[data-moling]')")],
    ['互换靠 flex/grid 的 order，并量位置验证', src.includes('style.order') && src.includes('before * after < 0')],
    ['验证不过就回滚，不留半吊子布局', src.includes("cols.mine.style.order = ''") && src.includes('已还原')],
    ['Body 里挂了圆钮（Fragment 与视图并列）', src.includes('h(SwapButton, { store: store })')],
    ['位置状态只记会话内（不进 localStorage 白名单）', !src.includes('swapOn: state.swapOn')]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
} catch (error) {
  bad('互换圆钮测试抛错', String(error.message))
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

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
