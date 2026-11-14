/**
 * 宿主侧 `/moling/api` 的自测（不开 DSH、不起 HTTP）。
 *
 * 用假 req/res 直接驱动 createPanelHandler，覆盖：
 *   探活 / TeX 状态 / 工作区 / 文件树（嵌套 + 扁平）/ 白名单拒绝 / 路径越界 /
 *   读文件 / 写文件 / 非文本拒绝 / 编译 / PDF base64 / PDF 元信息 / 单页栅格化 /
 *   清理 / 显式打开目录（open-root）/ 按绝对路径打开文件（open-file）/ 未知端点 / 坏 JSON /
 *   模板库（templates 清单 / use-template 落地含二进制与重名换目录）
 *
 *   node test/server-smoke.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  // 提纲：解析章节标题与行号（面板左下角浮层用）
  const outline = await call('POST', 'outline', { root: fixtures, file: 'hello-en.tex' })
  const sections = outline.json && outline.json.ok ? outline.json.value.sections : null
  const intro = Array.isArray(sections) ? sections.find((item) => item.title === 'Introduction') : null
  intro && intro.line === 12 && sections.some((item) => item.title === 'A nested heading')
    ? ok('outline 解析章节', `${sections.length} 节，Introduction 在第 ${intro.line} 行`)
    : bad('outline', JSON.stringify(outline.json).slice(0, 160))

  const notTex = await call('POST', 'outline', { root: fixtures, path: 'evil.exe', file: 'evil.exe' })
  notTex.status >= 400 ? ok('outline 拒绝非 tex') : bad('outline 非 tex 未拒')
}

console.log('5) 编译 → PDF → 清理')
{
  const compile = await call('POST', 'compile', { root: fixtures, file: 'hello-en.tex', mode: 'quick' })
  if (!compile.json || !compile.json.ok) bad('compile', JSON.stringify(compile.json).slice(0, 160))
  else if (!compile.json.value.success) bad('编译未成功', JSON.stringify(compile.json.value.errors || []).slice(0, 160))
  else {
    const value = compile.json.value
    ok('compile', `${value.engine} / ${(value.durationMs / 1000).toFixed(1)}s`)

    // 编译辅助文件也要出现在文件树里（之前只认 .tex/.bib/.md/.pdf，用户以为插件失灵）
    const auxTree = await call('POST', 'tree', { root: fixtures })
    const auxList = auxTree.json && auxTree.json.ok ? auxTree.json.value.files.map((file) => file.rel) : []
    auxList.includes('hello-en.aux') && auxList.includes('hello-en.log')
      ? ok('编译辅助文件进树（.aux / .log）', auxList.filter((rel) => /\.(aux|log|toc|out)$/.test(rel)).join(',') || auxList.length + ' 个文件')
      : bad('辅助文件没进树', auxList.join(',').slice(0, 140))
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

    // SyncTeX：源码行 → PDF 坐标 → 再反查回源码行（面板的双向定位走这两个方向）
    const forward = await call('POST', 'synctex', {
      direction: 'forward', root: fixtures, file: 'hello-en.tex', pdf: value.pdfRel, line: 6
    })
    const forwardValue = forward.json && forward.json.ok ? forward.json.value : null
    forwardValue && forwardValue.success && forwardValue.page >= 1
      ? ok('synctex 正向', `第 6 行 → 第 ${forwardValue.page} 页 (${forwardValue.x}, ${forwardValue.y})`)
      : bad('synctex 正向', JSON.stringify(forward.json).slice(0, 160))

    if (forwardValue && forwardValue.success) {
      const backward = await call('POST', 'synctex', {
        direction: 'backward', root: fixtures, file: 'hello-en.tex', pdf: value.pdfRel,
        page: forwardValue.page, x: forwardValue.x, y: forwardValue.y
      })
      const backwardValue = backward.json && backward.json.ok ? backward.json.value : null
      backwardValue && backwardValue.success && backwardValue.line >= 1
        ? ok('synctex 反向', `第 ${forwardValue.page} 页 → 源码第 ${backwardValue.line} 行`)
        : bad('synctex 反向', JSON.stringify(backward.json).slice(0, 160))
    }

    const noPdf = await call('POST', 'synctex', {
      direction: 'forward', root: fixtures, file: 'hello-en.tex', pdf: 'missing.pdf', line: 1
    })
    noPdf.status >= 400 && noPdf.json && noPdf.json.ok === false ? ok('缺 PDF 时明确报错') : bad('缺 PDF 未报错')
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

console.log('9) 外部改动探测 stat（大模型改文件 → 面板自动刷新）')
{
  const dir = mkdtempSync(join(tmpdir(), 'moling-stat-'))
  writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}\n')
  await call('POST', 'open-root', { root: dir })

  const probe = () => call('POST', 'stat', { root: dir, paths: ['main.tex', 'gone.tex'] })

  const first = await probe()
  if (!first.json || !first.json.ok) bad('stat', JSON.stringify(first.json))
  else {
    const value = first.json.value
    const entry = value.entries['main.tex']
    entry && entry.exists && entry.size > 0 && entry.mtime > 0
      ? ok('stat 给出版本戳', `mtime=${entry.mtime} size=${entry.size}`)
      : bad('stat entries', JSON.stringify(value.entries))
    value.entries['gone.tex'] && value.entries['gone.tex'].exists === false
      ? ok('不存在的路径回 exists:false（不掀翻整轮）')
      : bad('缺文件没兜住', JSON.stringify(value.entries['gone.tex']))
    const dirsOk = /^[0-9a-f]{20}$/.test(value.dirs || '')
    dirsOk
      ? ok('目录指纹是短哈希', value.dirs)
      : bad('dirs 指纹不对', String(value.dirs))
  }
  const dirsBefore = first.json && first.json.ok ? first.json.value.dirs : ''

  // 越界路径不该把整轮轮询掀翻（面板每 2 秒打一次，不能因为一个坏路径 500）
  const outside = await call('POST', 'stat', { root: dir, paths: ['../../Windows/win.ini'] })
  outside.json && outside.json.ok && outside.json.value.entries['../../Windows/win.ini'].exists === false
    ? ok('越界路径回 exists:false（不抛错）')
    : bad('越界 stat', JSON.stringify(outside.json).slice(0, 160))

  // 改内容：版本戳变，但目录指纹不变 → 只刷新编辑区，不白刷文件树
  writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}\n% 大模型补的一段\n')
  const edited = await probe()
  const editedValue = edited.json && edited.json.ok ? edited.json.value : null
  editedValue && editedValue.entries['main.tex'].size > 30 && editedValue.dirs === dirsBefore
    ? ok('内容改动 → 版本戳变、目录指纹不变')
    : bad('内容改动判定不对', JSON.stringify(editedValue && editedValue.entries['main.tex']))

  // 新建文件：父目录 mtime 变 → 指纹变（文件树要重拉）
  writeFileSync(join(dir, 'new-one.tex'), 'x')
  const added = await probe()
  const addedDirs = added.json && added.json.ok ? added.json.value.dirs : ''
  addedDirs && addedDirs !== dirsBefore
    ? ok('新建文件 → 目录指纹变（文件树会重拉）')
    : bad('新建文件指纹没变', `${dirsBefore} → ${addedDirs}`)

  // 删掉：又变一次
  rmSync(join(dir, 'new-one.tex'), { force: true })
  const removed = await probe()
  removed.json && removed.json.ok && removed.json.value.dirs !== addedDirs
    ? ok('删除文件 → 指纹再变')
    : bad('删除后指纹没变', String(removed.json && removed.json.value.dirs))

  // 不传 paths（只想看文件树变没变）也得能跑
  const bare = await call('POST', 'stat', { root: dir })
  bare.json && bare.json.ok && /^[0-9a-f]{20}$/.test(bare.json.value.dirs || '')
    ? ok('不传 paths 也能跑（只回目录指纹）')
    : bad('缺 paths 报错', JSON.stringify(bare.json).slice(0, 160))

  rmSync(dir, { recursive: true, force: true })
}

console.log('10) 模板库（templates / use-template）')
{
  const list = await call('POST', 'templates', {})
  const value = list.json && list.json.ok ? list.json.value : null
  if (!value) bad('templates', JSON.stringify(list.json).slice(0, 200))
  else {
    const items = value.templates || []
    items.length >= 20
      ? ok('模板清单条目数', `${items.length} 个`)
      : bad('模板清单太少', String(items.length))
    Array.isArray(value.categories) && value.categories.length === 5
      ? ok('分类是 5 个', value.categories.join(' / '))
      : bad('分类不对', JSON.stringify(value.categories))
    const cumcm = items.find((item) => item.id === 'cumcm')
    cumcm && cumcm.files >= 9 && cumcm.bytes > 400000 && cumcm.main === 'main.tex'
      ? ok('cumcm 带 cls/sty/图片（不是只有主文件）', `${cumcm.files} 文件 / ${Math.round(cumcm.bytes / 1024)} KB`)
      : bad('cumcm 元数据不对', JSON.stringify(cumcm))
    // 清单只回元数据：内容（tex 正文）绝不能出现在这里，否则首屏就背 1.1 MB
    items.every((item) => typeof item.bytes === 'number' && !('content' in item) && !('files' in item && Array.isArray(item.files)))
      ? ok('清单只回元数据（不含正文/文件列表）')
      : bad('清单混进了正文')
  }

  // 落地到空目录：主文件 + 附属文件都要真写下去
  const dir = mkdtempSync(join(tmpdir(), 'moling-tpl-'))
  await call('POST', 'open-root', { root: dir })
  const used = await call('POST', 'use-template', { root: dir, template: 'cumcm' })
  const usedValue = used.json && used.json.ok ? used.json.value : null
  if (!usedValue) bad('use-template', JSON.stringify(used.json).slice(0, 200))
  else {
    const target = usedValue.root
    existsSync(join(target, 'main.tex')) && existsSync(join(target, 'cumcmthesis.cls')) && existsSync(join(target, 'figures', 'cat.pdf'))
      ? ok('落地主文件 + cls + 子目录图片', target.replace(dir, '.'))
      : bad('落地文件不全', String(target))
    const main = existsSync(join(target, 'main.tex')) ? readFileSync(join(target, 'main.tex'), 'utf8') : ''
    const mainBytes = Buffer.byteLength(main, 'utf8')
    main.includes('cumcmthesis') && mainBytes > 20000
      ? ok('主文件内容是真模板（不是空骨架）', `${mainBytes} 字节`)
      : bad('主文件内容不对', String(mainBytes))
    const png = existsSync(join(target, 'figures', 'upload.png')) ? readFileSync(join(target, 'figures', 'upload.png')) : null
    png && png.length === 230780 && png[0] === 0x89 && png[1] === 0x50
      ? ok('二进制图片按字节落地（没被当文本转码）', `${png.length} 字节`)
      : bad('图片落地损坏', png ? `${png.length} 字节` : '缺失')
    usedValue.main === 'main.tex' && usedValue.template && usedValue.template.engine === 'xelatex'
      ? ok('返回落地信息（main / engine）', usedValue.template.engine)
      : bad('返回结构不对', JSON.stringify(usedValue.template))
  }

  // 同一目录再落一次：目录已经非空 → 改落 <root>/cumcm，绝不把模板散进已有项目
  const again = await call('POST', 'use-template', { root: dir, template: 'cumcm' })
  const againValue = again.json && again.json.ok ? again.json.value : null
  againValue && againValue.root !== (usedValue && usedValue.root) && againValue.root === join(dir, 'cumcm')
    ? ok('非空目录换子目录，不往已有项目里散模板文件', againValue.root.replace(dir, '.'))
    : bad('非空目录没换子目录', String(againValue && againValue.root))

  // 再落第三次：cumcm 子目录也占了 → 递增到 cumcm-2（不互相覆盖）
  const again2 = await call('POST', 'use-template', { root: dir, template: 'cumcm' })
  const again2Value = again2.json && again2.json.ok ? again2.json.value : null
  again2Value && again2Value.root === join(dir, 'cumcm-2')
    ? ok('同名目录占满后递增到 -2', again2Value.root.replace(dir, '.'))
    : bad('递增目录名不对', String(again2Value && again2Value.root))

  // 目标目录里已有 main.tex（手工建的项目）→ 也必须换目录，而不是把别人的 main.tex 冲掉
  writeFileSync(join(dir, 'main.tex'), '% 我自己的主文件\n')
  const third = await call('POST', 'use-template', { root: dir, template: 'zh-article' })
  const thirdValue = third.json && third.json.ok ? third.json.value : null
  thirdValue && thirdValue.root !== dir && readFileSync(join(dir, 'main.tex'), 'utf8').includes('我自己的主文件')
    ? ok('不碰用户已有的 main.tex', thirdValue.root.replace(dir, '.'))
    : bad('冲掉了已有 main.tex', String(thirdValue && thirdValue.root))

  // 目录非空但**没有 main.tex**（例如只有笔记/图片）→ 同样换子目录，
  // 否则 cls/sty/figures 会散在用户目录根上（真实踩过的坑）
  const mixed = mkdtempSync(join(tmpdir(), 'moling-tpl-mixed-'))
  writeFileSync(join(mixed, 'notes.md'), '# 我自己的笔记\n')
  await call('POST', 'open-root', { root: mixed })
  const mixedUsed = await call('POST', 'use-template', { root: mixed, template: 'zh-article' })
  const mixedValue = mixedUsed.json && mixedUsed.json.ok ? mixedUsed.json.value : null
  mixedValue && mixedValue.root === join(mixed, 'zh-article') && existsSync(join(mixed, 'notes.md'))
    ? ok('目录非空（无 main.tex）也落子目录，不动原有文件', mixedValue.root.replace(mixed, '.'))
    : bad('非空目录被模板污染', String(mixedValue && mixedValue.root))
  rmSync(mixed, { recursive: true, force: true })

  // 空目录（用户明确新建的空文件夹）→ 直接落进去，不多套一层
  const emptyDir = mkdtempSync(join(tmpdir(), 'moling-tpl-empty-'))
  await call('POST', 'open-root', { root: emptyDir })
  const emptyUsed = await call('POST', 'use-template', { root: emptyDir, template: 'zh-article' })
  const emptyValue = emptyUsed.json && emptyUsed.json.ok ? emptyUsed.json.value : null
  emptyValue && emptyValue.root === emptyDir
    ? ok('空目录直接落地（不多套一层子目录）')
    : bad('空目录被多套了一层', String(emptyValue && emptyValue.root))
  rmSync(emptyDir, { recursive: true, force: true })

  // 未知模板 / 空模板 id：明确报错，不静默成功
  const unknown = await call('POST', 'use-template', { root: dir, template: 'no-such-template' })
  unknown.json && unknown.json.ok === false && /没有这个模板/.test(unknown.json.error)
    ? ok('未知模板明确报错')
    : bad('未知模板没报错', JSON.stringify(unknown.json).slice(0, 160))
  const empty = await call('POST', 'use-template', { root: dir })
  empty.json && empty.json.ok === false
    ? ok('缺 template 参数报错')
    : bad('缺参数没报错', JSON.stringify(empty.json).slice(0, 160))

  // 白名单外的 root 必须被挡（模板端点同样不能绕开 allowedRoots）
  const outside = await call('POST', 'use-template', { root: join(tmpdir(), 'moling-tpl-outside'), template: 'zh-article' })
  outside.json && outside.json.ok === false
    ? ok('白名单外的 root 被挡')
    : bad('越界 root 没挡住', JSON.stringify(outside.json).slice(0, 160))

  rmSync(dir, { recursive: true, force: true })
}

// 收尾
for (const name of ['api-write.tex', 'hello-en.pdf', 'hello-en.aux', 'hello-en.log', 'hello-en.out', 'hello-en.synctex.gz']) {
  try { rmSync(join(fixtures, name), { force: true }) } catch { /* 忽略 */ }
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
