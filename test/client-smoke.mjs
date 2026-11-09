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
import { readdirSync } from 'node:fs'
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
    { kind: 'dir', value: 'E:/proj/paper', title: 'paper', at: now - 60000 },
    { kind: 'file', root: 'E:/proj/paper', value: 'main.tex', title: 'main.tex', at: now - 120000 }
  ]
  store.workspaces = [{ path: 'E:/proj/paper', title: 'paper', kind: 'workspace' }]
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(slot.component, {}))

  const rowCount = (html.match(/class="ml-row"/g) || []).length
  const checks = [
    ['「最近」小节', html.includes('>最近<')],
    ['类型标签：工作区', html.includes('>工作区<')],
    ['类型标签：文件', html.includes('>文件<')],
    ['最近项目行', html.includes('paper') && html.includes('E:/proj/paper')],
    ['最近文件行', html.includes('main.tex')],
    ['已去掉 DSH 工作区列表', !html.includes('DSH 工作区')],
    ['「模板」卡片', html.includes('新建中文文档') && html.includes('ctexart')],
    ['行样式已就位（ml-row 多条）', rowCount >= 5]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
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

  const checks = [
    ['首页按钮', html.includes('首页')],
    ['目录按钮', html.includes('目录')],
    ['树开关', html.includes('树')],
    ['编译按钮', html.includes('编译')],
    ['日志页签', html.includes('日志')],
    ['PDF 页签', html.includes('PDF')],
    ['状态行', html.includes('就绪')],
    ['左右两栏（右栏 45.0%）', html.includes('width:45.0%')],
    ['tex/pdf 分隔条可拖动', html.includes('col-resize')],
    ['渲染出 1~6 行行号', html.includes('data-line="1"') && html.includes('data-line="6"')],
    ['命令着色（brand-primary）', html.includes('dsw-alias-brand-primary')],
    ['环境名着色（state-error-primary）', html.includes('dsw-alias-state-error-primary')],
    ['引用键着色（state-warn-primary）', html.includes('dsw-alias-state-warn-primary')],
    ['数学着色（state-success-primary）', html.includes('dsw-alias-state-success-primary')],
    ['注释着色（label-secondary）', html.includes('dsw-alias-label-secondary')],
    ['章节行加粗', html.includes('font-weight:600')],
    ['数学环境跨行传递（equation 内无未闭合）', !html.includes('undefined')],
    ['textarea 软换行', html.includes('white-space:pre-wrap')],
    ['行号与正文同偏移', html.includes('padding:6px 8px 6px 56px')],
    ['已去掉路径输入行', !html.includes('回车打开')],
    ['没有旧 gutter', !html.includes('width:34px')]
  ]
  for (const [label, passed] of checks) passed ? ok(label) : bad(label)
  console.log(`     渲染 HTML ${html.length} 字节`)

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

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
