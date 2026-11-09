/**
 * 冒烟测试：不起 DSH，直接用假 ctx 注册工具，然后真跑一遍编译链路。
 *
 *   node test/smoke.mjs            # 注册 / 识别 / status / outline / quick / 失败路径
 *   node test/smoke.mjs --full     # 额外跑 full、中文、SyncTeX、clean
 *
 * 退出码非 0 表示失败，便于人工回归。
 * 注意：本文件含中文，别用 PowerShell 的 Get-Content/Set-Content 往返改写（会变乱码）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

console.log('6) latex_compile（失败路径：错误必须带 file:line）')
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

if (fullMode) {
  console.log('7) latex_compile（full）')
  try {
    const { value, rendered } = await call('latex_compile', { file: join(fixtures, 'hello-en.tex'), mode: 'full' })
    console.log(rendered.split('\n').slice(0, 10).map((line) => `     ${line}`).join('\n'))
    value.success ? ok('full 编译成功', `${value.passes} 趟 / ${(value.durationMs / 1000).toFixed(1)}s`) : bad('full 编译失败')
  } catch (error) {
    bad('full 编译抛错', String(error.message))
  }

  console.log('8) latex_compile（中文 / xelatex）')
  try {
    const { value, rendered } = await call('latex_compile', { file: join(fixtures, 'hello-zh.tex'), mode: 'full' })
    console.log(rendered.split('\n').slice(0, 10).map((line) => `     ${line}`).join('\n'))
    value.engine === 'xelatex' ? ok('选了 xelatex') : bad('中文文档未选 xelatex', value.engine)
    value.success ? ok('中文编译成功') : bad('中文编译失败', `${value.errors.length} 条错误`)
  } catch (error) {
    bad('中文编译抛错', String(error.message))
  }

  console.log('9) latex_synctex（forward）')
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

  console.log('10) latex_clean')
  try {
    const { value, rendered } = await call('latex_clean', { file: join(fixtures, 'hello-en.tex') })
    console.log(`     ${rendered.split('\n')[0]}`)
    ok('清理辅助文件', `${value.deleted.length} 个`)
    existsSync(join(fixtures, 'hello-en.tex')) ? ok('未误删 .tex') : bad('.tex 被删除')
  } catch (error) {
    bad('latex_clean 抛错', String(error.message))
  }

  // 中文用例与生成的 PDF 一并收尾，让 fixtures 里只剩 .tex
  for (const name of ['hello-zh.aux', 'hello-zh.log', 'hello-zh.out', 'hello-zh.synctex.gz', 'hello-zh.pdf', 'hello-en.pdf']) {
    try { rmSync(join(fixtures, name), { force: true }) } catch { /* 忽略 */ }
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
