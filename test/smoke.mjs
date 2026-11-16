/**
 * 冒烟测试：不起 DSH，直接用假 ctx 注册工具，然后真跑一遍编译链路。
 *
 *   node test/smoke.mjs            # 注册 / 识别 / status / outline / quick / 失败路径
 *   node test/smoke.mjs --full     # 额外跑 full、中文、SyncTeX、clean
 *
 * 退出码非 0 表示失败，便于人工回归。
 * 注意：本文件含中文，别用 PowerShell 的 Get-Content/Set-Content 往返改写（会变乱码）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { pickLatexEngine } from '../lib/latex.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const fullMode = process.argv.includes('--full')

let failures = 0
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }

/** 校验返回值是否满足 output.schema 的必填键与类型（够用的轻量检查）。 */
function checkSchema(tool, value) {
  const schema = tool.output.schema
  for (const key of schema.required || []) {
    if (!Object.hasOwn(value, key)) return `缺少返回值字段 ${key}`
  }
  for (const [key, node] of Object.entries(schema.properties || {})) {
    if (!Object.hasOwn(value, key)) continue
    const actual = value[key]
    const expected = node.type
    if (!expected) continue
    const typeOk = expected === 'array'
      ? Array.isArray(actual)
      : expected === 'integer'
        ? Number.isInteger(actual)
        : expected === 'null'
          ? actual === null
          : typeof actual === (expected === 'number' ? 'number' : expected)
    if (!typeOk) return `${key} 类型不符：期望 ${expected}，得到 ${Array.isArray(actual) ? 'array' : typeof actual}`
  }
  return null
}

/** 注册工具（假 ctx：只实现 tools.register；inject 故意不激活，模拟没有 webServer 的组合）。 */
const tools = new Map()
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    }
  },
  get: () => undefined,
  on: () => () => {},
  inject: () => {}
}
apply(ctx, {})

const call = async (name, args) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`工具未注册：${name}`)
  const value = await tool.execute(args, {
    signal: new AbortController().signal,
    arguments: args,
    name
  })
  const problem = checkSchema(tool, value)
  if (problem) throw new Error(`${name} 返回不符合 output.schema：${problem}`)
  const blocks = tool.output.render(args, value)
  if (!Array.isArray(blocks) || blocks[0]?.type !== 'text') throw new Error(`${name} render 未返回文本块`)
  return { value, rendered: blocks[0].text }
}

console.log('1) 工具注册')
const expected = ['latex_compile', 'latex_status', 'latex_synctex', 'latex_clean', 'latex_outline']
for (const toolName of expected) {
  tools.has(toolName) ? ok(toolName) : bad(`${toolName} 未注册`)
}

console.log('2) 引擎自动识别')
pickLatexEngine('\\documentclass[UTF8]{ctexart}') === 'xelatex'
  ? ok('ctex → xelatex')
  : bad('ctex 未识别为 xelatex', pickLatexEngine('\\documentclass[UTF8]{ctexart}'))
pickLatexEngine('\\documentclass{article}') === 'pdflatex'
  ? ok('article → pdflatex')
  : bad('article 未识别为 pdflatex', pickLatexEngine('\\documentclass{article}'))

console.log('3) latex_status')
try {
  const { value, rendered } = await call('latex_status', {})
  console.log(rendered.split('\n').map((line) => `     ${line}`).join('\n'))
  value.found ? ok('探测到 TeX 发行版', value.binDir) : bad('未探测到 TeX 发行版')
} catch (error) {
  bad('latex_status 抛错', String(error.message))
}

console.log('4) latex_outline')
try {
  const { value, rendered } = await call('latex_outline', { file: join(fixtures, 'hello-en.tex') })
  console.log(rendered.split('\n').map((line) => `     ${line}`).join('\n'))
  value.sections.length >= 4 ? ok('解析出章节', `${value.sections.length} 条`) : bad('章节数量异常', String(value.sections.length))
} catch (error) {
  bad('latex_outline 抛错', String(error.message))
}

console.log('5) latex_compile（quick）')
try {
  const { value, rendered } = await call('latex_compile', { file: join(fixtures, 'hello-en.tex'), mode: 'quick' })
  console.log(rendered.split('\n').slice(0, 12).map((line) => `     ${line}`).join('\n'))
  if (value.success && value.pdfPath && existsSync(value.pdfPath)) ok('产出 PDF', value.pdfPath)
  else bad('quick 编译未产出 PDF', `engine=${value.engine} exit=${value.exitCode} errors=${value.errors.length}`)
  value.engine === 'pdflatex' ? ok('自动选了 pdflatex') : bad('引擎自动识别结果异常', value.engine)
} catch (error) {
  bad('latex_compile 抛错', String(error.message))
}

console.log('6) 同一份文档并发编译被串行化（面板与工具不会互相踩 aux）')
try {
  const { compileDocument } = await import('../lib/latex.js')
  const scratch = mkdtempSync(join(tmpdir(), 'latex-tools-lock-'))
  const doc = join(scratch, 'locked.tex')
  writeFileSync(doc, [
    '\\documentclass{article}',
    '\\begin{document}',
    'serialized',
    '\\end{document}',
    ''
  ].join('\n'))
  // 两趟同时发起：没排队时两个引擎会抢同一批 aux，后写的那趟读到半截文件。
  const [a, b] = await Promise.all([
    compileDocument({ filePath: doc, mode: 'quick' }),
    compileDocument({ filePath: doc, mode: 'quick' })
  ])
  a.success && b.success
    ? ok('并发两趟都编译成功（按主文件名串行）', `${(a.durationMs / 1000).toFixed(1)}s + ${(b.durationMs / 1000).toFixed(1)}s`)
    : bad('并发编译失败', `${a.success}/${b.success} ${(a.errors[0] || {}).message || ''}`)
  rmSync(scratch, { recursive: true, force: true })
} catch (error) {
  bad('并发编译抛错', String(error.message))
}

console.log('7) latex_compile（失败路径：错误必须带 file:line）')
try {
  const scratch = mkdtempSync(join(tmpdir(), 'latex-tools-smoke-'))
  const broken = join(scratch, 'broken.tex')
  writeFileSync(broken, [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Broken}',
    'This line has a deliberate error: \\undefinedcommandhere',
    '\\end{document}',
    ''
  ].join('\n'))
  const { value, rendered } = await call('latex_compile', { file: broken, mode: 'quick' })
  console.log(rendered.split('\n').slice(0, 7).map((line) => `     ${line}`).join('\n'))
  if (value.success) bad('坏文件竟然编译成功')
  else if (value.errors.some((issue) => issue.line === 4)) ok('错误带出行号', 'L4')
  else bad('错误缺少行号', JSON.stringify(value.errors))
  rmSync(scratch, { recursive: true, force: true })
} catch (error) {
  bad('失败路径抛错', String(error.message))
}

console.log('8) 工具相对路径不依赖会话 cwd（墨灵打开的项目优先）')
try {
  // 用户切到别的对话框项目时，墨灵面板仍开着 fixtures 这个项目：
  // `latex_outline({file:'hello-en.tex'})` 必须还能找到，而不是按会话 cwd 报文件不存在。
  const other = new Map()
  const otherCtx = {
    tools: { register(definition) { other.set(definition.name, definition); return () => other.delete(definition.name) } },
    get: () => undefined,
    on: () => () => {},
    inject: () => {}
  }
  apply(otherCtx, { allowedRoots: [fixtures] })
  const scratchCwd = mkdtempSync(join(tmpdir(), 'latex-tools-cwd-'))
  const exec = {
    signal: new AbortController().signal,
    arguments: { file: 'hello-en.tex' },
    name: 'latex_outline',
    agent: { session: { header: { cwd: scratchCwd } } }
  }
  const value = await other.get('latex_outline').execute({ file: 'hello-en.tex' }, exec)
  value.sections.length >= 4
    ? ok('会话 cwd 之外也能解析相对路径', `${value.sections.length} 条章节 / cwd=${scratchCwd}`)
    : bad('相对路径仍绑在会话 cwd 上', JSON.stringify(value).slice(0, 120))
  rmSync(scratchCwd, { recursive: true, force: true })
} catch (error) {
  bad('相对路径兜底抛错', String(error.message))
}

if (fullMode) {
  console.log('9) latex_compile（full）')
  try {
    const { value, rendered } = await call('latex_compile', { file: join(fixtures, 'hello-en.tex'), mode: 'full' })
    console.log(rendered.split('\n').slice(0, 10).map((line) => `     ${line}`).join('\n'))
    value.success ? ok('full 编译成功', `${value.passes} 趟 / ${(value.durationMs / 1000).toFixed(1)}s`) : bad('full 编译失败')
  } catch (error) {
    bad('full 编译抛错', String(error.message))
  }

  console.log('10) latex_compile（中文 / xelatex）')
  try {
    const { value, rendered } = await call('latex_compile', { file: join(fixtures, 'hello-zh.tex'), mode: 'full' })
    console.log(rendered.split('\n').slice(0, 10).map((line) => `     ${line}`).join('\n'))
    value.engine === 'xelatex' ? ok('选了 xelatex') : bad('中文文档未选 xelatex', value.engine)
    value.success ? ok('中文编译成功') : bad('中文编译失败', `${value.errors.length} 条错误`)
  } catch (error) {
    bad('中文编译抛错', String(error.message))
  }

  console.log('11) latex_compile（once 单趟编译）')
  try {
    // 用户 2026-11-16 要求：「新增一个只编译一次，带图的编译方式」（后去掉「带图」字样）
    // once = 一趟完整排版（不 draft，图片照常插入），不跑 bibtex、不补趟
    const { value, rendered } = await call('latex_compile', { file: join(fixtures, 'hello-en.tex'), mode: 'once' })
    console.log(rendered.split('\n').slice(0, 10).map((line) => `     ${line}`).join('\n'))
    value.success ? ok('once 编译成功', `${value.passes} 趟 / ${(value.durationMs / 1000).toFixed(1)}s`) : bad('once 编译失败')
    value.passes <= 2 ? ok('once 只排版一趟（最多多一次 PDF 后端）', `passes=${value.passes}`) : bad('once 跑了多趟', `passes=${value.passes}`)
    const noBib = !value.bibtex || value.bibtex.ran === false
    noBib ? ok('once 不跑 bibtex') : bad('once 竟然跑了 bibtex')
  } catch (error) {
    bad('once 编译抛错', String(error.message))
  }

  console.log('12) latex_synctex（forward）')
  try {
    const { value, rendered } = await call('latex_synctex', {
      direction: 'forward',
      tex: join(fixtures, 'hello-en.tex'),
      line: 20,
      pdf: join(fixtures, 'hello-en.pdf')
    })
    console.log(`     ${rendered}`)
    value.success ? ok('正向同步拿到页码', `page=${value.page}`) : bad('正向同步失败', value.error || '')
  } catch (error) {
    bad('latex_synctex 抛错', String(error.message))
  }

  console.log('13) latex_clean')
  try {
    const { value, rendered } = await call('latex_clean', { file: join(fixtures, 'hello-en.tex') })
    console.log(`     ${rendered.split('\n')[0]}`)
    ok('清理辅助文件', `${value.deleted.length} 个`)
    existsSync(join(fixtures, 'hello-en.tex')) ? ok('未误删 .tex') : bad('.tex 被删除')
  } catch (error) {
    bad('latex_clean 抛错', String(error.message))
  }

  console.log('14) 日志解析：带 file:line 的警告不能被当成错误')
  try {
    const { parseLog } = await import('../lib/latex.js')
    // -file-line-error 下警告也是「文件:行: 内容」格式，以前一律进 errors
    // → 面板报「编译失败 · N 条」而 PDF 明明成功（用户 2026-11-16 报）
    const log = [
      './main.tex:12: Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      './main.tex:274: Underfull \\hbox (badness 10000) in paragraph at lines 274--274',
      './main.tex:5: LaTeX Warning: Reference `fig1\' on page 1 undefined on input line 5.',
      './main.tex:88: ! Undefined control sequence.',
      '\\badmacro ->\\foo',
      'l.88 \\badmacro'
    ].join('\n')
    const parsed = parseLog(log, 'E:\\proj\\main.tex')
    parsed.errors.length === 1 && /Undefined control sequence/.test(parsed.errors[0].message)
      ? ok('只有真错误进 errors', `${parsed.errors.length} 条错误`)
      : bad('警告被当成错误了', JSON.stringify(parsed.errors.map((e) => e.message)))
    parsed.warnings.length === 3
      ? ok('三条警告都归到 warnings（hyperref / Underfull / LaTeX Warning）', `${parsed.warnings.length} 条`)
      : bad('警告数量不对', JSON.stringify(parsed.warnings.map((w) => w.message)))
    parsed.warnings[0].line === 12 && parsed.errors[0].line === 88
      ? ok('警告与错误都保留行号（可点击跳转）')
      : bad('行号丢了', JSON.stringify(parsed.warnings[0]))
  } catch (error) {
    bad('日志解析测试抛错', String(error.message))
  }

  console.log('15) 编译失败兜底：PDF 后端崩了要给可读原因，不能只说「编译失败」')
  try {
    const { parseLog, pdfBackendFatal, PDF_BACKEND_RETRIES } = await import('../lib/latex.js')
    // 用户 m05857 的真实症状：exit≠0、.log 里零 LaTeX 错误、只显示「编译失败」
    pdfBackendFatal('xdvipdfmx:fatal: pdf_link_obj(): passed invalid object.')
      === 'PDF 写出失败（xdvipdfmx）：pdf_link_obj(): passed invalid object.'
      ? ok('识别 xdvipdfmx fatal 并给出原文')
      : bad('xdvipdfmx fatal 没被识别', String(pdfBackendFatal('xdvipdfmx:fatal: pdf_link_obj(): passed invalid object.')))
    const noOutput = pdfBackendFatal('No output PDF file written.')
    noOutput !== null && noOutput.indexOf('No output PDF file written') >= 0
      ? ok('识别「没有生成输出文件」')
      : bad('No output PDF file written 没被识别', String(noOutput))
    pdfBackendFatal('fwrite: Broken pipe') !== null
      ? ok('识别管道中断（fwrite: Broken pipe）')
      : bad('Broken pipe 没被识别')
    pdfBackendFatal('This is just a normal log\nwith nothing wrong') === null
      ? ok('普通日志不误判为后端故障')
      : bad('普通日志被误判了')
    PDF_BACKEND_RETRIES === 2
      ? ok('自动重跑上限是 2 趟（不是死循环）')
      : bad('PDF_BACKEND_RETRIES 不是 2', String(PDF_BACKEND_RETRIES))
    // 排版本身成功、只是 PDF 后端崩：日志里确实没有 LaTeX 错误
    parseLog('xdvipdfmx:fatal: pdf_link_obj(): passed invalid object.\nNo output PDF file written.', 'E:\\proj\\main.tex').errors.length === 0
      ? ok('PDF 后端故障不会被 parseLog 误记成 LaTeX 错误（由兜底单独给原因）')
      : bad('后端故障被 parseLog 当成了 LaTeX 错误')
    const src = readFileSync(new URL('../lib/latex.js', import.meta.url), 'utf8')
    const hasFallback = src.indexOf('if (!success && !parsed.errors.length && !aborted') >= 0
    hasFallback
      ? ok('exit≠0 且无错误条目时补兜底 error')
      : bad('缺失败兜底分支')
    const hasRetry = src.indexOf('pdfRetries += 1') >= 0 && src.indexOf('while (attempt < PDF_BACKEND_RETRIES)') >= 0
    hasRetry
      ? ok('重试循环接线（attempt 计数 + 上限）')
      : bad('重试循环没接线')
    const guarded = src.indexOf('parseLog(lastLog, filePath).errors.length) break') >= 0
    guarded
      ? ok('重试只针对「没有 LaTeX 错误」的失败，真错误不重跑')
      : bad('重试条件缺「无 LaTeX 错误」保护')

    // 提速改造（m06257）：中间趟只排版不写 PDF，最后单独调一次 xdvipdfmx
    const noPdfFlag = src.indexOf("const noPdfIntermediate = engine === 'xelatex' && mode !== 'quick'") >= 0
    noPdfFlag
      ? ok('中间趟 -no-pdf 只对 xelatex 且非 quick 生效（pdflatex 不受影响）')
      : bad('缺 noPdfIntermediate 判定')
    const noPdfArgs = src.indexOf("if (noPdfIntermediate) args = ['-no-pdf', ...args]") >= 0
    noPdfArgs
      ? ok('中间趟参数真的带上 -no-pdf')
      : bad('-no-pdf 没接进 args')
    const hasBackend = src.indexOf('const runPdfBackend = async () => {') >= 0
      && src.indexOf("const args = ['-q', `${base}.xdv`]") >= 0
    hasBackend
      ? ok('最后单独调一次 xdvipdfmx 写 PDF（复用同一份 .xdv）')
      : bad('缺 runPdfBackend 或它的参数')
    const backendGuarded = src.indexOf('if (!aborted && noPdfIntermediate) {') >= 0
      && src.indexOf('const backend = await runPdfBackend()') >= 0
    backendGuarded
      ? ok('写 PDF 那一步也受 noPdfIntermediate 保护（不会对 pdflatex 跑 xdvipdfmx）')
      : bad('runPdfBackend 调用没被 noPdfIntermediate 包住')
    const typesetOnly = src.indexOf("passes.filter((item) => item.backend !== 'xdvipdfmx')") >= 0
      && src.indexOf('lastTypeset.code === undefined || lastTypeset.code === 0') >= 0
    typesetOnly
      ? ok('成败看最后一趟排版，写 PDF 那趟单独算（否则会被后端故障判死）')
      : bad('success 判定没排除 xdvipdfmx 那一趟')
    // 新增「单趟编译」模式：只跑一趟完整排版，不 draft、不跑 bibtex、不补趟
    const onceBranch = src.indexOf("} else if (mode === 'once') {") >= 0
    onceBranch
      ? ok('latex.js 有 once 分支（单趟编译）')
      : bad('缺 once 分支')
    const onceNoDraft = src.indexOf("const first = await runEngine(false)\n    aborted = first.aborted\n    if (!aborted && noPdfIntermediate) {") >= 0
    onceNoDraft
      ? ok('once 用完整排版（runEngine(false)，图片照常插入）')
      : bad('once 走了 draft 或没接 PDF 后端')
    const onceNoBib = /else if \(mode === 'once'\) \{[\s\S]{0,400}?\n  \} else \{/.test(src)
      && !/else if \(mode === 'once'\) \{[\s\S]{0,400}?runBibtex/.test(src)
    onceNoBib
      ? ok('once 不跑 bibtex（省一趟等待）')
      : bad('once 分支里跑了 bibtex')
  } catch (error) {
    bad('编译失败兜底测试抛错', String(error.message))
  }

  // 中文用例与生成的 PDF 一并收尾，让 fixtures 里只剩 .tex
  for (const name of ['hello-zh.aux', 'hello-zh.log', 'hello-zh.out', 'hello-zh.synctex.gz', 'hello-zh.pdf', 'hello-en.pdf']) {
    try { rmSync(join(fixtures, name), { force: true }) } catch { /* 忽略 */ }
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
