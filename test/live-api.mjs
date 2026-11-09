/**
 * 对「正在运行的 DSH」验证面板数据通道 /moling/api（真实 HTTP，不开浏览器）。
 *
 *   node test/live-api.mjs
 *
 * 端口取自 DSH_WEB_URL（缺省 http://127.0.0.1:19387）。逐个工作区拉一次文件树，
 * 再在包含本插件的那个工作区里跑编译 → 取 PDF → 清理，最后验一次白名单拒绝。
 * 服务没起 / 路由没挂载时跳过（退出码 0）。
 */
import { request } from 'node:http'
import { join } from 'node:path'

const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
const url = new URL('/moling/api', base)
const FIXTURE_REL = 'dsh-plugin-moling-latex/test/fixtures/hello-en.tex'

let failures = 0
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
const note = (label) => console.log(`  – ${label}`)

function call(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8')
    const req = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + '/' + endpoint,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length }
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        if (!json) { reject(new Error(`非 JSON 响应（HTTP ${res.statusCode}）：${text.slice(0, 120)}`)); return }
        if (!json.ok) { reject(new Error(json.error || '未知错误')); return }
        resolve(json.value)
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

let ping
try {
  ping = await call('ping')
} catch (error) {
  note(`连不上 ${base}/moling/api（${error.message}），跳过`)
  process.exit(0)
}
console.log(`通道 ${base}/moling/api`)
ok('ping', `默认根 ${ping.defaultRoot}`)

const workspaces = await call('workspaces')
ok('workspaces', `${workspaces.workspaces.length} 个已注册工作区`)

console.log('1) 每个工作区的文件树')
let texRoot = null
for (const workspace of workspaces.workspaces) {
  try {
    const tree = await call('tree', { root: workspace.path })
    console.log(`     ${String(tree.count).padStart(4)} 个可显示 / ${String(tree.total).padStart(4)} 个文件  ${workspace.title}`)
    if (!texRoot && tree.files.some((file) => file.rel === FIXTURE_REL)) texRoot = workspace.path
  } catch (error) {
    bad(`tree 失败：${workspace.title}`, error.message)
  }
}
texRoot ? ok('找到本插件所在工作区', texRoot) : note('没有工作区包含插件的 fixtures，跳过编译')

console.log('2) 白名单')
try {
  await call('tree', { root: process.env.TEMP || 'C:\\Windows' })
  bad('白名单外竟然通过')
} catch (error) {
  ok('白名单外被拒', error.message.slice(0, 28) + '…')
}

console.log('3) 打开单个文件（不依赖工作区里有 fixtures）')
try {
  const opened = await call('open-file', { path: join(texRoot || workspaces.defaultRoot, FIXTURE_REL) })
  opened.file.rel === 'hello-en.tex' ? ok('open-file', opened.root) : bad('open-file 返回不对')
} catch (error) {
  bad('open-file', error.message)
}

if (texRoot) {
  console.log('4) 编译 → PDF → 清理')
  try {
    const compile = await call('compile', { root: texRoot, file: FIXTURE_REL, mode: 'quick' })
    compile.success ? ok('compile', `${compile.engine} / ${(compile.durationMs / 1000).toFixed(1)}s`) : bad('编译失败', JSON.stringify(compile.errors || []).slice(0, 160))
    const pdf = await call('pdf', { root: texRoot, path: compile.pdfRel })
    const magic = Buffer.from(pdf.base64, 'base64').slice(0, 4).toString('latin1')
    magic === '%PDF' ? ok('pdf base64', `${pdf.bytes} 字节`) : bad('pdf 不是 PDF', magic)
    const clean = await call('clean', { root: texRoot, file: FIXTURE_REL })
    ok('clean', `${clean.deleted.length} 个辅助文件`)
  } catch (error) {
    bad('编译链路', error.message)
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
