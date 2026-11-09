/**
 * 宿主侧 `/moling/api` 的自测（不开 DSH、不起 HTTP）。
 *
 * 用假 req/res 直接驱动 createPanelHandler，覆盖：
 *   探活 / TeX 状态 / 工作区 / 文件树（嵌套 + 扁平）/ 白名单拒绝 / 路径越界 /
 *   读文件 / 写文件 / 非文本拒绝 / 编译 / PDF base64 / PDF 元信息 / 单页栅格化 /
 *   清理 / 显式打开目录（open-root）/ 按绝对路径打开文件（open-file）/ 未知端点 / 坏 JSON
 *
 *   node test/server-smoke.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { API_PREFIX, createPanelHandler } from '../lib/server.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')

let failures = 0
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }

const handler = createPanelHandler({
  getConfig: () => ({ allowedRoots: [fixtures] }),
  getWorkspaces: () => [],
  getTexEnv: () => ({ texlivePath: null, engine: 'auto', timeoutMs: 120000 })
})

/** 发一个假请求；返回 { status, json, raw, bytes, type }。raw 用于故意发坏 JSON。 */
async function call(method, endpoint, body, raw) {
  const payload = raw !== undefined ? Buffer.from(String(raw), 'utf8')
    : body === undefined ? Buffer.from('', 'utf8') : Buffer.from(JSON.stringify(body), 'utf8')
  const req = Readable.from(payload.length > 0 ? [payload] : [])
  req.method = method
  req.url = API_PREFIX + '/' + endpoint

  const captured = { status: 0, chunks: [], type: '' }
  const res = {
    writeHead(status, headers) {
      captured.status = status
      captured.type = (headers && (headers['content-type'] || headers['Content-Type'])) || ''
    },
    end(chunk) { if (chunk !== undefined) captured.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')) }
  }
  await handler(req, res)
  const bytes = Buffer.concat(captured.chunks)
  const text = bytes.toString('utf8')
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: captured.status, json, raw: text, bytes, type: captured.type }
}

console.log('1) 探活 / 状态 / 工作区')
{
  const get = await call('GET', 'ping')
  get.status === 200 && get.json.ok && get.json.value.api === API_PREFIX
    ? ok('GET ping', get.json.value.api)
    : bad('GET ping', JSON.stringify(get.json))

  const post = await call('POST', 'ping', {})
  post.json && post.json.ok ? ok('POST ping') : bad('POST ping', JSON.stringify(post.json))

  const status = await call('POST', 'status', {})
  status.json && status.json.ok && typeof status.json.value.found === 'boolean'
    ? ok('status', status.json.value.found ? status.json.value.binDir : '未找到 TeX')
    : bad('status', JSON.stringify(status.json))

  const workspaces = await call('POST', 'workspaces', {})
  workspaces.json && workspaces.json.ok && Array.isArray(workspaces.json.value.workspaces)
    ? ok('workspaces', `${workspaces.json.value.workspaces.length} 项`)
    : bad('workspaces', JSON.stringify(workspaces.json))
}

console.log('2) 文件树')
{
  const tree = await call('POST', 'tree', { root: fixtures })
  if (!tree.json || !tree.json.ok) bad('tree', JSON.stringify(tree.json))
  else {
    const value = tree.json.value
    value.tree && Array.isArray(value.files)
      ? ok('tree 同时给嵌套树与扁平表', `${value.count} 个文件 / 顶层 ${value.tree.children.length} 项 / skipped ${value.skipped}`)
      : bad('tree 结构不对', JSON.stringify(Object.keys(value)))
  }
}

console.log('3) 白名单与越界')
{
  const outside = await call('POST', 'tree', { root: process.env.TEMP || 'C:\\Windows' })
  outside.status === 400 && outside.json && outside.json.ok === false ? ok('白名单外被拒', outside.json.error.slice(0, 24) + '…') : bad('白名单', JSON.stringify(outside.json))

  const traverse = await call('POST', 'read-file', { root: fixtures, path: '../../../etc/hosts' })
  traverse.status === 400 && traverse.json.ok === false ? ok('路径越界被拒') : bad('越界未被拒', JSON.stringify(traverse.json))
}

console.log('4) 读写文件')
{
  const read = await call('POST', 'read-file', { root: fixtures, path: 'hello-en.tex' })
  read.json && read.json.ok && read.json.value.text.includes('\\documentclass') ? ok('read-file') : bad('read-file', JSON.stringify(read.json).slice(0, 120))

  const write = await call('POST', 'write-file', { root: fixtures, path: 'api-write.tex', content: '% api\n' })
  write.json && write.json.ok && existsSync(join(fixtures, 'api-write.tex')) ? ok('write-file', `${write.json.value.bytes} 字节`) : bad('write-file', JSON.stringify(write.json))

  const back = await call('POST', 'read-file', { root: fixtures, path: 'api-write.tex' })
  back.json && back.json.value.text === '% api\n' ? ok('写回内容一致') : bad('写回内容不一致')

  const reject = await call('POST', 'write-file', { root: fixtures, path: 'evil.exe', content: 'x' })
  reject.json && reject.json.ok === false ? ok('拒绝写非文本类型') : bad('非文本写入未被拒')
}

console.log('5) 编译 → PDF → 清理')
{
  const compile = await call('POST', 'compile', { root: fixtures, file: 'hello-en.tex', mode: 'quick' })
  if (!compile.json || !compile.json.ok) bad('compile', JSON.stringify(compile.json).slice(0, 160))
  else if (!compile.json.value.success) bad('编译未成功', JSON.stringify(compile.json.value.errors || []).slice(0, 160))
  else {
    const value = compile.json.value
    ok('compile', `${value.engine} / ${(value.durationMs / 1000).toFixed(1)}s`)
    const pdf = await call('POST', 'pdf', { root: fixtures, path: value.pdfRel })
    const magic = pdf.json && pdf.json.ok ? Buffer.from(pdf.json.value.base64, 'base64').slice(0, 4).toString('latin1') : ''
    magic === '%PDF' ? ok('pdf 返回 base64', `${pdf.json.value.bytes} 字节`) : bad('pdf', JSON.stringify(pdf.json).slice(0, 120))

    // 元信息模式：面板走图片预览时只要页数 + mtime，不要整份 base64
    const meta = await call('POST', 'pdf', { root: fixtures, path: value.pdfRel, meta: true })
    if (!meta.json || !meta.json.ok) bad('pdf meta', JSON.stringify(meta.json).slice(0, 160))
    else {
      const info = meta.json.value
      info.pages >= 1 && !('base64' in info)
        ? ok('pdf meta 只回元信息', `${info.pages} 页 / raster=${info.raster}`)
        : bad('pdf meta 内容不对', JSON.stringify(Object.keys(info)))
    }

    // 单页栅格化：GET + 二进制 PNG；dpi 越低字节越少（这就是"降分辨率"的实际效果）
    const query = `?root=${encodeURIComponent(fixtures)}&path=${encodeURIComponent(value.pdfRel)}&page=1`
    const low = await call('GET', 'pdf-page' + query + '&dpi=48')
    const high = await call('GET', 'pdf-page' + query + '&dpi=144')
    const png = low.bytes.slice(0, 4).toString('latin1') === '\x89PNG'
    png && low.type.startsWith('image/png')
      ? ok('pdf-page 返回 PNG', `48dpi ${low.bytes.length} 字节 / 144dpi ${high.bytes.length} 字节`)
      : bad('pdf-page', `type=${low.type} magic=${low.bytes.slice(0, 4).toString('hex')}`)
    low.bytes.length > 0 && low.bytes.length < high.bytes.length
      ? ok('低 dpi 图更小', `${Math.round(low.bytes.length / high.bytes.length * 100)}%`)
      : bad('dpi 没影响体积', `${low.bytes.length} vs ${high.bytes.length}`)

    const sameAgain = await call('GET', 'pdf-page' + query + '&dpi=48')
    sameAgain.bytes.equals(low.bytes) ? ok('同参数命中缓存且结果一致') : bad('缓存结果不一致')

    const wrongPage = await call('GET', 'pdf-page' + query.replace('page=1', 'page=999'))
    wrongPage.status >= 400 && wrongPage.json && wrongPage.json.ok === false ? ok('不存在的页报错') : bad('越界页码未报错', String(wrongPage.status))
  }
  const clean = await call('POST', 'clean', { root: fixtures, file: 'hello-en.tex' })
  clean.json && clean.json.ok && Array.isArray(clean.json.value.deleted) ? ok('clean', `${clean.json.value.deleted.length} 个`) : bad('clean', JSON.stringify(clean.json))
}

console.log('6) 显式打开目录 / 按绝对路径打开文件')
{
  const imported = mkdtempSync(join(tmpdir(), 'moling-api-'))
  writeFileSync(join(imported, 'paper.tex'), '\\documentclass{article}\n\\begin{document}x\\end{document}\n')
  writeFileSync(join(imported, 'figures.png'), 'not-a-png')

  const before = await call('POST', 'tree', { root: imported })
  before.json && before.json.ok === false ? ok('未登记前被白名单拒绝') : bad('未登记前竟然通过', String(before.status))

  const opened = await call('POST', 'open-root', { root: imported })
  opened.json && opened.json.ok && opened.json.value.root === imported ? ok('open-root 登记成功') : bad('open-root', JSON.stringify(opened.json))

  const after = await call('POST', 'tree', { root: imported })
  if (!after.json || !after.json.ok) bad('登记后仍读不到', JSON.stringify(after.json))
  else {
    after.json.value.files.some((file) => file.rel === 'paper.tex') ? ok('登记后列出文件', `total=${after.json.value.total} skipped=${after.json.value.skipped}`) : bad('没列出 paper.tex')
    after.json.value.skipped === 1 ? ok('统计出不可显示文件') : bad('skipped 不对', String(after.json.value.skipped))
  }

  // 另一个未登记的目录里，用绝对路径直接打开单个文件
  const stray = mkdtempSync(join(tmpdir(), 'moling-file-'))
  writeFileSync(join(stray, 'solo.tex'), '\\documentclass{article}\n')
  const openedFile = await call('POST', 'open-file', { path: join(stray, 'solo.tex') })
  if (!openedFile.json || !openedFile.json.ok) bad('open-file', JSON.stringify(openedFile.json))
  else {
    openedFile.json.value.file.rel === 'solo.tex' && openedFile.json.value.file.text.includes('documentclass')
      ? ok('open-file 直接打开单个文件', openedFile.json.value.root)
      : bad('open-file 内容不对')
  }

  rmSync(imported, { recursive: true, force: true })
  rmSync(stray, { recursive: true, force: true })
}

console.log('7) 编辑器内核资源（asset 端点）')
{
  const js = await call('GET', 'asset?name=cm6.js')
  const body = js.bytes.toString('utf8')
  js.status === 200 && js.type.startsWith('application/javascript') && body.includes('__molingCM')
    ? ok('asset 发出编辑器内核', `${Math.round(js.bytes.length / 1024)} KB`)
    : bad('asset', `status=${js.status} type=${js.type} len=${js.bytes.length}`)

  const traversal = await call('GET', 'asset?name=../package.json')
  traversal.status === 400 ? ok('拒绝越界资源名') : bad('越界资源名未被拒', String(traversal.status))

  const missing = await call('GET', 'asset?name=nope.js')
  missing.status === 400 && missing.json && missing.json.ok === false ? ok('不存在的资源报错') : bad('缺资源未报错')
}

console.log('8) 错误处理')
{
  const unknown = await call('POST', 'nope', {})
  unknown.status === 404 && unknown.json.ok === false ? ok('未知端点 404') : bad('未知端点', String(unknown.status))

  const broken = await call('POST', 'compile', undefined, '{"root": 不是 JSON')
  broken.status === 400 && broken.json && /不是合法 JSON/.test(broken.json.error) ? ok('坏 JSON 明确报错') : bad('坏 JSON', JSON.stringify(broken.json))
}

// 收尾
for (const name of ['api-write.tex', 'hello-en.pdf', 'hello-en.aux', 'hello-en.log', 'hello-en.out', 'hello-en.synctex.gz']) {
  try { rmSync(join(fixtures, name), { force: true }) } catch { /* 忽略 */ }
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
