/**
 * 互换几何的真浏览器自测（不必开 DSH）。
 *
 * DSH 的三列外壳是 CSS grid + 显式 grid-area，order 无效 —— 互换只能靠
 * 「对调两列 grid-area + 重排 grid-template-columns」。这里把 lib/client.js
 * 里那段实现**原样抠出来**，放进一个结构和 DSH 一样的三列页面，用 headless
 * Edge 跑真实布局，验证：
 *   - 换位后墨灵贴左侧栏、对话框在右且拿回剩余宽度；
 *   - React 重写框架模板（缩放 / 面板开合）后仍保持换位；
 *   - 右栏改宽后墨灵跟着变；
 *   - 取消后模板、列位、拖拽手柄全部还原；
 *   - 找不到三列外壳时直接拒绝（返回 null），不留半吊子布局。
 *
 * 找不到 Edge/Chrome 时跳过（退出码 0）。
 *
 *   node test/swap-e2e.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

let failures = 0
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean)
  return candidates.find((path) => existsSync(path)) || null
}

console.log('互换几何（headless 浏览器）')
const browser = findBrowser()
if (!browser) {
  console.log('  – 没找到 Edge/Chrome（设置 EDGE_PATH 后可启用）')
  process.exit(0)
}

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = src.indexOf('    var swapState = {')
const end = src.indexOf('    /** 图标：上下重叠的两支左右双箭头。')
if (start < 0 || end <= start) {
  bad('在 client.js 里找不到互换实现代码块')
  process.exit(1)
}
const block = src.slice(start, end)

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin:0; height:100%; }
  .frame{box-sizing:border-box;grid-template-rows:minmax(0,1fr) auto;height:100vh;display:grid;position:relative;overflow:hidden;width:100%}
  .sidebarCol{grid-area:1/1;min-width:0;overflow:hidden}
  .centerCol{flex-direction:column;grid-area:1/2;min-width:0;display:flex;overflow:hidden}
  .rightbarCol{grid-area:1/3;min-width:0;position:relative;overflow:visible}
  .session{display:contents}
  .panel{flex-direction:column;min-width:0;display:flex;position:absolute;top:0;bottom:0;right:0;overflow:clip}
  .handle{cursor:col-resize;position:absolute;top:0;bottom:0;width:8px;margin-left:-4px}
</style></head><body>
<div class="frame" id="frame" style="grid-template-columns:280px minmax(400px,1fr) minmax(0px,520px)">
  <div class="sidebarCol" id="rail"></div>
  <div class="centerCol" id="center"><div style="flex:1;display:flex"><textarea id="ta"></textarea></div></div>
  <div class="rightbarCol" id="right" data-rightbar-col>
    <div class="session">
      <div class="panel" id="panel" style="width:520px">
        <div id="moling" data-moling="1" style="width:100%;height:100%"></div>
      </div>
    </div>
  </div>
  <div class="handle" id="hRail" style="left:280px"></div>
  <div class="handle" id="hRight" style="left:1056px"></div>
</div>
<pre id="out"></pre>
<script>
var state = { swapOn: false }
window.onerror = function (m, s, l) { document.getElementById('out').textContent = 'ERROR ' + m + ' @line ' + l }
${block}
var out = []
function ok(name, cond, extra) { out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : '')) }
function box(el) { var b = el.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width } }
var lastNatural = '280px minmax(400px,1fr) minmax(0px,520px)'
function settle() { return new Promise(function (r) { setTimeout(r, 30) }) }

var frame = document.getElementById('frame')
var rail = document.getElementById('rail')
var center = document.getElementById('center')
var right = document.getElementById('right')
var moling = document.getElementById('moling')
var panel = document.getElementById('panel')
var hRight = document.getElementById('hRight')

;(async function () {
  ok('初始：三列并排', Math.round(rail.getBoundingClientRect().right) === Math.round(center.getBoundingClientRect().left))
  ok('初始：墨灵在对话框右边', box(moling).l > box(center).l)

  var started = beginSwap()
  await settle()
  ok('findSwapColumns 找到三列外壳', !!started)
  ok('互换后：墨灵在左、对话框在右', box(moling).l < box(center).l, 'moling=' + JSON.stringify(box(moling)) + ' conv=' + JSON.stringify(box(center)))
  ok('互换后：墨灵紧贴左侧栏（没有空档）', Math.round(box(moling).l) === Math.round(box(rail).r))
  ok('互换后：墨灵仍是 520 宽', Math.round(box(panel).w) === 520)
  ok('互换后：对话框拿回剩余宽度（不压成 0）', box(center).w > 600)
  ok('互换后：右栏拖拽手柄已藏', hRight.style.display === 'none')

  // 模拟 React 重写框架模板（窗口缩放 / 面板开合）→ 观察者要重排
  frame.style.gridTemplateColumns = '280px minmax(400px,1fr) minmax(0px,520px)'
  await settle()
  ok('React 重写模板后仍保持换位', box(moling).l < box(center).l, frame.style.gridTemplateColumns)

  // 右栏拖宽到 420 → 换位后的墨灵跟着变宽
  panel.style.width = '420px'
  lastNatural = '280px minmax(400px,1fr) minmax(0px,420px)'
  frame.style.gridTemplateColumns = lastNatural
  await settle()
  ok('右栏改宽后墨灵跟着变宽', Math.round(box(panel).w) === 420)
  ok('右栏改宽后仍在左侧且贴左栏', Math.round(box(moling).l) === Math.round(box(rail).r))

  // 面板被收起（宽度塌成 0）→ 不炸
  panel.style.width = '0px'
  await settle()
  ok('面板宽度 0 时不抛错', true)

  // 取消互换：布局与手柄全部还原
  panel.style.width = '520px'
  endSwap()
  await settle()
  ok('取消后：墨灵回右侧', box(moling).l > box(center).l)
  var back = getComputedStyle(frame).gridTemplateColumns.split(/\\s+/).map(parseFloat)
  ok('取消后：模板恢复成 [侧栏, 对话框, 右栏]', Math.round(back[0]) === 280 && Math.round(back[2]) === 420 && back[1] > 800, back.join(' / '))
  ok('取消后：grid-area 清空', right.style.gridArea === '' && center.style.gridArea === '')
  ok('取消后：右栏手柄恢复', hRight.style.display !== 'none')

  // 没有输入框（欢迎页 / 全局面板）时按 grid 列位认对话框列；左栏里的输入框不能骗走它
  var ta = document.getElementById('ta')
  ta.remove()
  var railProbe = document.createElement('textarea')
  rail.appendChild(railProbe)
  var byArea = beginSwap()
  await settle()
  ok('没有输入框时按 grid 1/2 认出对话框列（左栏输入框不干扰）', !!byArea && box(moling).l < box(center).l, frame.style.gridTemplateColumns)
  if (byArea) { endSwap(); await settle() }
  rail.removeChild(railProbe)

  // 外壳不成立（没有对话框列）→ 拒绝互换
  center.remove()
  var again = beginSwap()
  ok('没有对话框列 → 拒绝互换（返回 null）', again === null)
  if (again) endSwap()

  document.getElementById('out').textContent = out.join('\\n')
})().catch(function (e) { document.getElementById('out').textContent = 'THROW ' + e.message + '\\n' + out.join('\\n') })
</script></body></html>`

const dir = join(tmpdir(), 'moling-swap-e2e')
mkdirSync(dir, { recursive: true })
const htmlPath = join(dir, 'swap-e2e.html')
writeFileSync(htmlPath, page, 'utf8')

const result = spawnSync(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${join(dir, 'profile')}`, '--window-size=1600,900', '--virtual-time-budget=4000',
  '--dump-dom', 'file:///' + htmlPath.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 60000 })

const dump = String(result.stdout || '')
const i = dump.indexOf('<pre id="out">')
const j = dump.indexOf('</pre>', i)
if (i < 0 || j < 0) {
  bad('浏览器没回传结果', String(result.stderr || '').slice(0, 300))
} else {
  const lines = dump.slice(i + '<pre id="out">'.length, j).split('\n').filter(Boolean)
  for (const line of lines) {
    if (line.startsWith('PASS ')) ok(line.slice(5).split(' | ')[0], line.split(' | ')[1] || '')
    else if (line.startsWith('FAIL ')) bad(line.slice(5).split(' | ')[0], line.split(' | ')[1] || '')
    else bad(line.slice(0, 200))
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
