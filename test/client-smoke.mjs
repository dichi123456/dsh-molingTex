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
    ['启动页已去掉「新建中文文档」卡片（用户 2026-11-14 要求）',
      !html.includes('新建中文文档') && !html.includes('ctexart 骨架')],
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
    // 顶栏那个"打开目录"按钮确实去掉了；但 PDF 悬浮工具栏里新加的「目录」= PDF 书签，
    // 是另一回事，所以只在顶栏那一段（首页 → 文件树之间）判定
    // 顶栏那个"打开目录"按钮确实去掉了；PDF 工具栏的「目录」= PDF 书签，另一回事
    ['顶栏「目录」按钮已去掉（PDF 工具栏那个是新加的 PDF 书签）', !html.includes('>目录<')],
    // 用户 2026-11-19：顶栏文字按钮改图标（文字进 title），所以断言改成查 className + title
    ['文件树开关（图标按钮，文字进 title）', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
      .indexOf("className: 'ml-tree-btn'") > 0],
    ['文件大纲开关（图标按钮，文字进 title）', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
      .indexOf("className: 'ml-outline-btn'") > 0],
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
    '占比 100\\% 的样本，见 \\ref{sec:intro}',
    '式中，形如 $\\%$ 的写法之后还有正文，不该变灰。',
    '真注释 % 从这里开始'
  ].join('\n'))

  const find = (index, text) => (lines[index].segments.find((segment) => segment.text === text) || {})
  const keySeg = find(0, 'somaksak2020-01_liu2026')
  const envSeg = find(1, 'align')
  const cmdSeg = find(1, '\\begin')
  const endEnv = find(3, 'align')
  const line3AllMath = lines[2].segments.length > 0 && lines[2].segments.every((segment) => segment.style && /#98c379/.test(segment.style.color))
  // \% 之后不许变注释：数学里的 $\%$ 整段按数学绿，后面的正文保持无色
  const mathPct = find(5, '$\\%$')
  const pctIsComment = lines[5].segments.some((segment) => segment.style && segment.style.fontStyle === 'italic')
  const afterPctText = lines[5].segments.map((segment) => segment.text).join('')
  const realComment = lines[6].segments.some((segment) => segment.text.indexOf('从这里开始') >= 0 && segment.style && segment.style.fontStyle === 'italic')

  const checks = [
    ['\\cite 命令着色（桌面版紫 #c678dd）', Boolean(cmdSeg.style && /#c678dd/.test(cmdSeg.style.color))],
    ['\\cite 键单独着色（桌面版转义青 #56b6c2）', Boolean(keySeg.style && /#56b6c2/.test(keySeg.style.color))],
    ['\\begin 的 align 环境名着色（桌面版命令紫 #c678dd）', Boolean(envSeg.style && /#c678dd/.test(envSeg.style.color))],
    ['环境内公式跨行按数学着色（桌面版字符串绿 #98c379）', line3AllMath],
    ['\\end 的环境名同样着色', Boolean(endEnv.style && /#c678dd/.test(endEnv.style.color))],
    ['\\% 转义不会把整行变注释', lines[4].segments.some((segment) => segment.style === null && segment.text.indexOf('的样本') >= 0)],
    ['\\ref 键着色', Boolean((find(4, 'sec:intro') || {}).style)],
    // 用户 2026-11-14 报的 bug：$\%$ 之后整段变灰斜体（误当注释）
    ['数学里的 $\\%$ 按数学着色，不是注释', Boolean(mathPct.style && /#98c379/.test(mathPct.style.color))],
    ['$\\%$ 之后的正文不变灰', afterPctText.indexOf('不该变灰') >= 0 && !pctIsComment],
    ['真注释仍然是灰斜体', realComment],
    ['行数一致', lines.length === 7]
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
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
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
    ['dpi 固定 96（不再给用户选）', bundle.__PDF_DPI === 96],
    // 清晰度只作用于「预览栅格化」：编译请求里不能出现 dpi，
    // 否则会让人以为编译产物被降质（用户 2026-11-16 问过这件事）。
    ['编译请求不带 dpi（产物始终是矢量 PDF）', !/api\('compile',\s*\{[^}]*dpi/.test(src)],
    // 预览与投屏共用 pdfPageUrl：默认落回 PDF_DPI，投屏可显式传三档 DPI
    ['dpi 只用于图片地址（默认落回 PDF_DPI）', src.includes("var useDpi = Number(dpi) > 0 ? Number(dpi) : PDF_DPI")], 
    ['PDF 顶栏不再有清晰度下拉', !html.includes('预览清晰度：') && !html.includes('极')],
    ['按加载前占位比例（防跳动）', /aspect-ratio:595\.276 \/ 841\.89/.test(html) || /aspect-ratio:595\.276\/841\.89/.test(html)]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 幻灯片（beamer 4:3）：每页尺寸不同，容器必须按该页真实比例占位，
  // 否则会被当成 A4 纵向拉伸（用户报的「幻灯片比例不友好」）。
  store.pdfPageSize = { width: 362.83, height: 272.13 }
  store.pdfPageSizes = [{ width: 362.83, height: 272.13 }, { width: 362.83, height: 272.13 }, { width: 595.276, height: 841.89 }]
  const slides = render()
  const aspectFor = bundle.__pageAspectFor
  const sizeFor = bundle.__pageSizeFor
  const slideChecks = [
    ['幻灯片页按自身 4:3 比例占位', /aspect-ratio:362\.83 \/ 272\.13/.test(slides) || /aspect-ratio:362\.83\/272\.13/.test(slides)],
    ['同一份 PDF 里混排的 A4 页仍按 A4 占位', /aspect-ratio:595\.276 \/ 841\.89/.test(slides) || /aspect-ratio:595\.276\/841\.89/.test(slides)],
    ['页面图自身不写 aspect-ratio（会压过图片固有比例）', !/pdfPage: \{[^}]*aspectRatio/.test(src)],
    ['逐页尺寸取不到时退回首页尺寸', (() => {
      const one = sizeFor({ pdfPageSize: { width: 400, height: 300 }, pdfPageSizes: null }, 2)
      return one.width === 400 && one.height === 300
    })()],
    ['实测像素比例优先于 pdfinfo（/Rotate 只有像素知道）', (() => {
      const rotated = sizeFor({
        pdfPageSize: { width: 595.276, height: 841.89 },
        pdfPageSizes: [{ width: 595.276, height: 841.89 }],
        pdfPageRatios: { 1: { width: 1684, height: 1190 } }
      }, 1)
      return Math.abs(rotated.height - 595.276 * (1190 / 1684)) < 0.01
    })()],
    ['比例字符串保留 4 位小数', aspectFor({ pdfPageSize: { width: 362.83, height: 272.13 } }, 1) === '362.83 / 272.13']
  ]
  for (const [label, passed] of slideChecks) passed ? ok(label) : bad(label)
  store.pdfPageSize = null
  store.pdfPageSizes = null

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
  store.pdfZoom = 2
  store.syncMark = { page: 1, x: 100, y: 200 }
  store.pdfPageSize = { width: 595.276, height: 841.89 }

  const html = render()
  const percent = bundle.__syncPercent
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 展开编译方式下拉，验证三种模式在菜单里
  store.compileMenu = true
  const compileMenuHtml = render()
  store.compileMenu = false
  const checks = [
    // 换行按钮改成图标（文字进 title）
    ['顶栏有「换行」图标按钮', html.includes('ml-wrap-btn') || html.includes('ml-tree-btn')],
    ['顶栏有「保存」分体按钮（默认手动保存）', html.includes('>手动保存<') && html.includes('>▾<')],
    // 顶栏分组：文件树+文件大纲 一个圆角底色区，换行+保存+新建+自编 另一个
    ['分组一：文件树 + 文件大纲 同底色圆角区', (function () {
      const from = html.indexOf('data-btn-group="view"')
      const to = html.indexOf('data-btn-group="edit"')
      const seg = from > -1 && to > from ? html.slice(from, to) : ''
      // 图标按钮：内容里是 svg，认 class 而不是文字
      return seg.includes('ml-tree-btn') && seg.includes('ml-outline-btn')
    })()],
    ['分组二：换行 + 保存 + 新建 + 自编 同底色圆角区', (function () {
      const from = html.indexOf('data-btn-group="edit"')
      if (from < 0) return false
      const at = (text) => html.indexOf(text, from)
      const wrap = at('ml-wrap-btn')
      const save = at('>手动保存<')
      const create = at('ml-new-btn')
      const auto = at('ml-autocompile-btn')
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
    ['组内竖分隔线：文件树 | 文件大纲 一条、换行 | 保存 | 新建 | 自编 三条', (function () {
      const viewFrom = html.indexOf('data-btn-group="view"')
      const editFrom = html.indexOf('data-btn-group="edit"')
      const viewSeg = viewFrom > -1 && editFrom > viewFrom ? html.slice(viewFrom, editFrom) : ''
      // 图标化后整组变长（每个按钮多了一层 svg），窗口放宽到 4000 字符
      const editSeg = editFrom > -1 ? html.slice(editFrom, editFrom + 4000) : ''
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
    ['展开后有四种方式', compileMenuHtml.includes('完整编译') && compileMenuHtml.includes('单趟编译') && compileMenuHtml.includes('无图编译') && compileMenuHtml.includes('从头编译')],
    ['按钮上显示当前编译方式', html.includes('>完整编译<') || html.includes('>单趟编译<') || html.includes('>无图编译<') || html.includes('>从头编译<')],
    ['右键菜单默认不显示', !html.includes('定位到 PDF 位置')],
    ['缩放到 200% 时页面宽度翻倍', html.includes('width:200.00%')],
    ['页面容器不再被 maxWidth:100% 卡死（放大可超出窗口、可横向拖动）',
      html.includes('position:relative;margin:0 auto 8px') && !html.includes('margin:0 auto 8px;max-width:100%')],
    // 用户 2026-11-14 要求「pdf 预览区域的黑边去掉，pdf 直接紧贴分割处，不预留黑框」：
    // 预览容器不能有内边距/底色，页面图不能有投影，圆角归零。
    ['PDF 预览区不再预留黑边（无内边距、无底色）',
      src.includes("pdfScroll: { flex: 1, overflow: 'auto', padding: 0, minHeight: 0, background: 'transparent'") &&
      !src.includes("pdfScroll: { flex: 1, overflow: 'auto', padding: '8px 10px'")],
    ['PDF 页面图不再有投影/圆角（深色底上就是一条黑边）',
      src.includes("background: '#fff', borderRadius: 0, objectFit: 'contain'") &&
      !/pdfPage: \{[\s\S]{0,300}?boxShadow/.test(src)],
    // 用户 2026-11-14 报「幻灯片比例不友好」：aspect-ratio 写在图片上会压过图片固有比例，
    // beamer 4:3 / 16:9 被纵向拉成 A4。比例必须放在外层容器（pdfPageBox）上。
    ['页面图不再写死 A4 比例（比例交给外层容器）', !/pdfPage: \{[\s\S]{0,300}?aspectRatio/.test(src)],
    ['页容器按该页真实比例占位', /aspectRatio: pageAspectFor\(store, page\)/.test(src)],
    ['显示缩放百分比', html.includes('200%')],
    // 用户 2026-11-19：窄窗时工具栏换行会溢出悬浮块 → 按钮全部改成图标（只留 svg，文字进 title）
    ['缩放按钮改成图标（缩放提示在 title 里）',
      /className: 'ml-pdf-tools'[\s\S]{0,3000}?title: '缩小（Ctrl \+ 滚轮亦可）'/.test(src) &&
        /className: 'ml-pdf-tools'[\s\S]{0,3400}?title: '放大（Ctrl \+ 滚轮亦可）'/.test(src)],
    ['「适应」改成图标（四角箭头 + title）',
      /title: '整页适应当前窗口'/.test(src) && !/\}, '适应'\)/.test(src)],
    ['页数按钮保留数字但去掉「第 / 页」字样（宽度减半，窄窗才放得下）',
      /clamp\(store\.pdfViewPage \|\| 1, 1, store\.pdfPages\) \+ '\/' \+ store\.pdfPages/.test(src) &&
        src.includes("'—'")],
    ['清理按钮改成扫帚图标',
      /title: '清理辅助文件（\.aux \/ \.log \/ \.toc …）'/.test(src)],
    ['工具栏窄窗不换行（换行会溢出悬浮块）',
      /pdfTools: \{[\s\S]{0,520}?flexWrap: 'nowrap'/.test(src) &&
        /pdfTools: \{[\s\S]{0,560}?overflowX: 'auto'/.test(src)],
    ['图标按钮统一 24×24', /pdfToolBtn: \{[\s\S]{0,200}?width: 24, height: 24/.test(src)],
    // ---- PDF 反色预览（用户 m04844，夜间看白底论文）----
    ['PDF 工具栏有「反色」按钮（半黑半白圆图标，接 pdfInvert）',
      /className: 'ml-pdf-invert-btn'[\s\S]{0,420}?pdfInvert: store\.pdfInvert !== true/.test(src)],
    ['反色用 invert + hue-rotate（白变黑但颜色不变负片）',
      src.includes("filter: 'invert(1) hue-rotate(180deg)'") && !/filter: 'invert\(1\)'/ .test(src.replace("invert(1) hue-rotate(180deg)",""))],
    ['反色只作用于右栏预览容器（不碰缓存的 PNG、不碰投屏）',
      /style: store\.pdfInvert === true \? Object\.assign\(\{\}, S\.pdfScroll, \{ filter:/.test(src) &&
        !/presentAudienceOrigin[\s\S]{0,2000}?invert/.test(src)],
    ['反色是这台机器的偏好（存 localStorage，不进会话分片）',
      /pdfInvert: state\.pdfInvert === true,/.test(src) &&
        /pdfInvert: saved\.pdfInvert === true,/.test(src) &&
        bundle.__SESSION_FIELDS.indexOf('pdfInvert') < 0],
    ['反色默认关（不影响现有观感）', /pdfInvert: false,/.test(src)],
    ['没有 PDF 时缩放/适应/页数都置灰',
      src.includes('S.pdfToolBtn, !tab ? S.pdfToolBtnOff : null') &&
        src.includes('(!store.pdfRel || !store.pdfPages) ? S.pdfToolBtnOff : null')],
    // 页数按钮不只会显示，还能跳页：输入框回车 → pdfFocusPage（PdfPane 已有滚到该页的 effect）
    ['点页数按钮展开跳页输入框（回车跳、Esc 关）',
      src.includes('pdfJumpOpen: !store.pdfJumpOpen') && src.includes('pdfFocusPage: target, pdfViewPage: target, pdfJumpOpen: false')],
    ['越界页码会被夹到 1..N', /var target = clamp\(wanted, 1, store\.pdfPages\)/.test(src)],
    // 「第 x / N 页」的 x 来自滚动位置：探测线取可视区顶部 1/3，比面积法稳
    ['当前页跟随滚动更新（顶部 1/3 探测线 + rAF 节流）',
      src.includes('var probe = host.top + host.height / 3') && src.includes("element.addEventListener('scroll', onScroll, { passive: true })")],
    ['滚到的页与状态一致才 patch（避免滚动时每帧重渲染）',
      src.includes('if (found && found !== state.pdfViewPage) patch({ pdfViewPage: found })')],
    ['换 PDF 时阅读位置回到第 1 页', src.includes('pdfViewPage: 1,\n          pdfJumpOpen: false,')],
    ['阅读位置跟项目走（进会话隔离清单），跳页输入框不跟', bundle.__SESSION_FIELDS.includes('pdfViewPage') && !bundle.__SESSION_FIELDS.includes('pdfJumpOpen')],
    ['切会话时收起跳页输入框（瞬时状态不跨项目残留）',
      src.includes('next.pdfJumpOpen = false') && src.includes("next.pdfJumpText = ''")],
    // 用户 2026-11-14 要求：PDF 区顶栏最右边的「新标签」链接去掉
    ['PDF 顶栏不再有「新标签」链接', !html.includes('>新标签<') && !html.includes('把整份 PDF 在新标签打开')],
    ['定位环渲染在页面上', html.includes('border-radius:50%')],
    ['定位环按页面尺寸换算百分比', percent(100, 595.276) === '16.799%' && percent(200, 841.89) === '23.756%'],
    ['页面可点击定位（crosshair 光标）', html.includes('crosshair')],
    ['编译方式常量是四档', bundle.__COMPILE_MODES.map((x) => x[0]).join() === 'full,once,quick,clean']
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
    ['顶栏有「新建」图标按钮（文件大纲旁边）',
      outlineHtml.includes('ml-new-btn') && outlineHtml.indexOf('ml-outline-btn') < outlineHtml.indexOf('ml-new-btn')],
    ['顶栏有「自编」图标按钮（自动编译开关，在新建右边）',
      outlineHtml.includes('ml-autocompile-btn') && outlineHtml.indexOf('ml-new-btn') < outlineHtml.indexOf('ml-autocompile-btn')],
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

  // 大模型改了磁盘 → 先登记「待同步」，mtime 稳定一次之后才真的读进来
  disk.text = 'new content from the LLM'
  mtime = 2
  await sync()
  ok('外部改动先登记（不立刻读，防止读到写一半的中间态）',
    store.tabs[0].text === 'old' && bundle.__stampOf('main.tex') === '1')
  await sync()
  ok('磁盘变了 → 编辑区自动同步', store.tabs[0].text === 'new content from the LLM')
  ok('状态栏给出同步提示', String(store.notice).includes('已同步') && store.noticeOk === true)
  ok('同步后版本戳跟着更新', bundle.__stampOf('main.tex') === '2')
  // 用户 2026-11-16 报的「大模型改了行、浅绿又没了」：生产端必须真的把改动行排进队列，
  // 否则编辑器那边的 takeFlash 永远拿到 null（只测纯函数与涂色会漏掉这一环）。
  const queued = bundle.__takeFlash('w-1')
  ok('外部改动行会排进标绿队列',
    Boolean(queued) && queued.tabId === 'w-1' && queued.ranges.length > 0
    && queued.ranges[0].from === 1 && queued.ranges[0].to === 1)

  // 没变化的轮询不该重复动编辑区
  await sync()
  await sync()
  ok('没变化就不动', store.tabs[0].text === 'new content from the LLM')

  // 标签有未保存改动 → 只提醒，绝不覆盖
  store.tabs[0].dirty = true
  disk.text = 'LLM wrote again'
  mtime = 3
  await sync()
  await sync()
  ok('脏标签不被外部改动覆盖', store.tabs[0].text === 'new content from the LLM')
  ok('脏标签给出红色提醒', String(store.notice).includes('未保存') && store.noticeOk === false)

  // PDF 被（大模型）重新编译 → 自动换图
  pdfMtime = 102
  await sync()
  ok('PDF 重新编译后自动换图', store.pdfRev === '102' && calls.includes('pdf'))

  // ---- 回归：自己刚保存完，大模型紧接着写同一份文件（用户 2026-11-27 报的那条）----
  // 老代码在 isSelfWrite 宽限期里直接把磁盘新 mtime 盖章吞掉 → 大模型那次改动永远进不来，
  // 表现就是「大模型改完编辑区不刷新、浅绿也没了」。
  {
    Object.assign(store, { notice: '', noticeOk: true })
    store.tabs[0].dirty = false
    store.tabs[0].text = 'new content from the LLM'
    bundle.__stampOf('main.tex')  // 确保已盖戳
    disk.text = 'saved by me'
    mtime = 10
    await sync()                  // 第一次：登记
    await sync()                  // 第二次：读进来
    ok('先把自己的保存同步进来', store.tabs[0].text === 'saved by me')
    // 现在模拟「刚刚自己写过盘」，同时大模型又写了
    bundle.__markSelfWrite('main.tex', Date.now())
    disk.text = 'LLM edits right after my save'
    mtime = 11
    await sync()
    await sync()
    ok('自写宽限期内的大模型改动也会被读进来（不被盖章吞掉）',
      store.tabs[0].text === 'LLM edits right after my save')
    ok('自写宽限期内的外部改动照样标绿',
      Boolean(bundle.__takeFlash('w-1')) || String(store.notice).includes('已同步'))
    ok('自写宽限期长于轮询间隔（2 秒）', bundle.__SELF_WRITE_GRACE_MS > 2000)
  }

  // ---- 回归：脏标记卡住会让编辑区永久不刷新（合并写回的 setDoc/onChange 竞态）----
  {
    Object.assign(store, { notice: '', noticeOk: true })
    store.tabs[0].dirty = true          // 假脏：内容其实等于基准
    disk.text = 'a brand new paragraph'
    mtime = 20
    await sync()
    await sync()
    ok('内容等于基准的「假脏」标签不会挡住同步',
      store.tabs[0].text === 'a brand new paragraph' && store.tabs[0].dirty === false)
    ok('假脏自检后仍然照常标绿', Boolean(bundle.__takeFlash('w-1')))
  }

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
    ['null/undefined 不炸', Array.isArray(diff(null, undefined)) && diff(null, null).length === 0],
    // 用户 2026-11-14 报的「一改就整篇刷绿」：磁盘是 CRLF、大模型回写成 LF（或反之），
    // 逐行比会认为**每一行都变了**。归一化换行之后只认真正的改动行。
    ['CRLF ↔ LF 只是换行不同 → 不标', fmt(diff('a\r\nb\r\nc', 'a\nb\nc')) === '[]'],
    ['CRLF 旧 + LF 新、只改第 2 行 → 只标第 2 行', fmt(diff('a\r\nb\r\nc', 'a\nB\nc')) === '[{"from":2,"to":2}]'],
    ['CRLF 旧 + LF 新、末尾追加 → 只标新增行', fmt(diff('a\r\nb', 'a\nb\nc')) === '[{"from":3,"to":3}]']
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
  ok('CM 路径：换标签清绿底', src.includes('if (flashState.owner === view) clearFlash()'))
  ok('CM 路径改走内核 line 装饰（不再写行内联背景）',
    src.includes('startFlashLines(flash.tabId, flash.ranges, view, kernel)') &&
    src.includes('startFlashLines(\'goto\', [{ from: store.flashLine, to: store.flashLine }], view, kernel)'))
  // 关键回归：CM 每次渲染都用 cssText 重写行元素 style，行内联背景活不过一帧
  // （2026-11-16 headless 实测），所以 startFlashLines 里绝不能出现 style.backgroundColor。
  const startFlashLinesBody = (/function startFlashLines\(tabId, ranges, view, kernel\) \{[\s\S]*?\n    \}/.exec(src) || [''])[0]
  ok('startFlashLines 不碰行元素内联样式', startFlashLinesBody.length > 0 && !startFlashLinesBody.includes('style.backgroundColor'))
  ok('回退（textarea）路径同样标绿', src.includes('startFlash(flash.tabId, flash.ranges, container, container'))
  ok('接线：diff 入口先归一化换行（CRLF/LF 混用不会整篇刷绿）',
    /function diffLineRanges\(oldText, newText\) \{[\s\S]{0,200}normalizeEol\(oldText\)[\s\S]{0,120}normalizeEol\(newText\)/.test(src))
  ok('收摊时把内核装饰也撤掉', /var kernelView = flashState.kernelView[\s\S]{0,600}kernel\.setFlashLines\(kernelView, \[\]\)/.test(src))
  const kernelSrc = readFileSync(new URL('../lib/vendor/entry.js', import.meta.url), 'utf8')
  ok('内核提供 cm-flash-line 主题 + flashLineField + setFlashLines 导出',
    kernelSrc.includes("'.cm-flash-line': {") && kernelSrc.includes('const flashLineField = StateField.define(') &&
    kernelSrc.includes('function setFlashLines(view, lines)') && /window\.__molingCM = \{[\s\S]{0,600}setFlashLines/.test(kernelSrc))
} catch (error) {
  bad('标绿测试抛错', String(error.message))
}

console.log('23) 同步不被标绿拖垮 + 绿底涂/摘（假 DOM）')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  // 回归：外部 setDoc 会走内核 onChange，不挡住就会把标签标脏 → 之后每次外部改动
  // 都被 reloadTab 的「有未保存改动」拦住（症状就是"同步突然不工作了"）
  // 注意比对必须抹平换行：磁盘 CRLF、CodeMirror 内部永远 LF，直接 === 会比不中
  ok('onChange 认得「刚同步下去的文本」，不标脏',
    /if \(suppressDirtyText !== null && normalizeEol\(text\) === normalizeEol\(suppressDirtyText\)\)/.test(src)
    && /setTab\(tab\.id, \{ text: text, dirty: true \}\)/.test(src))
  ok('setDoc 前先记下预期文本', src.includes('suppressDirtyText = tab.text'))
  // 这一行还顺带清 dirty（假脏自检），所以按前缀找
  const reloadAt = src.indexOf('setTab(tab.id, { text: data.text, loading: false')
  const flashAt = src.indexOf('try { queueFlash(tab.id, live.text, data.text) }')
  // 用户 2026-11-16 报的「绿标又没了」：排队必须**先于** setTab。
  // 反过来的话 setTab 触发的重渲染会抢先把 effect 跑掉，takeFlash 拿到空值。
  ok('标绿先排队、再落地同步（顺序不能反）',
    reloadAt > 0 && flashAt > 0 && flashAt < reloadAt
    && src.includes('try { queueFlash(tab.id, live.text, data.text) } catch (error) { delete pendingFlash[tab.id] }'))

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

  // 编译错误跨文件跳转：日志里的 file 五花八门，先归一成项目内相对路径
  const logFiles = [
    { rel: 'main.tex' },
    { rel: 'chapters/intro.tex' },
    { rel: 'chapters/method.tex' },
    { rel: 'refs.bib' }
  ]
  const toRel = bundle.__logFileToRel
  ok('日志路径：./ 前缀 → 相对路径', toRel('./chapters/intro.tex', 'C:\\proj', logFiles) === 'chapters/intro.tex')
  ok('日志路径：项目内绝对路径 → 相对路径',
    toRel('C:\\proj\\chapters\\method.tex', 'C:\\proj', logFiles) === 'chapters/method.tex')
  ok('日志路径：反斜杠相对路径也能认', toRel('chapters\\intro.tex', 'C:\\proj', logFiles) === 'chapters/intro.tex')
  ok('日志路径：只给文件名、清单里唯一 → 认它', toRel('refs.bib', 'C:\\proj', logFiles) === 'refs.bib')
  ok('日志路径：项目外的绝对路径 → null（不硬塞进项目）',
    toRel('C:\\texlive\\2024\\texmf-dist\\tex\\latex\\base\\latex.ltx', 'C:\\proj', logFiles) === null)
  ok('日志路径：同名文件不止一个 → null（不猜）',
    toRel('intro.tex', 'C:\\proj', [{ rel: 'a/intro.tex' }, { rel: 'b/intro.tex' }]) === null)
  ok('日志路径：空值 → null', toRel('', 'C:\\proj', logFiles) === null && toRel(null, 'C:\\proj', logFiles) === null)
  ok('LogPane 把 issue.file 一起交给 onJump（否则子文件错误会跳到当前文件）',
    /props\.onJump\(issue\.line, issue\.file\)/.test(src))
  ok('jumpTo 跨文件：先 openTab 再跳（等编辑器挂上）',
    /openTab\(state\.root, rel\)\.then\(function \(\) \{[\s\S]{0,120}?editorBridge\.jumpTo\(line\)/.test(src))
  // 多趟编译的结果只取最后一趟，日志头要写清「几趟」并给错误/警告计数
  //（用户 2026-11-16 报：完整编译中间趟的页面被当成最终结果，容易误解）
  ok('日志头标注「结果取最后一趟」（趟数 > 1 时）', /passes > 1 \? '（结果取最后一趟）'/.test(src))
  ok('日志头给出错误/警告条数', /条错误 · ' \+ \(log\.warnings \|\| \[\]\)\.length \+ ' 条警告/.test(src))
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
    ['静默窗口 1.8 秒 + 两次编译至少隔 3 秒（打字不会中途开编）',
      src.includes('var AUTO_COMPILE_QUIET_MS = 1800')
      && src.includes('var AUTO_COMPILE_MIN_GAP_MS = 3000')
      && src.includes('var wait = Math.max(AUTO_COMPILE_QUIET_MS, gap)')],
    ['单飞：编译中只记「待编」标记，不排队叠加',
      src.includes('if (compiling) { autoCompilePending = true; return }')
      && src.includes('if (autoCompilePending) scheduleAutoCompile()')],
    ['编译中、标签仍脏都不开编（等静默窗口）',
      src.includes('if (compiling || state.busy) { autoCompilePending = true; return }')
      && src.includes('if (tab && tab.dirty) { autoCompilePending = true; return }')],
    ['关着的时候不排期', src.includes('if (state.autoCompile !== true) return')],
    ['保存成功后触发', /scheduleAutoCompile\(\)\s*\/\/ 「自编」开着就顺手编一次/.test(src)],
    ['外部改动同步后触发', /scheduleAutoCompile\(\)\s*\/\/ 「自编」开着：大模型改完就自动编一次/.test(src)],
    ['换项目 / 手动关闭时清掉待触发的定时器',
      src.includes('if (autoCompileTimer) { clearTimeout(autoCompileTimer); autoCompileTimer = null }')],
    ['按钮在「换行｜保存｜新建」同组内（橙色分组）', (function () {
      const group = src.indexOf("S.btnGroupAmber")
      const spacer = src.indexOf('S.spacer', group)
      const newBtn = src.indexOf('ml-new-btn', group)
      const autoBtn = src.indexOf('ml-autocompile-btn', group)
      return group > -1 && newBtn > group && autoBtn > newBtn && (spacer === -1 || autoBtn < spacer)
    })()]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
  ok('store 默认 autoCompile = false', bundle.__store.autoCompile === false)

  // 开关按钮：开/关两态都显式写 border（别混用 border 简写 + borderColor 长写）
  // 文件树 / 文件大纲 / 换行 / 自编 / 查找面板的 Aa、.* / 全项目搜索的 Aa、.*
  // 一共 8 个，全部走同一个 helper
  // （放大镜按钮不在顶栏、也不是「开/关」两态开关，它自己写全 searchFabOn/Off）
  // 现在多了顶栏那个「投屏」按钮（它也是开/关两态：放映中 / 投屏），所以是 9 个
  ok('开关按钮用 toggleBtnStyle 统一两态（文件树/文件大纲/换行/自编/投屏 + Aa、.* 各两组 9 个）',
    (src.match(/toggleBtnStyle\(store\./g) || []).length === 9
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
    ['启动页不再有空白 ctexart 骨架卡片（只在模板弹窗里）', !welcomeHtml.includes('新建中文文档') && !welcomeHtml.includes('ctexart 骨架')]
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
    // 别写死具体数字：每次重建内核都要加一，写死就会「重建一次红一次」。
    // 只要求它是数字且不低于 5（行内上色那版）。
    ['KERNEL_VERSION 是数字且已加过（打掉浏览器旧缓存）',
      Number((/var KERNEL_VERSION = '(\d+)'/.exec(src) || [])[1]) >= 5],
    // 用户 2026-11-14 要求「显示行号的面板窄一点」：行号列从 34px 收到 22px。
    // 这条同时盯住 entry.js（源码）与 cm6.js（产物），少重建一次就会漏。
    ['行号列收窄到 22px（源码 + 产物都改了）',
      entrySrc.includes("minWidth: '22px'") && kernelSrc.includes('minWidth:"22px"') && !kernelSrc.includes('minWidth:"34px"')],
    // 用户 2026-11-14 要求「tex/pdf 之间的分割线太粗」：那条"粗线"其实是
    // Chromium 默认 15px 滚动条。内核侧把 .cm-scroller 改成 8px 细圆角条，
    // 同样要源码 + 产物都改（少重建一次就会漏）。
    ['编辑器滚动条改细（.cm-scroller 8px 圆角，源码 + 产物都改了）',
      entrySrc.includes("'.cm-scroller::-webkit-scrollbar'") && entrySrc.includes("width: '8px'") &&
      kernelSrc.includes('::-webkit-scrollbar') && kernelSrc.includes('"8px"') &&
      !/\.cm-scroller::-webkit-scrollbar\{[^}]*width:1[0-9]px/.test(kernelSrc)],
    // 面板侧：pdf 预览、文件树、日志等滚动容器也要细条，作用域限定在 [data-moling="1"] 下
    ['面板滚动条改细（WORKBENCH_CSS 挂在根节点，作用域限定 data-moling）',
      src.includes('var WORKBENCH_CSS = [') &&
      src.includes('[data-moling="1"] ::-webkit-scrollbar{width:8px;height:8px}') &&
      /data-moling': '1' \},\s*\n\s*\/\/ 细滚动条[\s\S]{0,120}h\('style', null, WORKBENCH_CSS\)/.test(src)],
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
    // 用户 2026-11-14 报的 bug：$\%$ 之后整段变灰斜体（% 被当注释起点）。
    // 词法里「数学分支」必须排在「注释判断」前面，且数学里的 \. 要按 escape 吃掉。
    // 这条盯住 entry.js 源码与 cm6.js 产物两边，少重建一次就漏。
    ['内核词法先判数学再判注释（$\\%$ 不会被当注释）',
      /if \(state\.inMath\) \{[\s\S]{0,600}?if \(stream\.match\(\/\^\\\\\.\/\)\) return 'escape'/.test(entrySrc)
      && entrySrc.indexOf('if (state.inMath) {') < entrySrc.indexOf("if (stream.match(/^%/)) {\n      state.inComment = true")],
    ['内核产物里数学分支排在注释分支前面（重建后生效）',
      kernelSrc.includes('e.inMath?n.match(/^\\$\\$/)') && !/if\(n\.match\(\/\^%\/\)\)\{?[^]{0,80}inComment=!0/.test(kernelSrc.slice(0, kernelSrc.indexOf('e.inMath?')))],
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

  // 1) 默认折叠（用户 2026-11-19 要求）：expanded 里没记过 → 目录都折着，
  //    只看到顶层 4 行：figures / deep / main.tex / 短.tex
  const all = autoSize({ tree: tree, expanded: {}, files: files, filter: '' })
  all.rows === 4 ? ok('默认折叠后只显示顶层（4 行）', String(all.rows)) : bad('默认折叠行数不对', JSON.stringify(all))
  all.height === 27 + 10 + 4 * 21
    ? ok('高度 = 表头 + 内边距 + 行数 × 行高（不撑满编辑区）', String(all.height))
    : bad('高度算错', JSON.stringify(all))

  // 2) 显式展开才展开：figures + deep 都展开 → 7 行（figures/cat.pdf + deep/inner）
  const expandedAll = autoSize({ tree: tree, expanded: { figures: true, deep: true, 'deep/inner': true }, files: files, filter: '' })
  expandedAll.rows === 7
    ? ok('显式展开后行数跟着涨（7 行）', String(expandedAll.rows))
    : bad('展开后行数不对', JSON.stringify(expandedAll))

  // 3) 只展开 deep（inner 仍折）→ 5 行，验证逐层控制
  const folded = autoSize({ tree: tree, expanded: { deep: true }, files: files, filter: '' })
  folded.rows === 5 && folded.height === 27 + 10 + 5 * 21
    ? ok('展开一层后高度跟着变（不是固定高度）', String(folded.rows))
    : bad('展开一层行数/高度不对', JSON.stringify(folded))

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
    ['高度按左栏实际可用高度夹一次（窗口矮时不溢出）', drawerSrc.includes('leftRoom')],
    // 用户 2026-11-19：点开文件树时每个文件夹都全展开，太乱 → 改成默认折叠。
    // 口径统一成「expanded[rel] === true 才展开」，三处（算高度 / 画分支 / 点切换）必须一致。
    ['默认折叠：算高度只认显式 true', src.includes("expanded[node.rel] === true && node.children")],
    ['默认折叠：画分支只认显式 true', src.includes('var open = props.expanded[node.rel] === true')],
    ['点目录是「切到显式展开」而不是「切到显式折叠」', src.includes('expanded[path] = expanded[path] !== true')],
    // ---- 用户 2026-11-19：投屏按钮挪顶栏 + PDF 工具栏悬浮化 + PDF 多开 ----
    ['投屏按钮进顶栏独立新组（不并进橙底的 edit 组）',
      (() => {
        const from = src.indexOf("'data-btn-group': 'present'")
        const edit = src.indexOf("'data-btn-group': 'edit'")
        const present = from
        // present 组必须在 edit 组结束之后（不在橙组内部），且在 spacer 之前
        const editEnd = src.indexOf("}, '自编'))", edit)
        return present > editEnd && present > 0 && src.indexOf('ml-present-fab') > present
      })()],
    ['投屏按钮全项目只有一个入口（不再有 PDF 顶栏那一份）',
      (src.match(/onClick: function \(\) \{ openPresent\(\) \}/g) || []).length === 1],
    ['右栏顶部换成和 tex 一样的标签条（PDF 多开）',
      src.includes("style: S.tabsBar, className: 'ml-pdf-tabs'") && src.includes('state.pdfTabs.map')],
    // 用户 2026-11-19 反馈：悬浮工具栏压在 PDF 标签条上、且和 tex 的 fabBar 不在同一高度。
    // 右栏顶部改成标签条（28px 正常流）后，工具栏必须 top = 28 + 5 = 33 才落在标签条下方，
    // 正好与 tex 编辑区里 fabBar 的「标签条下方 5px」齐平。
    ['PDF 工具栏悬浮块落在 PDF 标签条下方（top = 标签条高 28 + 5）',
      /pdfTools: \{[\s\S]{0,400}?position: 'absolute', top: 33, right: 14/.test(src)],
    // ---- 文件树右键菜单（用户 2026-11-19：要能新建 / 复制 / 删除 / 粘贴…）----
    ['TreeBranch 两种行都挂 onContextMenu（文件行与目录行）',
      (() => {
        const from = src.indexOf('function TreeBranch(props)')
        const seg = src.slice(from, from + 2600)
        return from > 0 && (seg.match(/onContextMenu: onContext/g) || []).length === 2
      })()],
    ['抽屉空白处右键也能弹菜单（rel 为空串 = 项目根目录）',
      /onContextMenu: function \(event\) \{[\s\S]{0,200}?openTreeMenu\(null, event\)/.test(src)],
    ['菜单条目齐全（新建文件/新建文件夹/重命名/复制/粘贴/删除）',
      ['新建文件…', '新建文件夹…', '重命名…', '复制', '粘贴', '删除…'].every(function (label) {
        return src.indexOf(label) >= 0
      })],
    ['用自绘输入框而不是 window.prompt（Electron 里 prompt 直接抛）',
      !/window\.prompt\(/.test(src) && !/window\.confirm\(/.test(src) && src.includes('submitTreePrompt')],
    ['删除是自绘二次确认（带电光提示：只删单文件或空目录）',
      /confirmTreeDelete/.test(src) && src.includes('只删单个文件或空目录')],
    ['粘贴位置按右键目标的目录算（对着目录就粘进目录里）',
      /var base = menu && menu\.kind === 'dir' \? menu\.rel \+ '\/' : dirOf/.test(src)],
    ['每个动作做完都刷文件树（否则界面上看不到变化）',
      src.includes('var afterTreeOp = function') && src.indexOf('loadTree(store.root)', src.indexOf('var afterTreeOp')) > 0],
    ['五个端点都接上了',
      ['new-file', 'new-dir', 'rename-path', 'copy-path', 'remove-path'].every(function (name) {
        return src.indexOf("'" + name + "'") >= 0
      })],
    // ---- PDF 目录（书签）按钮与浮层（用户 2026-11-19）----
    ['PDF 工具栏有「目录」按钮（接 openPdfOutline）',
      /className: 'ml-pdf-outline-btn'[\s\S]{0,400}?onClick: function \(\) \{ openPdfOutline\(\) \}/.test(src)],
    ['目录浮层贴在 PDF 区右上角（absolute 定位，压在悬浮工具栏下面）',
      /pdfOutlinePanel: \{[\s\S]{0,200}?position: 'absolute', top: 72, right: 14/.test(src)],
    ['点目录条目跳页（写 pdfFocusPage 与 pdfViewPage）',
      /function gotoPdfOutlinePage|var gotoPdfOutlinePage = function[\s\S]{0,260}?pdfFocusPage: target, pdfViewPage: target/.test(src)],
    ['没有 .out 时说清楚（空态提示，不装作有目录）',
      /pdfOutlineNotice: entries\.length \? '' : '这份 PDF 没有目录/.test(src)],
    ['目录状态字段齐全（open / busy / 条目 / 提示）',
      ['pdfOutlineOpen', 'pdfOutlineBusy', 'pdfOutline:', 'pdfOutlineNotice'].every(function (key) {
        return src.indexOf(key) > 0
      })],
    // ---- 用户 2026-11-19：顶部菜单栏文字按钮改图标 ----
    ['顶栏图标按钮齐全（文件树/大纲/换行/新建/自编）',
      ['ml-tree-btn', 'ml-outline-btn', 'ml-wrap-btn', 'ml-new-btn', 'ml-autocompile-btn'].every(function (name) {
        return src.indexOf("className: '" + name + "'") > 0
      })],
    ['图标统一走 toolbarIcon（内联 SVG，stroke 取 currentColor 跟主题）',
      /function toolbarIcon\(paths, size\)/.test(src) && /stroke: 'currentColor'/.test(src) &&
        (src.match(/toolbarIcon\(\[/g) || []).length >= 5],
    // 用户 m04680：投屏改成显示器/电视机图标
    ['投屏按钮用显示器图标（不再有裸文字「投屏」/「放映中」）',
      /className: 'ml-present-fab'[\s\S]{0,400}?toolbarIcon\(\[/.test(src) &&
        !/store\.presentOn \? '放映中' : '投屏'/.test(src)],
    ['能换的都换了：顶栏那几处不再有裸文字按钮（大纲浮层标题不算）', (function () {
      // 只看顶栏那一段（从 S.bar 到左右两栏 S.body）
      const from = src.indexOf("h('div', { style: S.bar }")
      const to = src.indexOf("h('div', { style: S.body", from)
      if (from < 0 || to <= from) return false
      const bar = src.slice(from, to)
      return ['文件树', '文件大纲', '换行', '新建', '自编'].every(function (label) {
        return bar.indexOf("}, '" + label + "')") < 0
      })
    })()],
    ['图标按钮用 S.btnIcon（20×18，与组内文字按钮同高 18）',
      /btnIcon: \{[\s\S]{0,260}?width: 20, height: 18/.test(src)],
    ['留着文字的只剩「首页」和保存分体按钮（它们带状态/不可替代）',
      /\}, toolbarIcon\([\s\S]{0,300}?'首页'\)/.test(src) && src.indexOf("'手动保存'") > 0],
    // ---- 编译取消 + 实时进度（用户 m04990「编译体验」）----
    ['编译中按钮变成可点的「取消」（不再是死灰）',
      /store\.busy === 'compile' \? \{ border: '1px solid ' \+ C\.err/.test(src) &&
        /disabled: !tab,/.test(src) &&
        /store\.busy === 'compile' \? \('取消'/.test(src)],
    ['编译进度按 400ms 轮询 compile-status',
      /COMPILE_POLL_MS = 400/.test(src) && /api\('compile-status'/.test(src)],
    ['取消走 AbortController（宿主 killProcessTree）',
      /function cancelCompile\(\)/.test(src) && /job\.controller\.abort\(\)/.test(src)],
    ['取消后报「已取消」而不是「编译失败」',
      /aborted \) \{\s*\n\s*patch\(\{ busy: '', error: '', notice: '已取消编译'/.test(src) ||
        /notice: '已取消编译'/.test(src)],
    ['api() 支持传 AbortSignal（只有显式给才带）',
      /function api\(endpoint, payload, options\)/.test(src) && /if \(options && options\.signal\) opts\.signal/.test(src)],
    ['进度文案纯函数（秒数·步骤，过长截断）',
      (() => {
        const fn = bundle.__compileProgressText
        if (typeof fn !== 'function') return false
        const a = fn({ compileProgress: { elapsedMs: 3200, step: '运行 xelatex：C:\\tex\\xelatex -interaction' } })
        const b = fn({ compileProgress: { elapsedMs: 65000, step: '完成' } })
        const c = fn({ compileProgress: null })
        return a === '3.2s · 运行 xelatex' && b === '1m05s · 完成' && c === ''
      })()],
    ['取消导出可被自测驱动', typeof bundle.__cancelCompile === 'function'],
    // ---- tex 预览区右上角的悬浮块里要有换行开关（用户 2026-11-27 要求加回来）----
    ['tex 悬浮块里有换行按钮（ml-wrap-fab，与顶栏共用同一个 store.wrap）',
      /className: 'ml-wrap-fab'/.test(src) &&
        /className: 'ml-wrap-fab'[\s\S]{0,420}?patch\(\{ wrap: !store\.wrap \}\); persist\(\)/.test(src)],
    ['换行按钮在注释之后、md 切换之前（位置紧挨注释钮）',
      (() => {
        const bar = src.indexOf("className: 'ml-fab-bar'")
        if (bar < 0) return false
        // 窗口给足：中间隔着两个 SVG（path 字符串很长），3200 会截断到 search 之前
        const seg = src.slice(bar, bar + 8000)
        const c = seg.indexOf("className: 'ml-comment-fab'")
        const w = seg.indexOf("className: 'ml-wrap-fab'")
        const m = seg.indexOf("className: 'ml-md-toggle'")
        const s = seg.indexOf("className: 'ml-search-fab'")
        return c >= 0 && w > c && (m < 0 || w < m) && w < s
      })()],
    ['换行按钮两态都用 fabBar 现成的开/关样式（不自造第三套颜色）',
      // style 写在 className 之前，所以从 style 往后找 className
      /store\.wrap \? S\.commentFabOn : S\.commentFabOff\)[\s\S]{0,80}?className: 'ml-wrap-fab'/.test(src)],
    ['换行按钮有可读的两态提示（悬停能看到开/关）',
      /软换行：开（点一下关掉/.test(src) && /软换行：关（点一下打开）/.test(src)],
    ['tex 的 fabBar 与 PDF 工具栏同一水平线（都是距标签条底边 5px）',
      /fabBar: \{[\s\S]{0,160}?top: 5, right: 14/.test(src)],
    ['右栏是定位上下文（否则悬浮工具栏跑掉）',
      /right: \{[\s\S]{0,220}position: 'relative'/.test(src)],
    ['PDF 标签能开/切/关，且镜像随切标签更换',
      ['openPdfTab', 'activatePdfTab', 'closePdfTab', 'savePdfTab', 'pdfSnapshot'].every(function (name) {
        return typeof bundle['__' + name] === 'function'
      })],
    ['pdfTabs / activePdfId 进会话隔离（各会话各看各的 PDF）',
      bundle.__SESSION_FIELDS.indexOf('pdfTabs') >= 0 && bundle.__SESSION_FIELDS.indexOf('activePdfId') >= 0]
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
    // 切会话要把上一个会话的瞬态痕迹清掉：待涂标绿、保存冲突标记
  //（saveConflict 描述的是「刚刚那一刻磁盘的状态」，带到新会话上就是假提示）
  ['切会话后作废上一个会话的待涂标绿', /pendingFlash = \{\}[\s\S]{0,220}?return true/.test(src)],
  ['切会话后清掉保存冲突标记', /if \(state\.saveConflict === true\) patch\(\{ saveConflict: false \}\)/.test(src)],
    ['进项目闸门在切会话时复位（否则轮询永久暂停）', src.includes('enteringRoot = false   // 卡在「进项目」中间被切走')],
    ['设置类字段不在隔离清单里（编译方式/引擎/分栏宽等）',
      !bundle.__SESSION_FIELDS.includes('engine') && !bundle.__SESSION_FIELDS.includes('treeW') && !bundle.__SESSION_FIELDS.includes('mode')],
    ['项目字段在隔离清单里（view/root/tabs/pdfRel）',
      ['view', 'root', 'tabs', 'pdfRel', 'files', 'tree'].every((key) => bundle.__SESSION_FIELDS.includes(key))],
    // 异步回包的护栏：切了会话/切了项目之后，旧请求的结果不许往新会话里灌
    ['loadTree 回包前核对项目没变', /normalizePath\(target\) !== normalizePath\(state\.root\)[\s\S]{0,80}return undefined/.test(src)],
    ['openTab 读盘回包前核对标签还在（切会话就丢弃）', /read-file[\s\S]{0,120}if \(!findTabById\(id\)\) return undefined/.test(src)],
    ['saveTab 写盘回包前核对标签还在', /write-file[\s\S]{0,260}if \(!findTabById\(id\)\) return undefined/.test(src)],
    // ---- 写入原子化 / 并发冲突（桌面版墨灵TeX 30 秒自动保存会跟插件抢同一份 .tex）----
    ['保存时带上磁盘既有 mtime（乐观并发检查用）',
      /var baseMtime = Number\(stamps\[tab\.rel\] \|\| 0\)/.test(src) &&
        /payload\.baseMtime = baseMtime/.test(src)],
    ['冲突时不直接覆盖：先自动合并，合不了才提示（标签保持脏）',
      /code === 'conflict' && !force\)[\s\S]{0,600}?autoMergeOnConflict\(/.test(src) &&
        /saveConflict: true/.test(src) &&
        /再点一次「保存」= 用当前编辑器的内容覆盖磁盘版本/.test(src)],
    ['再点一次保存就带 force 覆盖（不用用户另找开关）',
      /var force = Boolean\(\(options && options\.force\) \|\| state\.saveConflict\)/.test(src)],
    // 关键：外部同步的「脏标签」分支如果顺手盖 stamps，baseMtime 就永远等于磁盘值、
    // 冲突检测形同虚设 —— 用户的编辑会静默覆盖别人的改动。
    ['脏标签遇到外部修改时不盖版本戳（否则冲突检测失效）',
      (() => {
        const from = src.indexOf('if (tab.dirty) {')
        const seg = src.slice(from, from + 400)
        return from > 0 && !/stamps\[tab\.rel\] = stamp/.test(seg)
      })()],
    ['覆盖成功后清掉冲突标记', /notice: '已保存 ' \+ tab\.rel[\s\S]{0,120}saveConflict: false/.test(src)],
    ['宿主回的 code 挂到 Error 上（面板才能分辨冲突/占用）',
      /if \(json && json\.code\) failure\.code = String\(json\.code\)/.test(src)],
    ['保存钩子可被自测驱动（不然 conflicts 分支只能靠读源码）',
      typeof bundle.__saveTab === 'function' && typeof bundle.__setSaveConflict === 'function'],
    // ---- 三方合并（v1.1.3，用户 m04899）----
    ['diff3：两边改不同行 → 自动合并，两份都在', (() => {
      const base = Array.from({ length: 200 }, (_, i) => 'line ' + (i + 1)).join('\n')
      const mine = base.split('\n'); mine[105] = 'line 106 EDITED BY ME'
      const theirs = base.split('\n'); for (let i = 0; i < 100; i++) theirs[i] = 'line ' + (i + 1) + ' AGENT'
      const r = bundle.__mergeThreeWay(base, mine.join('\n'), theirs.join('\n'))
      if (!r.ok) return false
      const L = r.text.split('\n')
      return L.length === 200 && L[0] === 'line 1 AGENT' && L[105] === 'line 106 EDITED BY ME' && L[199] === 'line 200'
    })()],
    ['diff3：改同一行 → 判冲突不硬合', (() => {
      const base = 'A\nB\nC\nD'
      const r = bundle.__mergeThreeWay(base, 'A\nX\nC\nD', 'A\nY\nC\nD')
      return r.ok === false && r.reason === 'conflict' && r.conflict && r.conflict.mine.start === 2
    })()],
    ['diff3：对方没改 → 直接拿我的', (() => {
      const base = 'A\nB\nC'
      const r = bundle.__mergeThreeWay(base, 'A\nB2\nC', base)
      return r.ok === true && r.text === 'A\nB2\nC'
    })()],
    ['diff3：我没改 → 直接拿对方的', (() => {
      const base = 'A\nB\nC'
      const r = bundle.__mergeThreeWay(base, base, 'A\nB3\nC')
      return r.ok === true && r.text === 'A\nB3\nC'
    })()],
    ['diff3：超 2MB 拒绝硬合（退回人工）', (() => {
      const big = 'x'.repeat(2 * 1024 * 1024 + 10)
      const r = bundle.__mergeThreeWay('a', big, 'b')
      return r.ok === false && r.reason === 'too-large'
    })()],
    ['保存冲突先走自动合并（不是直接让用户覆盖）',
      /code === 'conflict' && !force\)[\s\S]{0,300}?autoMergeOnConflict\(/.test(src)],
    ['合并成功用 force 写回并更新基准全文',
      /force: true[\s\S]{0,400}?baseText\[rel\] = merged\.text/.test(src)],
    ['合并要防重入（同一标签不并发跑两次）',
      /var mergingTabs = \{\}/.test(src) && /if \(mergingTabs\[id\]\) return Promise\.resolve\(\)/.test(src)],
    ['基准全文三处更新（打开 / 保存成功 / 外部同步）',
      (src.match(/baseText\[[^\]]+\] = /g) || []).length >= 4],
    ['切会话与换项目都会清基准全文',
      /baseText = \{\}   \/\/ 三方合并的基准全文属于上一个会话/.test(src) &&
        (src.match(/baseText = \{\}/g) || []).length >= 2],
    // ---- markdown 渲染预览（用户 2026-11-19：md 打开直接看效果，按钮放注释旁边）----
    ['依赖声明里有 DSH 的渲染器包（平台模块表 PLATFORM_MODULES 里的那个）',
      (() => {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
        const inject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
        return inject.includes('@deepseek-ai/dsh-client-ui-primitives')
      })()],
    ['渲染器用 require 取、取不到就退回 null（不把面板搞崩）',
      /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/.test(src) &&
        /primitives\.MarkdownText \? primitives\.MarkdownText : null/.test(src)],
    ['md 预览整块替换编辑区（不是右栏第三栏）',
      /if \(isMarkdownTab\(tab\) && tab\.mdPreview\) return h\(MarkdownPreview/.test(src)],
    ['预览组件把文本喂给 DSH 的 MarkdownText',
      /h\(MarkdownText, \{ text: text \}\)/.test(src)],
    ['只有 md 才认渲染预览（tex 不受影响）',
      /\.\(md\|markdown\)\$/i.test(src) || /\(md\|markdown\)\$\/i\.test\(String\(tab\.rel/.test(src)],
    // 打开 md 默认进预览（纯字符串包含：正则里那串转义太容易写错）
    ['打开 md 默认进预览', src.includes('mdPreview: /\\.(md|markdown)$/i.test(rel)')],
    ['编辑/预览按钮排在注释按钮之后（用户指定位置）',
      (() => {
        const i = src.indexOf("className: 'ml-comment-fab'")
        const j = src.indexOf("className: 'ml-md-toggle'")
        return i > 0 && j > i
      })()],
    ['Ctrl+E 也能切（tex 里不抢键）',
      /event\.key === 'e' \|\| event\.key === 'E'\)[\s\S]{0,160}?toggleMarkdownPreview\(tab\.id\)/.test(src)],
    ['切会话不再回收另一个会话的 PDF blob（否则切回去是破图）',
      !src.slice(src.indexOf('function switchSession'), src.indexOf('function activeTab')).includes('revokeObjectURL')]
  ]
  for (const [label, passed] of wiring) passed ? ok(label) : bad(label)
} catch (error) {
  bad('会话隔离测试抛错', String(error.message))
}

console.log('32) 查找 / 替换（照搬桌面版：两行面板 + Aa/.* + 环绕 + $1 展开）')
try {
  const store = bundle.__store
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const kernelSrc = readFileSync(new URL('../lib/vendor/entry.js', import.meta.url), 'utf8')

  // 纯函数：正则构造（非正则模式必须转义，否则 `\ref{a}` 这种词会被当量词）
  const plain = bundle.__buildSearchRegex('a.b', false, false)
  const plainCase = bundle.__buildSearchRegex('a.b', false, true)
  const asRegex = bundle.__buildSearchRegex('a.b', true, false)
  const invalid = bundle.__buildSearchRegex('(', true, false)
  const empty = bundle.__buildSearchRegex('', false, false)
  const checks = [
    ['非正则模式把 . 转义成字面量', plain instanceof RegExp && plain.source === 'a\\.b'],
    ['默认忽略大小写（gi）', plain instanceof RegExp && plain.flags === 'gi'],
    ['勾了 Aa 就区分大小写（g）', plainCase instanceof RegExp && plainCase.flags === 'g'],
    ['正则模式原样编译', asRegex instanceof RegExp && asRegex.source === 'a.b'],
    ['非法正则返回 null（面板显示 0 / 0，不抛错）', invalid === null],
    ['空查询返回 null', empty === null]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)

  // 命中扫描 + 零宽保护
  const text = 'alpha ALPHA beta\n\\ref{a}\n'
  const hits = bundle.__findSearchMatches(text, bundle.__buildSearchRegex('alpha', false, false))
  hits.length === 2 && hits[0].from === 0 && hits[1].from === 6
    ? ok('全文扫描给出全部命中（含大小写不同的）', `${hits.length} 处`)
    : bad('命中扫描不对', JSON.stringify(hits))
  const zeroWidth = bundle.__findSearchMatches('abc', bundle.__buildSearchRegex('x*', true, false))
  zeroWidth.length <= 4
    ? ok('零宽正则不会死循环（lastIndex++ 兜住）', `${zeroWidth.length} 处`)
    : bad('零宽正则死循环了', String(zeroWidth.length))

  // 当前序号 / 环绕步进
  const at1 = bundle.__searchMatchIndex(hits, 2)
  const miss = bundle.__searchMatchIndex(hits, 13)
  at1 === 1 && miss === 0
    ? ok('光标在命中里就认它（1 起），不在就 0')
    : bad('当前命中判定不对', JSON.stringify({ at1, miss }))
  const forward = bundle.__stepSearchMatch(hits, 0, 1)
  const wrapForward = bundle.__stepSearchMatch(hits, 999, 1)
  const backward = bundle.__stepSearchMatch(hits, 999, -1)
  const wrapBackward = bundle.__stepSearchMatch(hits, 0, -1)
  forward === 1 && wrapForward === 0 && backward === 1 && wrapBackward === 1
    ? ok('下一个 / 上一个都环绕（到底回开头，到顶回末尾）', `${forward}/${wrapForward}/${backward}/${wrapBackward}`)
    : bad('环绕步进不对', JSON.stringify({ forward, wrapForward, backward, wrapBackward }))

  // 替换文本展开
  const grouped = bundle.__findSearchMatches('x=12', bundle.__buildSearchRegex('(\\w+)=(\\d+)', true, false))
  const expanded = bundle.__expandSearchReplace(grouped[0], '$2-$1', true)
  const literal = bundle.__expandSearchReplace(grouped[0], '$2-$1', false)
  const whole = bundle.__expandSearchReplace(grouped[0], '[$&]', true)
  expanded === '12-x' && literal === '$2-$1' && whole === '[x=12]'
    ? ok('正则替换展开 $1..$9 / $&，非正则原样', `${expanded} | ${whole}`)
    : bad('替换展开不对', JSON.stringify({ expanded, literal, whole }))
  const edits = bundle.__buildReplaceAllEdits(hits, 'X', false)
  edits.length === 2 && edits[1].from === 6 && edits[1].insert === 'X'
    ? ok('全部替换算成一批编辑（位置按原文档）', `${edits.length} 条`)
    : bad('全部替换编辑不对', JSON.stringify(edits))

  // 面板 UI：直接 SSR 出两行结构
  store.searchOpen = true
  store.searchReplaceOpen = true
  store.searchQuery = 'alpha'
  store.searchReplace = ''
  store.searchCase = false
  store.searchRegex = false
  store.searchIndex = 1
  store.searchNotice = ''
  store.tabs = [{ id: 't-s', root: 'E:/p', rel: 'main.tex', name: 'main.tex', text, dirty: false }]
  store.activeId = 't-s'
  store.view = 'workbench'
  store.pdfRel = ''
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  const panel = ReactDOMServer.renderToStaticMarkup(
    React.createElement(bundle.__SearchPanel, { store }))
  const uiChecks = [
    ['面板在工作台里渲染', html.includes('ml-search')],
    ['查找输入框（placeholder 查找）', panel.includes('placeholder="查找"') && panel.includes('ml-search-input')],
    ['替换输入框（placeholder 替换为）', panel.includes('placeholder="替换为"') && panel.includes('ml-search-replace')],
    ['区分大小写按钮 Aa', panel.includes('>Aa<')],
    ['正则按钮 .*', panel.includes('>.*<')],
    ['计数按命中数显示', panel.includes('ml-search-count') && panel.includes('1 / 2')],
    ['替换 / 全部 两个动作', panel.includes('>替换<') && panel.includes('>全部<')],
    ['关闭按钮 ×', panel.includes('>×<')]
  ]
  for (const [label, passed] of uiChecks) passed ? ok(label) : bad(label)

  // 关掉面板后不该再渲染（放大镜按钮 class 是 ml-search-fab，也算 ml-search 前缀，
  // 所以这里只认浮层自己的 class 与输入框）
  store.searchOpen = false
  const closed = ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  !closed.includes('class="ml-search"') && !closed.includes('ml-search-input')
    ? ok('关掉后浮层不再渲染（放大镜入口仍在）')
    : bad('关掉后浮层还在')

  // 接线：快捷键、桥、内核装饰层
  const wiring = [
    ['内核把 Mod-f / Mod-h 让给面板（不弹 CM 自带面板）',
      kernelSrc.includes("key: 'Mod-f'") && kernelSrc.includes("options.onSearch('find')")
      && kernelSrc.includes("key: 'Mod-h'") && kernelSrc.includes("options.onSearch('replace')")],
    ['内核自带匹配着色层（不依赖 CM 搜索面板）',
      kernelSrc.includes('setSearchMarksEffect') && kernelSrc.includes('searchMarkField')
      && kernelSrc.includes('cm-searchMatch cm-searchMatch-selected')],
    ['内核导出 selectRange / applyEdits / setSearchMarks',
      kernelSrc.includes('selectRange,') && kernelSrc.includes('applyEdits,') && kernelSrc.includes('setSearchMarks')],
    ['面板注册 onSearch（Ctrl+F 打开浮层）', src.includes('onSearch: function (mode) { openSearch(mode) }')],
    ['编辑器桥转发选中/替换/上色',
      src.includes('editorBridge.selectRange = function (from, to)')
      && src.includes('editorBridge.applyEdits = function (edits, cursor)')
      && src.includes('editorBridge.setSearchMarks = function (ranges, current)')],
    ['回退编辑器也接 Ctrl+F / Ctrl+H', src.includes("openSearch('find')") && src.includes("openSearch('replace')")],
    ['面板挂在编辑区（不是 CM 的 .cm-panels）',
      src.includes('store.searchOpen ? h(SearchPanel, { store: store }) : null') && !src.includes('openSearchPanel(')],
    ['查找状态不进会话隔离清单（属机器偏好）',
      !bundle.__SESSION_FIELDS.includes('searchQuery') && !bundle.__SESSION_FIELDS.includes('searchOpen')],
    // 用户 2026-11-15 提的两条：编辑区右上角要有放大镜入口；当前命中要看得出来
    ['顶栏不再有「查找」按钮（已挪到编辑区右上角）',
      !html.includes('>查找<') && !src.includes("}, '查找')")],
    ['编辑区右上角有放大镜按钮（searchFab + 内联 SVG 圆+柄）',
      html.includes('ml-search-fab')
      && src.includes('h(\'circle\', { cx: 7, cy: 7, r: 4.5 })')
      && src.includes("h('line', { x1: 10.5, y1: 10.5, x2: 14, y2: 14 })")],
    ['放大镜两态写全 border + color（不靠删 borderColor）',
      src.includes('searchFabOn: { border: \'1px solid \' + C.accent')
      && src.includes('searchFabOff: { border: \'1px solid transparent\'')],
    ['放大镜在浮层上方（top 6 vs 34，不叠在一起）',
      /fabBar: \{[\s\S]{0,300}?top: 5/.test(src) && /searchPanel: \{[\s\S]{0,200}?top: 34/.test(src)],
    // 用户 2026-11-15：「这俩功能底部加入悬浮矩形块，毛玻璃效果」（位置不变，只套毛玻璃块）
    ['两颗图标套在同一个毛玻璃悬浮块里（ml-fab-bar）',
      html.includes('ml-fab-bar') && html.includes('ml-comment-fab') && html.includes('ml-search-fab')],
    ['毛玻璃：backdrop-filter 模糊 + 半透明底 + 圆角 + 阴影',
      /fabBar: \{[\s\S]{0,600}?backdropFilter: 'blur\(10px\)/.test(src)
      && /fabBar: \{[\s\S]{0,600}?WebkitBackdropFilter/.test(src)
      && /fabBar: \{[\s\S]{0,600}?color-mix\(in srgb/.test(src)
      && /fabBar: \{[\s\S]{0,600}?boxShadow:/.test(src)],
    // 用户 2026-11-15：「tex顶部搜索按钮左边价格注释按钮，也是logo形式」
    ['块内注释按钮排在放大镜左边（DOM 顺序）',
      html.includes('ml-comment-fab') && html.indexOf('ml-comment-fab') < html.indexOf('ml-search-fab')],
    ['注释按钮两态写全 border + color',
      src.includes('commentFabOn: { border: \'1px solid \' + C.accent')
      && src.includes('commentFabOff: { border: \'1px solid transparent\'')],
    ['注释按钮加 % / 取消 %（全注释才反向）',
      bundle.__buildCommentEdits('a\nb\n', 1, 2).length === 2
      && bundle.__buildCommentEdits('a\nb\n', 1, 2)[0].insert === '%'
      && bundle.__buildCommentEdits('%a\n%b\n', 1, 2).length === 2
      && bundle.__buildCommentEdits('%a\n%b\n', 1, 2)[0].insert === ''
      && bundle.__buildCommentEdits('%a\nb\n', 1, 2).length === 1],
    ['注释跳过空行、保留缩进',
      bundle.__buildCommentEdits('\n  a\n', 1, 2).length === 1
      && bundle.__buildCommentEdits('\n  a\n', 1, 2)[0].from === 3],
    ['内核接 F3 / Shift-F3 / Esc（桌面版也是 F3 下一个）',
      kernelSrc.includes("key: 'F3'") && kernelSrc.includes("key: 'Shift-F3'")
      && kernelSrc.includes("key: 'Escape'") && kernelSrc.includes('options.onSearchStep')],
    ['面板注册 onSearchStep / onSearchEscape',
      src.includes('onSearchStep: function (direction) { stepToSearchMatch(direction) }')
      && src.includes('onSearchEscape: function ()')],
    ['当前命中是红底、其余琥珀（看得出停在哪一条）',
      kernelSrc.includes('rgba(239, 68, 68, 0.35)') && kernelSrc.includes('rgba(245, 158, 11, 0.35)')],
    ['选中同词高亮加深并描边（原来 0.14 太淡）',
      kernelSrc.includes('rgba(120, 170, 255, 0.30)') && /\.cm-selectionMatch[\s\S]{0,200}?outline/.test(kernelSrc)],
    ['Ctrl+H 直接把焦点给替换框', src.includes("focusSearchField(mode === 'replace' ? 'replace' : 'find')")],
    ['内核版本已加一（浏览器不会用旧缓存包）',
      bundle.__kernelAssetUrl().includes('v=' + (/var KERNEL_VERSION = '(\d+)'/.exec(src) || [])[1])]
  ]
  for (const [label, passed] of wiring) passed ? ok(label) : bad(label)

  store.tabs = []
  store.activeId = null
  store.searchOpen = false
  store.searchReplaceOpen = false
  store.searchQuery = ''
} catch (error) {
  bad('查找 / 替换测试抛错', String(error.message))
}

console.log('33) 全项目搜索 / .bib 补全 / 代码折叠（用户 2026-11-16 四项需求的后三项）')
try {
  const store = bundle.__store
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const kernelSrc = readFileSync(new URL('../lib/vendor/entry.js', import.meta.url), 'utf8')

  // 分组：按文件归拢、组内按行号升序、文件顺序跟着宿主给的顺序
  const grouped = bundle.__groupSearchMatches([
    { rel: 'b.tex', line: 9, col: 1, text: 'x', from: 0, to: 1 },
    { rel: 'a.tex', line: 4, col: 3, text: 'y', from: 0, to: 1 },
    { rel: 'b.tex', line: 2, col: 1, text: 'z', from: 0, to: 1 }
  ])
  grouped.length === 2 && grouped[0].rel === 'b.tex' && grouped[0].matches.length === 2
    ? ok('命中按文件分组（保序）', grouped.map((g) => g.rel).join(','))
    : bad('分组不对', JSON.stringify(grouped.map((g) => g.rel)))
  grouped[0].matches[0].line === 2 && grouped[0].matches[1].line === 9
    ? ok('组内按行号升序', grouped[0].matches.map((m) => m.line).join(','))
    : bad('组内顺序不对', JSON.stringify(grouped[0].matches.map((m) => m.line)))
  grouped[0].name === 'b.tex' && bundle.__groupSearchMatches(null).length === 0
    ? ok('组名取文件名、空输入给空数组')
    : bad('组名/空输入处理不对')

  // 搜索请求：打宿主 search 端点，带上 caseSensitive / regex 两个开关
  const realFetch = globalThis.fetch
  let seen = null
  globalThis.fetch = async (url, opts) => {
    const endpoint = String(url).split('/').pop()
    const body = opts && opts.body ? JSON.parse(opts.body) : {}
    if (endpoint === 'search') {
      seen = body
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { matches: [{ rel: 'a.tex', line: 3, col: 2, text: 'hit', from: 0, to: 3 }], truncated: false } }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
  }
  Object.assign(store, {
    root: 'E:\\proj-search', projSearchQuery: 'hit', projSearchCase: true,
    projSearchRegex: false, projSearchResult: null, projSearchNotice: '', projSearchBusy: ''
  })
  await bundle.__runProjectSearch()
  seen && seen.query === 'hit' && seen.caseSensitive === true && seen.regex === false && seen.root === 'E:\\proj-search'
    ? ok('全项目搜索打 search 端点并带齐参数', JSON.stringify(seen))
    : bad('search 请求参数不对', JSON.stringify(seen))
  store.projSearchResult && store.projSearchResult.matches.length === 1 && store.projSearchBusy === ''
    ? ok('搜索回包写进 store（忙闲复位）')
    : bad('搜索结果没落进 store', JSON.stringify(store.projSearchResult))

  // 空查询不该发请求（省一次全项目扫描）
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) } }
  store.projSearchQuery = ''
  await bundle.__runProjectSearch()
  calls === 0 && store.projSearchResult === null
    ? ok('空查询直接清空结果、不发请求')
    : bad('空查询仍然发了请求', 'calls=' + calls)

  // 没有项目时给出提示而不是静默
  store.root = ''
  await bundle.__runProjectSearch()
  String(store.projSearchNotice).includes('先打开一个项目文件夹')
    ? ok('没打开项目时明确提示')
    : bad('没打开项目时没提示', String(store.projSearchNotice))
  globalThis.fetch = realFetch

  // .bib 补全：项目 bib 的 key 与文档内 \bibitem 合并、同名只留一条
  Object.assign(store, {
    root: 'E:\\proj-bib',
    bibEntries: [
      { key: 'knuth1984', type: 'article', title: 'Literate Programming', author: 'Knuth', year: '1984' },
      { key: 'local1', type: 'book', title: '重复的应被 \\bibitem 压掉', author: '', year: '' }
    ]
  })
  const options = bundle.__bibOptions('\\bibitem{local1} text')
  const labels = options.map((item) => item.label)
  labels.includes('knuth1984') && labels.includes('local1') && labels.filter((k) => k === 'local1').length === 1
    ? ok('.bib 的 key 与 \\bibitem 合并、同名去重', labels.join(','))
    : bad('文献候选合并/去重不对', labels.join(','))
  const knuth = options.find((item) => item.label === 'knuth1984')
  String(knuth && knuth.detail).indexOf('Knuth') >= 0
    ? ok('.bib 候选带作者/年份当副标题', String(knuth && knuth.detail))
    : bad('.bib 候选没有副标题')
  store.bibEntries = null
  bundle.__bibOptions('\\bibitem{a}').length === 1
    ? ok('bibEntries 缺失时只列 \\bibitem（不炸）')
    : bad('bibEntries 为 null 时出错')

  // 代码折叠：\begin/\end 配对才折，单行环境 / 未闭合都不折
  // （内核是 IIFE 包，没法 import EditorState；这里读源码断言 + 验算规则）
  kernelSrc.includes('foldService.of(latexFoldService)')
    ? ok('内核挂上 latexFoldService（foldGutter 由 basicSetup 给）')
    : bad('内核没挂 foldService')
  const foldPair = /function latexFoldService\(state, lineStart\)/.test(kernelSrc)
    && kernelSrc.includes('openRe') && kernelSrc.includes('closeRe') && kernelSrc.includes('escaped')
  foldPair
    ? ok('折叠服务按 \\begin{name}/\\end{name} 同名配对')
    : bad('折叠服务实现不对')
  const foldOpen = /if \(depth <= 0\) return null/.test(kernelSrc) && kernelSrc.includes('return null')
    && kernelSrc.includes('const total = state.doc.lines')
  foldOpen
    ? ok('未闭合环境不折（宁可折不了也不吃掉后半篇）')
    : bad('未闭合处理不对')

  // 章节分割线（用户 2026-11-16「在不同章节之间，键入横线进行分割，以区分」）
  kernelSrc.includes('sectionRuleExtension()')
    ? ok('内核挂上章节分割线扩展')
    : bad('内核没挂 sectionRuleExtension')
  const ruleExt = /function sectionRuleExtension\(\)/.test(kernelSrc)
    && kernelSrc.includes('Decoration.line({ class: classes.join(\' \') })')
  ruleExt
    ? ok('分割线画在章节标题行上沿（Decoration.line，不占行内字符）')
    : bad('分割线实现不对')
  const ruleRe = /SECTION_RULE_RE = \/\^\\s\*\\\\\(\?:part\|chapter\|section\|subsection\|subsubsection\|paragraph\|subparagraph\)/.test(kernelSrc)
  ruleRe
    ? ok('分割线只认行首章节命令（注释行 / 正文不动）')
    : bad('章节命令正则不对')
  kernelSrc.includes('number > 1 && SECTION_RULE_RE.test(line.text)')
    ? ok('首行不加分割线（文档开头不需要）')
    : bad('首行没排除')
  kernelSrc.includes("'.cm-section-rule': {")
    ? ok('内核主题里有 .cm-section-rule 样式')
    : bad('缺少 .cm-section-rule 主题')

  // 章节底色带（用户 2026-11-16「section 预览区底色不同，循环着来…不抢眼」）
  const bandImpl = /function sectionBands\(doc\)/.test(kernelSrc)
    && /function bandIndexOf\(bands, number\)/.test(kernelSrc)
  bandImpl
    ? ok('内核按最浅一级章节命令切底色带')
    : bad('缺少 sectionBands / bandIndexOf')
  kernelSrc.includes("const BAND_CLASSES = ['cm-sec-band-0', 'cm-sec-band-1', 'cm-sec-band-2', 'cm-sec-band-3']")
    ? ok('底色四档循环（cm-sec-band-0..3）')
    : bad('底色档位不对')
  kernelSrc.includes('const bandCache = new WeakMap()')
    ? ok('底色带按文档对象缓存（滚动不重扫全文）')
    : bad('底色带没有缓存')
  ;['cm-sec-band-0', 'cm-sec-band-1', 'cm-sec-band-2', 'cm-sec-band-3']
    .every((name) => kernelSrc.includes("'." + name + "': {"))
    ? ok('内核主题四档底色都在（透明度 ≤0.05，不压字）')
    : bad('缺少底色主题')
  // 回退编辑器也要有同款分割线
  src.includes("' ml-hl-rule'")
    ? ok('回退编辑器章节行也加分割线类')
    : bad('回退编辑器没有 ml-hl-rule')
  src.includes('.ml-hl-rule{border-top:1px solid')
    ? ok('回退编辑器分割线样式与内核同观感')
    : bad('缺少 .ml-hl-rule 样式')
  // 回退编辑器的底色带
  const bandFallback = /function sectionBandStarts\(rows\)/.test(src)
    && /function sectionBandAt\(starts, index\)/.test(src)
    && src.includes("cls += ' ml-hl-band-' + (band % 4)")
  bandFallback
    ? ok('回退编辑器也按章节切底色带（与内核同规则）')
    : bad('回退编辑器缺底色带')
  src.includes('cached.band === band')
    ? ok('缓存命中也要比对底色带（章节增删后底色不僵住）')
    : bad('缓存没比对 band')
  ;['0', '1', '2', '3'].every((n) => src.includes('.ml-hl-band-' + n + '{background-color:rgba('))
    ? ok('回退编辑器四档底色样式都在')
    : bad('回退编辑器缺底色样式')

  // 全项目搜索的 UI 接线
  const panelWiring = [
    ['顶栏没有加「全项目搜索」按钮（入口在编辑区图标里）', !src.includes("'全项目搜索')")],
    ['编辑区右上角有全项目搜索图标（ml-projsearch-fab）', src.includes('ml-projsearch-fab')],
    ['浮层挂在编辑区、有输入框与结果列表', src.includes("store.projSearchOpen ? h(ProjectSearchPanel")],
    ['点结果先 openTab 再选中（跨文件）',
      /openTab\(root, item\.rel\)\.then\(function \(\)[\s\S]{0,160}?requestAnimationFrame\(go\)/.test(src)],
    ['跳过去之后走 selectRange（不是只跳行）', src.includes('editorBridge.selectRange(start, end)')],
    ['Ctrl+Shift+F 开全项目搜索（排在 Ctrl+F 之前）',
      src.includes("event.shiftKey && (event.key === 'f'") && (() => {
        const at = src.indexOf("event.shiftKey && (event.key === 'f'")
        const block = src.slice(at, at + 600)
        return block.includes('openProjectSearch()')
      })()],
    ['内核把 Ctrl+Shift+F 转给面板', kernelSrc.includes("key: 'Mod-Shift-f'") && kernelSrc.includes('options.onProjectSearch')],
    ['项目搜索状态进会话隔离清单（属项目级）',
      ['projSearchOpen', 'projSearchQuery', 'projSearchResult', 'bibEntries'].every((key) => bundle.__SESSION_FIELDS.includes(key))],
    ['进项目顺手拉一次 .bib（失败静默）', src.includes('loadBibEntries(root)')]
  ]
  for (const [label, passed] of panelWiring) passed ? ok(label) : bad(label)

  // 两个搜索浮层同一位置 → 必须互斥（用户 2026-11-16 报重叠）
  const realRaf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0 }
  Object.assign(store, { root: 'E:\\proj-x', searchOpen: true, projSearchOpen: false })
  bundle.__openProjectSearch()
  store.projSearchOpen === true && store.searchOpen === false
    ? ok('开全项目搜索会关掉 tex 搜索（互斥）')
    : bad('开全项目搜索没关 tex 搜索', JSON.stringify({ s: store.searchOpen, p: store.projSearchOpen }))
  Object.assign(store, { searchOpen: false, projSearchOpen: true })
  bundle.__openSearch('find')
  store.searchOpen === true && store.projSearchOpen === false
    ? ok('开 tex 搜索会关掉全项目搜索（互斥）')
    : bad('开 tex 搜索没关全项目搜索', JSON.stringify({ s: store.searchOpen, p: store.projSearchOpen }))
  globalThis.requestAnimationFrame = realRaf

  Object.assign(store, {
    root: '', projSearchOpen: false, projSearchQuery: '', projSearchResult: null,
    projSearchNotice: '', projSearchBusy: '', bibEntries: []
  })
} catch (error) {
  bad('全项目搜索 / 文献补全 / 折叠测试抛错', String(error.message))
}

console.log('34) 编译结果条：重跑次数与「已清理上次中断的辅助文件」都要说出来')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const compileBlock = (() => {
    const at = src.indexOf('function compileActive(')
    return at < 0 ? '' : src.slice(at, at + 4200)
  })()
  const wiring = [
    ['成功条带「PDF 后端重跑 N 次」', compileBlock.includes("data.pdfRetries ? '（PDF 后端重跑 ' + data.pdfRetries + ' 次）'")],
    ['成功条带「已清理上次中断的 N 个辅助文件」',
      /data\.success[\s\S]{0,400}?data\.recovered \|\| \[\]\)\.length \? ' · 已清理上次中断的 '/.test(compileBlock)],
    ['失败条也说出来（不默默处理）',
      /'编译失败 · ' \+ \(data\.errors \|\| \[\]\)\.length[\s\S]{0,200}?已清理上次中断的/.test(compileBlock)],
    ['没有 recovered 时不显示多余字样', (compileBlock.match(/已清理上次中断的/g) || []).length === 2]
  ]
  for (const [label, passed] of wiring) passed ? ok(label) : bad(label)
} catch (error) {
  bad('编译结果条测试抛错', String(error.message))
}
console.log('35) 投屏讲解：键位状态机 / 讲稿旁挂 / 观众窗接线')
try {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const key = bundle.__presentKey
  const base = { page: 5, total: 20, black: false, white: false, badge: false, overview: false, help: false, pending: '', pendingAt: 0 }
  const press = (input, k, now) => key(input, k, now === undefined ? 1000 : now)

  const keys = [
    ['→ 下一页', (() => { const r = press(base, 'ArrowRight'); return r.action === 'next' && r.state.page === 6 })()],
    ['Space 下一页', (() => { const r = press(base, ' '); return r.action === 'next' && r.state.page === 6 })()],
    ['PageDown 下一页', (() => { const r = press(base, 'PageDown'); return r.state.page === 6 })()],
    ['← 上一页', (() => { const r = press(base, 'ArrowLeft'); return r.action === 'prev' && r.state.page === 4 })()],
    ['Backspace 上一页（不退出）', (() => { const r = press(base, 'Backspace'); return r.action === 'prev' && r.state.page === 4 })()],
    ['Shift + → 一次走 10 页', (() => { const r = press(base, 'Shift+ArrowRight'); return r.state.page === 15 })()],
    ['Shift + ← 一次退 10 页（越过首页就停在首页）', (() => { const r = press(base, 'Shift+ArrowLeft'); return r.state.page === 1 && r.action === 'prev' })()],
    ['Home 首页', (() => { const r = press(base, 'Home'); return r.action === 'first' && r.state.page === 1 })()],
    ['End 末页', (() => { const r = press(base, 'End'); return r.action === 'last' && r.state.page === 20 })()],
    ['末页再按 → 不越界', (() => { const r = press({ page: 20, total: 20 }, 'ArrowRight'); return r.state.page === 20 && r.action === 'end' })()],
    ['首页再按 ← 不越界', (() => { const r = press({ page: 1, total: 20 }, 'ArrowLeft'); return r.state.page === 1 && r.action === 'start' })()],
    ['数字累积成 12', (() => { const r = press(press(base, '1').state, '2'); return r.action === 'typing' && r.state.pending === '12' })()],
    ['数字 + Enter 跳页（页码由调用方按 pending 取）', (() => { const r = press(press(base, '1').state, '2'); const j = press(r.state, 'Enter'); return j.action === 'jump' && j.state.page === 5 && j.state.pending === '' })()],
    ['只按 Enter 当翻页', (() => { const r = press(base, 'Enter'); return r.action === 'next' && r.state.page === 6 })()],
    ['数字过期（1.5 秒）后 Enter 不再跳页', (() => { const a = press(base, '1', 1000); const b = press(a.state, 'Enter', 4000); return b.action === 'next' })()],
    ['Esc 直接退出（不二次确认）', press(base, 'Escape').action === 'exit'],
    ['Esc 先关帮助层', (() => { const r = press({ help: true }, 'Escape'); return r.action === 'dismiss' && r.state.help === false })()],
    ['Esc 先关总览层', (() => { const r = press({ overview: true }, 'Escape'); return r.action === 'dismiss' && r.state.overview === false })()],
    ['B 黑屏', (() => { const r = press(base, 'b'); return r.action === 'black' && r.state.black === true })()],
    ['黑屏时按 W 转白屏（互斥）', (() => { const r = press({ black: true }, 'w'); return r.action === 'white' && r.state.white === true && r.state.black === false })()],
    ['再按 W 恢复画面', (() => { const r = press({ white: true }, 'w'); return r.action === 'show' && r.state.white === false })()],
    ['N 页码角标', (() => { const r = press(base, 'n'); return r.action === 'badge' && r.state.badge === true })()],
    ['O 缩略图总览', (() => { const r = press(base, 'o'); return r.action === 'overview' && r.state.overview === true })()],
    ['? 帮助（与总览互斥）', (() => { const r = press({ overview: true }, '?'); return r.action === 'help' && r.state.help === true && r.state.overview === false })()],
    ['没绑定的键不动状态', (() => { const r = press(base, 'x'); return r.action === 'none' && r.state.page === 5 })()]
  ]
  for (const [label, passed] of keys) passed ? ok(label) : bad(label)

  const notes = [
    ['旁挂讲稿与 PDF 同目录同基名', bundle.__notesRelFor('main.pdf') === 'main.notes.md'],
    ['子目录里的 PDF 也同目录', bundle.__notesRelFor('slides/a/b.pdf') === 'slides/a/b.notes.md'],
    ['Windows 反斜杠路径也认', bundle.__notesRelFor('E:\\p\\a.pdf') === 'E:\\p\\a.notes.md'],
    ['没有 PDF 就没有讲稿路径', bundle.__notesRelFor('') === ''],
    ['先 .notes.md 后 .notes.txt', JSON.stringify(bundle.__notesCandidatesFor('x.pdf')) === JSON.stringify(['x.notes.md', 'x.notes.txt'])]
  ]
  for (const [label, passed] of notes) passed ? ok(label) : bad(label)

  const numbered = bundle.__parsePresentNotes('# 标题\n\n通用提示\n\n## 2\n\n第二页讲稿\n\n## 3\n\n第三页讲稿')
  const splitByRule = bundle.__parsePresentNotes('第一页\n\n---\n\n第二页\n\n---\n\n第三页')
  const flat = bundle.__parsePresentNotes('只有一段通用开场白')
  // md 里常拿 <!-- ... --> 写「这段别投出去」的备忘 —— 以前会原样出现在讲稿区（用户报过）。
  const commented = bundle.__parsePresentNotes('<!-- 给自己看的备忘 -->\n\n## 2\n\n第二页讲稿')
  const parsed = [
    ['## 页码分节认出来', numbered.grouped === true && numbered.count === 2],
    ['第一个分节之前的正文当通用讲稿', numbered.common.includes('通用提示')],
    ['第 2 页只拿到自己的讲稿', String(numbered.pages['2'] || '').includes('第二页讲稿') && !String(numbered.pages['2'] || '').includes('第三页')],
    ['单独一行的 --- 也能逐页分', splitByRule.count === 3 && String(splitByRule.pages['1'] || '').includes('第一页')],
    ['没有分隔符时整篇都是通用讲稿', flat.grouped === false && flat.count === 0 && flat.common === '只有一段通用开场白'],
    ['取某页讲稿带通用段', (() => { const one = bundle.__presentNotesForPage(numbered, 2); return one.common.includes('通用提示') && one.page.includes('第二页讲稿') })()],
    ['没有这一页时只回通用段', (() => { const one = bundle.__presentNotesForPage(numbered, 9); return one.page === '' && one.common.includes('通用提示') })()],
    ['HTML 注释整段剥掉（不投给观众看）',
      !JSON.stringify(commented).includes('给自己看的备忘') && String(commented.pages['2'] || '').includes('第二页讲稿')],
    // 讲稿文件第一行的 # 标题是文件抬头，不该当通用讲稿挂在每一页顶上（用户报过：
    // 「骨架一建好，讲稿框里只有一行蓝色标题，分不清是没跑通还是没写」）。
    ['开头的 # 标题被剥掉（不当通用讲稿）', bundle.__parsePresentNotes('# 论文章节标题\n\n## 1\n\n第一页').common === ''],
    ['只剥第一个 H1，## 及以下照旧', (() => {
      const p = bundle.__parsePresentNotes('# 抬头\n\n正文一行\n\n## 2\n\n第二页')
      return p.common === '正文一行' && String(p.pages['2'] || '').includes('第二页')
    })()],
    ['没有分隔符时也剥 H1（整篇即通用）', bundle.__parsePresentNotes('# 抬头\n\n只有一段开场白').common === '只有一段开场白'],
    ['stripNotesTitle 不误伤正文', bundle.__stripNotesTitle('没有标题的讲稿') === '没有标题的讲稿'],
  ]
  for (const [label, passed] of parsed) passed ? ok(label) : bad(label)

  const md = bundle.__renderPresentNotesHtml
  const escaped = md('看 <b>标签</b> & "引号"')
  const mdChecks = [
    ['标题渲染成 .ml-present-h', md('## 小标题').includes('ml-present-h')],
    ['无序列表渲染成 .ml-present-li', md('- 一条').includes('ml-present-li')],
    ['有序列表带序号', md('1. 一步').includes('ml-present-num')],
    ['行内代码', md('用 `\\begin` 开头').includes('<code>\\begin</code>')],
    ['粗体', md('**重点**').includes('<strong>重点</strong>')],
    ['讲稿里的尖括号被转义（不会破坏 DOM）', escaped.includes('&lt;b&gt;') && !escaped.includes('<b>')],
    ['& 也转义', escaped.includes('&amp;')],
    ['空讲稿不产出 DOM', md('') === '']
  ]
  for (const [label, passed] of mdChecks) passed ? ok(label) : bad(label)

  const skeleton = bundle.__presentNotesSkeleton(3, '答辩')
  const dpiChecks = [
    ['骨架每页一节', skeleton.includes('## 1') && skeleton.includes('## 2') && skeleton.includes('## 3')],
    // 抬头写进 <!-- --> 里：骨架一建好讲稿框必须是「这一页还没有讲稿」，
    // 而不是先顶一行标题（那是文件抬头，不是讲稿）。
    ['骨架抬头在注释里，不进讲稿正文', skeleton.startsWith('<!-- 答辩') && !/^# /m.test(skeleton)],
    ['骨架解析出来通用段为空', bundle.__parsePresentNotes(skeleton).common === ''],
    ['骨架每页都还是空的（整块会显示「还没写」提示）', (() => {
      const p = bundle.__parsePresentNotes(skeleton)
      return String(bundle.__presentNotesForPage(p, 2).page || '').trim() === ''
    })()],
    // 200 铺满一块 1920 宽的屏仍然糊（用户实测），所以档位往 288/400 扩，上限跟着
    // 宿主 PDF_DPI_MAX 提到 400。默认给中间的 288：再高单页要 ~1MB，翻页会顿。
    ['DPI 五档（96/144/200/288/400）', JSON.stringify(bundle.__PRESENT_DPI_CHOICES) === JSON.stringify([96, 144, 200, 288, 400])],
    ['DPI 默认 288（铺满 1080p 不糊）', bundle.__PRESENT_DPI_DEFAULT === 288 && bundle.__normalizePresentDpi(undefined) === 288],
    ['不在档位里的值落回默认', bundle.__normalizePresentDpi(999) === 288 && bundle.__normalizePresentDpi(137) === 288],
    ['合法档位原样保留（字符串也认）', bundle.__normalizePresentDpi('400') === 400 && bundle.__normalizePresentDpi(96) === 96],
    ['投屏状态不进会话隔离清单（放映是这台机器的事）',
      !bundle.__SESSION_FIELDS.includes('presentOn') && !bundle.__SESSION_FIELDS.includes('presentDpi')],
    ['DPI 偏好写 localStorage', src.includes('presentDpi: state.presentDpi')]
  ]
  for (const [label, passed] of dpiChecks) passed ? ok(label) : bad(label)

  // 顶栏「投屏」按钮：只有编译出 PDF 才可点，放映中换文案
  const store = bundle.__store
  const render = () => ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))
  store.view = 'workbench'
  store.pane = 'pdf'
  store.tabs = [{ id: 't-pdf', root: 'E:/p/paper', rel: 'main.tex', name: 'main.tex', text: 'x', dirty: false }]
  store.activeId = 't-pdf'
  store.root = 'E:/p/paper'
  store.pdfRoot = 'E:/p/paper'
  store.pdfRel = 'main.pdf'
  store.pdfRev = '1712345678'
  store.pdfPages = 3
  store.pdfRaster = true
  store.pdfUrl = ''
  store.presentOn = false
  const idleHtml = render()
  store.presentOn = true
  const liveHtml = render()
  store.presentOn = false
  store.pdfRel = ''
  store.pdfPages = 0
  const noPdfHtml = render()
  store.pdfRel = 'main.pdf'
  store.pdfPages = 3
  const uiChecks = [
    // 用户 m04680：投屏按钮换成电视机/显示器图标（文字进 title）
    ['顶栏有「投屏」图标按钮（class + title 都在）',
      idleHtml.includes('ml-present-fab') && idleHtml.includes('投屏讲解：观众屏只显示当前页')],
    ['放映中 title 换文案', liveHtml.includes('正在投屏放映')],
    ['没有 PDF 时按钮不可点', /disabled=""[^>]*ml-present-fab/.test(noPdfHtml) || /ml-present-fab[^>]*disabled=""/.test(noPdfHtml)],
    ['按钮接线到 openPresent', /onClick: function \(\) \{ openPresent\(\) \}/.test(src)],
    // DSH 桌面版（Electron）给主窗装了 setWindowOpenHandler：about:blank / 相对地址
    // 一律 deny（连原生窗口都不建，副屏/任务栏里什么都没有 —— 用户实测报过），
    // 只有 http(s) 会转 shell.openExternal 开在系统默认浏览器里。
    // 而桌面版主窗自己的 origin 是 dsh-app://app（自定义协议），拼出来的地址照样被
    // deny（用户第二次实测：点「观众窗」还是没反应）—— 必须用宿主 http host 的真实
    // origin，它挂在 window.__DSH_TRANSPORT__.streamBaseUrl 上。
    ['观众窗打开的是宿主发的观众页（绝对 http 地址）',
      /window\.open\(url, PRESENT_CHANNEL, PRESENT_WINDOW_FEATURES\)/.test(src) &&
        /var url = origin \? origin \+ PRESENT_API : PRESENT_API/.test(src)],
    ['观众页路由与主窗接口同一个前缀（/moling/present）',
      /var PRESENT_API = '\/moling\/present'/.test(src)],
    ['features 里带宽高（不带就被当标签页）',
      /var PRESENT_WINDOW_FEATURES = 'popup=yes,width=\d+,height=\d+/.test(src)],
    // 观众页在另一个浏览器进程里，BroadcastChannel 跨不过去 —— 改走宿主 HTTP 中转。
    ['两窗进度用宿主中转同步（不再用 BroadcastChannel）',
      /function publishPresentState\(rt\)/.test(src) && /function startPresentSync\(rt\)/.test(src) &&
        !/new BroadcastChannel/.test(src)],
    ['状态往 /moling/present/state 推、按键从 /key 取',
      /PRESENT_API \+ '\/state'/.test(src) && /PRESENT_API \+ '\/key'/.test(src)],
    ['收摊时推 live:false（观众页要回到「等待放映」）',
      /function publishPresentStop\(rt\)[\s\S]{0,400}?live: false/.test(src)],
    ['观众页轮询间隔单独一个常量', /var PRESENT_SYNC_MS = \d+/.test(src) && /PRESENT_SYNC_MS\)/.test(src)],
    ['退出放映时停掉轮询（不留定时器）',
      /function stopPresentSync\(rt\)[\s\S]{0,200}?clearInterval/.test(src)],
    ['讲稿层挂在 document.body（不被面板子树裁切）', src.includes('document.body.appendChild')],
    ['切会话会停放映', /next\.pdfJumpText = ''[\s\S]{0,120}?stopPresent\('session'\)/.test(src)],
    ['关项目会停放映', /presentOn: false[\s\S]{0,2500}?stopPresent\('project'\)/.test(src)],
    ['PDF 重编译后跟随新文件', /presentAdoptState\(\)/.test(src)],
    ['退出放映回到当前页（右栏跟随）', /pdfFocusPage: page[\s\S]{0,80}?pdfViewPage/.test(src)],
    ['总览缩略图第一次打开时才取图（长 deck 不打上百个请求）',
      src.includes("setAttribute('data-thumb-page'") && /if \(rt\.key\.overview\)[\s\S]{0,260}?presentImageUrl\(rt, i \+ 1\)/.test(src)],
    // 缩略图改用当前 DPI 那份：整本预热已经把它取进浏览器缓存了，
    // 再按 96dpi 另取一轮等于白打一遍请求。
    ['总览缩略图复用预热好的那档 DPI（不再另打一轮 96dpi）',
      !/pdfPageUrl\(i \+ 1, 96/.test(src)],
    // 外部浏览器的窗口拿不到引用，moveTo 之类的搬屏操作对它无效 —— 按钮改成
    // 「再开一次观众窗」，怎么摆到副屏交给用户自己拖 + F11。
    ['顶栏「观众窗」按钮能再开一次',
      /var btnAudience = presentNode\('button', 'ml-present-btn', '观众窗'\)/.test(src) &&
        /btnAudience\.addEventListener\('click'[\s\S]{0,120}?openPresentAudience\(rt\)/.test(src)],
    // 观众页那边点一下画面就进全屏（方案 C）：主窗这边的文案不能还只说 F11，
    // 否则用户会站在投影前找键盘。
    ['「观众窗」按钮与提示都说清点一下画面即全屏',
      src.includes('进全屏点一下画面，或按 F11') &&
        src.includes('在那一页点一下画面就进全屏')],
    ['帮助层同样写清点一下画面',
      src.includes("['观众窗', '点顶栏「观众窗」再把观众页叫出来一次") &&
        /观众窗', '点顶栏「观众窗」[\s\S]{0,80}?点一下画面/.test(src)],
    ['attachPresentWindow 在拿不到窗口引用时不报错（桌面版返回 null 是正常的）',
      /function attachPresentWindow\(rt, win\)[\s\S]{0,600}?rt\.win = win && !win\.closed \? win : null/.test(src) &&
        !/打不开放映窗口/.test(src)],
    // 桌面版 Windows 用 titleBarOverlay：顶上那条带子是 -webkit-app-region:drag 的
    // 拖拽区，会吞掉点击 —— 全屏浮层不挖洞就点不动按钮（用户实测报过）。
    ['讲稿层挖出拖拽区（no-drag），否则顶栏按钮点不动',
      /#ml-present-root\{[^}]*?-webkit-app-region:no-drag/.test(src)],
    ['顶栏按钮自己也标 no-drag', /\.ml-present-btn\{-webkit-app-region:no-drag/.test(src)],
    // 讲稿层只盖**墨灵面板那一块**（左边对话框照常能看），四边全部走 CSS 变量；
    // 建层时先用整窗兜底（顺便让开原生标题栏那条拖拽带），量到面板矩形再收进去。
    // 用户报过「用户界面看着带点蓝色，跟周围 DSH 不统一」：讲稿层配色必须走
    // 主题 token（--dsw-alias-*），不许再写死 GitHub 深蓝那套 #0d1117 / #161b22 / #58a6ff。
    ['讲稿层配色走 DSH 主题 token（不再写死深蓝）',
      /#ml-present-root\{[^}]*background:var\(--dsw-alias-bg-base/.test(src) &&
        /#ml-present-root\{[^}]*color:var\(--dsw-alias-label-primary/.test(src) &&
        /\.ml-present-head\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(src) &&
        /\.ml-present-notes\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(src) &&
        /\.ml-present-timer\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(src)],
    ['讲稿层里没有遗留写死的深蓝色值',
      (() => {
        const css = bundle.__PRESENT_CSS
        return typeof css === 'string' && !/#0d1117|#161b22|#010409|#21262d|#30363d|#58a6ff|#c9d1d9/i.test(css)
      })()],
    ['主题 token 都带硬编码兜底（拿不到 token 也不会透明）',
      (() => {
        const css = bundle.__PRESENT_CSS
        const vars = css.match(/var\(--dsw-alias-[a-z0-9-]+/g) || []
        const withFallback = css.match(/var\(--dsw-alias-[a-z0-9-]+,[^)]+\)/g) || []
        return vars.length > 20 && withFallback.length === vars.length
      })()],
    ['讲稿层四边都走变量（能收进面板，也能兜底整窗）',
      /#ml-present-root\{position:fixed;top:var\(--ml-present-top,0px\);left:var\(--ml-present-left,0px\)/.test(src) &&
        /right:var\(--ml-present-right,0px\);bottom:var\(--ml-present-bottom,0px\)/.test(src)],
    ['建层先铺满整窗（量不到面板时的兜底）',
      /function presentFillWindow\(root\)[\s\S]{0,400}?--ml-present-bottom', '0px'/.test(src) &&
        /presentFillWindow\(root\)/.test(src)],
    ['放映范围按墨灵面板量（[data-moling="1"]，跳过 hidden 的会话副本）',
      /document\.querySelectorAll\('\[data-moling="1"\]'\)/.test(src) &&
        /el\.hidden \|\| !el\.offsetParent/.test(src)],
    ['面板矩形换算成四边像素（纯函数，可自测驱动）',
      (() => {
        const box = bundle.__presentFrameBox({ left: 100, top: 40, right: 900, bottom: 700 }, 1200, 900)
        return box && box.left === '100px' && box.top === '40px' && box.right === '300px' && box.bottom === '200px'
      })()],
    ['矩形越界时 right/bottom 夹成 0（不给负值）',
      (() => {
        const box = bundle.__presentFrameBox({ left: 0, top: 0, right: 1200, bottom: 900 }, 1000, 800)
        return box && box.right === '0px' && box.bottom === '0px'
      })()],
    ['量不到窗口时按面板自身宽高兜底（不出 NaN）',
      (() => {
        const box = bundle.__presentFrameBox({ left: 10, top: 10, right: 210, bottom: 110 }, 0, 0)
        return box && box.left === '10px' && box.right === '0px' && box.bottom === '0px'
      })()],
    ['面板藏起来时沿用上一次矩形（不跳回整窗）',
      /if \(rect\) rt\.frame = rect[\s\S]{0,80}?else if \(rt\.frame\) rect = rt\.frame/.test(src)],
    // 面板顶边如果落在原生标题栏那条 -webkit-app-region:drag 带里，顶栏按钮会被吞点击
    // （用户实测报过），所以 top 不许高过 presentTitlebarOffset()。
    ['顶边不落进原生拖拽带（top 有下限）',
      /var clearance = presentTitlebarOffset\(\)[\s\S]{0,200}?box\.top = clearance \+ 'px'/.test(src)],
    ['拖分栏 / 缩窗会重算矩形',
      src.includes("window.addEventListener('resize', presentSyncFrame)") &&
        src.includes("document.addEventListener('fullscreenchange', presentSyncFrame)") &&
        /new ResizeObserver\(function \(\) \{ presentSyncFrame\(\) \}\)/.test(src)],
    ['退出放映摘掉监听与 ResizeObserver（不留僵尸处理器）',
      src.includes("window.removeEventListener('resize', presentSyncFrame)") &&
        src.includes("document.removeEventListener('fullscreenchange', presentSyncFrame)") &&
        /presentStopWatchScope\(rt\)/.test(src) && /scopeObserver\.disconnect\(\)/.test(src)],
    // 用 DSH 自己的 --dsh-frame-top-clearance（Windows=标题栏高、macOS=48px、浏览器=0），
    // 别再自己判 data-fullscreen：那条拖拽带和 .frame 的 padding-top 全屏时都不重置。
    ['偏移量取 DSH 的 --dsh-frame-top-clearance',
      src.includes("--dsh-frame-top-clearance") && /presentTitlebarOffset/.test(src)],
    ['没有该变量时落回标题栏高度，再不行 0',
      /clearance > 0[\s\S]{0,200}?--dsh-windows-titlebar-height/.test(src)],
    ['没进放映时运行时是空的', bundle.__presentRuntime() === null],
    ['导出接线齐（自测可驱动）', typeof bundle.__openPresent === 'function' && typeof bundle.__stopPresent === 'function' && typeof bundle.__presentAdoptState === 'function'],
    ['中转相关的导出也在（观众窗与状态发布可被测试驱动）',
      typeof bundle.__openPresentAudience === 'function' && typeof bundle.__publishPresentState === 'function' &&
        bundle.__presentSyncMs > 0],
    // 版面照 PowerPoint 演讲者视图：左边一整块是当前页（图 + 底部翻页条），
    // 右边一列三段（上「下一张幻灯片」、中讲稿、下计时），讲稿不再是整宽底部横条。
    // 左右两列的底边要齐平：靠同一个 CSS 变量 --ml-present-bottom-h 给两边最后一行定高，
    // 再加两边相同的 gap，于是「图底边 / 讲稿底边 / 计时底边」自然对齐，不用 JS 量高。
    ['当前页独占左侧大块（.ml-present-stage）',
      /\.ml-present-stage\{flex:1 1 auto;min-width:0;min-height:0/.test(src) &&
        /var stage = presentNode\('div', 'ml-present-stage'\)/.test(src)],
    ['右列是独立的窄栏（.ml-present-side），不是和当前页等分',
      /\.ml-present-side\{flex:0 0 32%/.test(src) &&
        /var side = presentNode\('div', 'ml-present-side'\)/.test(src) &&
        /body\.appendChild\(stage\)[\s\S]{0,40}?body\.appendChild\(side\)/.test(src)],
    ['讲稿放进右列下半（不再整宽铺在底部）',
      /side\.appendChild\(nextPane\)[\s\S]{0,40}?side\.appendChild\(notes\)/.test(src) &&
        !/root\.appendChild\(body\)[\s\S]{0,40}?root\.appendChild\(notes\)/.test(src)],
    ['讲稿再也不会被 flex 当成整宽横条压成固定高度',
      /\.ml-present-notes\{flex:1 1 auto;min-height:96px/.test(src)],
    ['下一张缩略图有高度上限（横版缩略图不把讲稿挤没）',
      /\.ml-present-pane>img\{width:100%;max-height:36vh/.test(src)],
    ['底部居中翻页条照 PPT 的写法：「‹ 第 N 张幻灯片，共 M 张 ›」',
      /nodes\.footText\.textContent = '第 ' \+ rt\.key\.page \+ ' 张幻灯片，共 ' \+ rt\.key\.total \+ ' 张'/.test(src) &&
        /\.ml-present-foot\{flex:0 0 auto;height:var\(--ml-present-bottom-h,38px\);box-sizing:border-box;/.test(src) &&
        /display:flex;align-items:center;justify-content:center;gap:16px;padding:0\}/.test(src)],
    ['左下翻页条与右下计时用同一个高度变量（两列底边才敢对齐）',
      /\.ml-present-body\{flex:1 1 auto;min-height:0;display:flex;gap:10px;padding:8px;--ml-present-bottom-h:38px\}/.test(src) &&
        /\.ml-present-foot\{flex:0 0 auto;height:var\(--ml-present-bottom-h,38px\)/.test(src) &&
        /\.ml-present-timer\{flex:0 0 auto;height:var\(--ml-present-bottom-h,38px\);box-sizing:border-box;/.test(src)],
    ['两列上下间距一致（stage 与 side 的 gap 都是 8px，不然底边还是错开）',
      /\.ml-present-stage\{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;gap:8px\}/.test(src) &&
        /\.ml-present-side\{flex:0 0 32%;min-width:200px;max-width:560px;min-height:0;/.test(src) &&
        /flex-direction:column;gap:8px\}/.test(src)],
    ['计时是右列第三段，排在讲稿下面（讲稿不再顶到底）',
      /side\.appendChild\(nextPane\)[\s\S]{0,40}?side\.appendChild\(notes\)[\s\S]{0,40}?side\.appendChild\(timer\)/.test(src) &&
        /var timer = presentNode\('div', 'ml-present-timer'\)/.test(src)],
    ['计时从开放映起算，退出放映摘掉定时器（不留僵尸 interval）',
      /presentTimerStart\(rt\)/.test(src) &&
        /stopPresentSync\(rt\)[\s\S]{0,80}?presentTimerStop\(rt\)/.test(src) &&
        /presentTimerStopTick\(rt\)[\s\S]{0,60}?rt\.timer = null/.test(src)],
    ['计时点数字暂停 / 继续，点 ↺ 归零（不重开放映）',
      /timerText\.addEventListener\('click', function \(\) \{ presentTimerToggle\(rt\) \}\)/.test(src) &&
        /timerReset\.addEventListener\('click', function \(\) \{ presentTimerReset\(rt\) \}\)/.test(src)],
    ['计时导出齐（自测可驱动格式与暂停 / 归零）',
      typeof bundle.__presentTimerText === 'function' &&
        typeof bundle.__presentTimerToggle === 'function' &&
        typeof bundle.__presentTimerReset === 'function'],
    ['计时显示 mm:ss，超一小时才显示 h:mm:ss',
      bundle.__presentTimerText({ timer: { elapsed: 5000, since: 0, paused: true } }) === '00:05' &&
        bundle.__presentTimerText({ timer: { elapsed: 65000, since: 0, paused: true } }) === '01:05' &&
        bundle.__presentTimerText({ timer: { elapsed: 3725000, since: 0, paused: true } }) === '1:02:05' &&
        bundle.__presentTimerText({ timer: null }) === '00:00'],
    ['计时暂停后不再走表（elapsed 冻住）',
      (function () {
        const rt = { nodes: { timerText: { textContent: '', className: '' } },
          timer: { elapsed: 60000, since: 0, paused: true } };
        const frozen = bundle.__presentTimerText(rt);
        bundle.__presentTimerToggle(rt);   // 暂停中 -> 继续
        return frozen === '01:00' && rt.timer.paused === false && rt.timer.since > 0;
      })()],
    ['计时归零后从 00:00 重新走',
      (function () {
        const rt = { nodes: { timerText: { textContent: '', className: '' } },
          timer: { elapsed: 90000, since: 0, paused: true } };
        bundle.__presentTimerReset(rt);
        return rt.timer.elapsed === 0 && bundle.__presentTimerText(rt) === '00:00';
      })()],
    ['底部两个圆钮接翻页，且首末页置灰',
      /btnPrev\.addEventListener\('click', function \(\) \{ presentStep\(-1\) \}\)/.test(src) &&
        /nodes\.footPrev\.disabled = rt\.key\.page <= 1/.test(src) &&
        /nodes\.footNext\.disabled = rt\.key\.page >= rt\.key\.total/.test(src)],
    ['上一页/下一页仍由头部按钮驱动（新翻页条只是多一条路）',
      /var btnPrev = presentNode\('button', 'ml-present-btn', '←'\)/.test(src) &&
        /var btnNext = presentNode\('button', 'ml-present-btn', '→'\)/.test(src)],
    ['旧的「当前页」小标题已撤（当前页靠大图 + 底部页码标识，不重复写）',
      !src.includes("var curCap = presentNode('div', 'ml-present-cap', '当前页')")],
  ]
  for (const [label, passed] of uiChecks) passed ? ok(label) : bad(label)

  // 观众页地址的 origin：桌面版主窗是 dsh-app://app（自定义协议），拿它拼地址会被宿主
  // 的 setWindowOpenHandler 直接 deny —— 必须取宿主 http host 的真实 origin。
  const savedWindow = globalThis.window
  const originChecks = []
  try {
    globalThis.window = { location: undefined }
    originChecks.push(['没有宿主信息时拿不到 origin（不会拼出坏地址）', bundle.__presentAudienceOrigin() === ''])

    globalThis.window = {
      __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:55713/' },
      location: { origin: 'dsh-app://app' }
    }
    originChecks.push(['桌面版取宿主 http host（优先于 dsh-app:// 的 location.origin）',
      bundle.__presentAudienceOrigin() === 'http://127.0.0.1:55713'])

    globalThis.window = { location: { origin: 'http://localhost:3000' } }
    originChecks.push(['纯浏览器里退化到 location.origin',
      bundle.__presentAudienceOrigin() === 'http://localhost:3000'])

    globalThis.window = { location: { origin: 'dsh-app://app' } }
    originChecks.push(['只有自定义协议时返回空（不硬拼 dsh-app:// 让宿主 deny）',
      bundle.__presentAudienceOrigin() === ''])
  } finally {
    globalThis.window = savedWindow
  }
  for (const [label, passed] of originChecks) passed ? ok(label) : bad(label)

  // 拿不到 http 地址时不能闷着不响：要把能用的地址写进状态栏，用户手抄也能看。
  const noticeChecks = [
    ['拿不到宿主地址时把观众页地址明说出来',
      /function openPresentAudience\(rt\)[\s\S]{0,400}?拿不到宿主的 http 地址[\s\S]{0,200}?noticeOk: false/.test(src)],
    ['桌面版交出去之后拿不到窗口引用，也要说一声（不静默）',
      /if \(!opened\)[\s\S]{0,200}?交给系统浏览器打开/.test(src)],
    ['presentAudienceOrigin 导出可测', typeof bundle.__presentAudienceOrigin === 'function']
  ]
  for (const [label, passed] of noticeChecks) passed ? ok(label) : bad(label)

  // ---- 整本预热：纯函数 + 接线 ----
  // 答辩现场最怕「跳到第 20 页 → 现场跑 pdftoppm → 一秒白屏」，
  // 所以开放映后自动把 1..N 页按当前 DPI 全渲染一遍。这里只测纯函数与接线。
  const warmView = bundle.__presentWarmView
  const warmChecks = [
    ['没跑过也不显示（进度条默认隐藏）', warmView(null, null) === null],
    ['在跑时显示 done/total', (() => {
      const v = warmView({ total: 34, done: 12, failed: 0, next: 13, cancelled: false }, null)
      return v && v.text.includes('12/34') && v.width === Math.round((12 / 34) * 100)
    })()],
    ['跑完显示总页数（绿色）', (() => {
      const v = warmView(null, { total: 34, failed: 0 })
      return v && v.text.includes('34') && v.cls === 'ml-present-warm-ok' && v.width === 100
    })()],
    ['有失败页就报失败（红色，不谎报成功）', (() => {
      const v = warmView(null, { total: 34, failed: 2 })
      return v && v.text.includes('2') && v.cls === 'ml-present-warm-bad'
    })()],
    ['进度条宽度封顶 100', warmView({ total: 4, done: 9, failed: 0 }, null).width === 100],
    ['并发 3 路（每页一个 pdftoppm，再高互相拖慢）', bundle.__PRESENT_WARM_CONCURRENCY === 3],
    ['开放映后自动预热', /presentWarmStart\(rt\)\n    }/.test(src) || /function openPresent\(\)[\s\S]{0,2200}?presentWarmStart\(rt\)/.test(src)],
    ['退出放映会掐掉在跑的预热', /presentWarmCancel\(rt\)[\s\S]{0,80}?publishPresentStop/.test(src)],
    ['换 DPI 后重跑预热（缓存键含 dpi）',
      /presentDpi: wanted[\s\S]{0,900}?presentWarmStart\(rt\)/.test(src)],
    ['重编译后重跑预热（缓存键含 mtime）',
      /revChanged[\s\S]{0,300}?presentWarmStart\(rt\)/.test(src)],
    ['取消时掐掉在飞的请求（不白烧 CPU 落没人要的档位）',
      /\.abort\.abort\(\)/.test(src) && /name === 'AbortError'/.test(src)],
    ['预热走 presentImageUrl（和放映取图同一份缓存键）',
      /function presentWarmStart\(rt\)[\s\S]{0,1400}?presentImageUrl\(rt, page\)/.test(src)],
    ['进度条点一下能重跑', /warm\.addEventListener\('click'[\s\S]{0,80}?presentWarmStart\(rt\)/.test(src)],
    ['导出接线齐（自测可驱动）', typeof bundle.__presentWarmStart === 'function'
      && typeof bundle.__presentWarmCancel === 'function' && typeof bundle.__presentWarmView === 'function']
  ]
  for (const [label, passed] of warmChecks) passed ? ok(label) : bad(label)
} catch (error) {
  bad('投屏讲解测试抛错', String(error.message))
}


console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
