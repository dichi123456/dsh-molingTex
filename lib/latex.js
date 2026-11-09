/**
 * LaTeX 引擎适配层 —— 由 墨灵TeX 的 electron/texlive.ts + electron/compiler.ts 移植而来。
 *
 * 与 Electron 版本的区别：
 *   1. 只依赖 node 内置模块（插件以 link: 方式安装，解析不到 profile 的 node_modules）；
 *   2. 不再使用全局 currentProcess / currentTimer，每次调用自带 AbortSignal 与超时；
 *   3. 引擎探测不再 spawn `where`，直接扫 PATH 环境变量。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

/* ------------------------------------------------------------------ *
 * 路径与进程工具
 * ------------------------------------------------------------------ */

/** Windows 下整棵进程树终结（TeX 会派生子进程，杀父进程不够）。 */
export function killProcessTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(-pid, 'SIGTERM')
    }
  } catch {
    // 进程已经退出
  }
}

/**
 * 运行一个外部命令并收集输出。
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, error:string|null, timedOut:boolean, aborted:boolean}>}
 */
export function runProcess(command, args, options = {}) {
  const { cwd, env, timeoutMs = 120000, signal, windowsHide = true } = options
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, env, windowsHide })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: String(error?.message || error), timedOut: false, aborted: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killProcessTree(child.pid) }, timeoutMs)
      : null

    const onAbort = () => { aborted = true; killProcessTree(child.pid) }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code: null, stdout, stderr, error: String(error?.message || error), timedOut, aborted })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code: code === null ? null : code, stdout, stderr, error: null, timedOut, aborted })
    })
  })
}

/* ------------------------------------------------------------------ *
 * TeX Live / MiKTeX 探测（移植自 electron/texlive.ts）
 * ------------------------------------------------------------------ */

const COMMON_PATHS = [
  'D:\\A_Professional_Program\\texlive\\2024\\bin\\windows',
  'D:\\A_Professional_Program\\texlive\\2023\\bin\\windows',
  'C:\\texlive\\2025\\bin\\windows',
  'C:\\texlive\\2025\\bin\\win32',
  'C:\\texlive\\2024\\bin\\windows',
  'C:\\texlive\\2024\\bin\\win32',
  'C:\\texlive\\2023\\bin\\windows',
  'C:\\texlive\\2023\\bin\\win32',
  'C:\\texlive\\2022\\bin\\windows',
  'C:\\texlive\\2022\\bin\\win32',
  'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
  'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\internal',
  'C:\\texlive\\2024\\bin\\x64-windows',
  'C:\\texlive\\2025\\bin\\x64-windows'
]

/** 引擎是否存在于某个 bin 目录。 */
export function hasEngine(binDir, engine = 'xelatex') {
  if (!binDir) return false
  try {
    return existsSync(join(binDir, `${engine}.exe`)) || existsSync(join(binDir, engine))
  } catch {
    return false
  }
}

/** 从 PATH 环境变量里找可执行文件，返回绝对路径。 */
export function findOnPath(engine) {
  const raw = process.env.PATH || ''
  for (const dir of raw.split(';')) {
    const trimmed = dir.trim().replace(/^"|"$/g, '')
    if (!trimmed) continue
    for (const name of [`${engine}.exe`, engine]) {
      const candidate = join(trimmed, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 扫描各盘符与用户目录下的 texlive/<year>/bin/<variant> 布局。 */
function scanTexRoots() {
  const found = []
  const roots = ['C:\\', 'D:\\', 'E:\\']
  const years = new Set(['2022', '2023', '2024', '2025', '2026'])

  for (const drive of roots) {
    if (!existsSync(drive)) continue
    try {
      const texRoot = join(drive, 'texlive')
      if (!existsSync(texRoot)) continue
      for (const year of readdirSync(texRoot, { withFileTypes: true })) {
        if (!year.isDirectory() || !years.has(year.name)) continue
        for (const binName of ['windows', 'win32', 'x64-windows']) {
          const binDir = join(texRoot, year.name, 'bin', binName)
          if (hasEngine(binDir)) found.push(binDir)
        }
      }
    } catch { /* 跳过无权限的盘符 */ }
  }

  const userData = process.env.USERPROFILE || process.env.HOME || ''
  if (userData) {
    try {
      const texRoot = join(userData, 'texlive')
      if (existsSync(texRoot)) {
        for (const year of readdirSync(texRoot, { withFileTypes: true })) {
          if (!year.isDirectory()) continue
          for (const binName of ['windows', 'win32', 'x64-windows']) {
            const binDir = join(texRoot, year.name, 'bin', binName)
            if (hasEngine(binDir)) found.push(binDir)
          }
        }
      }
    } catch { /* 跳过 */ }
  }

  return found
}

/**
 * 探测 TeX 发行版。preferredPath（插件配置 / 墨灵TeX 的 config.json）优先。
 * @returns {{found:boolean, path:string|null, engine:string|null, source:string}}
 */
export function detectTexLive(preferredPath) {
  if (preferredPath) {
    const candidates = [
      preferredPath,
      join(preferredPath, 'bin', 'windows'),
      join(preferredPath, 'bin', 'win32'),
      join(preferredPath, 'bin', 'x64-windows')
    ]
    for (const candidate of candidates) {
      if (hasEngine(candidate)) {
        return { found: true, path: candidate, engine: join(candidate, 'xelatex.exe'), source: 'config' }
      }
    }
  }

  const onPath = findOnPath('xelatex')
  if (onPath) {
    return { found: true, path: dirname(onPath), engine: onPath, source: 'PATH' }
  }

  for (const candidate of COMMON_PATHS) {
    if (hasEngine(candidate)) {
      return { found: true, path: candidate, engine: join(candidate, 'xelatex.exe'), source: 'common-path' }
    }
  }

  for (const candidate of scanTexRoots()) {
    return { found: true, path: candidate, engine: join(candidate, 'xelatex.exe'), source: 'scan' }
  }

  return { found: false, path: null, engine: null, source: 'none' }
}

/**
 * 在 TeX bin 目录（或 TeX Live 根目录）下解析某个引擎的可执行文件。
 * 没找到时返回 null，由调用方决定回退到裸命令名（走 PATH）。
 */
export function getEnginePath(texlivePath, engine) {
  if (!texlivePath) return null
  const candidates = [
    join(texlivePath, `${engine}.exe`),
    join(texlivePath, engine),
    join(texlivePath, 'bin', 'windows', `${engine}.exe`),
    join(texlivePath, 'bin', 'win32', `${engine}.exe`),
    join(texlivePath, 'bin', 'x64-windows', `${engine}.exe`)
  ]
  try {
    if (existsSync(texlivePath)) {
      for (const entry of readdirSync(texlivePath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        for (const binName of ['windows', 'win32', 'x64-windows']) {
          candidates.push(join(texlivePath, entry.name, 'bin', binName, `${engine}.exe`))
        }
      }
    }
  } catch { /* 忽略 */ }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 按文档导言区挑选引擎（IEEEtran / elsarticle / article → pdflatex，ctex → xelatex）。 */
export function pickLatexEngine(headContent, fallback = 'xelatex') {
  const head = (headContent || '').slice(0, 2500)
  if (
    /\\documentclass[^%]*\{[^}]*IEEEtran\}/i.test(head) ||
    /\\documentclass[^%]*\{[^}]*elsarticle\}/i.test(head) ||
    /\\usepackage(\[[^\]]*\])?\{elsarticle\}/i.test(head)
  ) {
    return 'pdflatex'
  }
  if (
    /\\documentclass[^%]*\{[^}]*ctex/i.test(head) ||
    /cumcmthesis/i.test(head) ||
    /\\setCJKmainfont/i.test(head) ||
    /\\usepackage(\[[^\]]*\])?\{ctex\}/i.test(head) ||
    /ctexbeamer/i.test(head)
  ) {
    return 'xelatex'
  }
  if (/\\documentclass[^%]*\{[^}]*article\}/i.test(head) || /Wiley/i.test(head)) {
    return 'pdflatex'
  }
  return fallback
}

/* ------------------------------------------------------------------ *
 * 日志解析（移植自 electron/compiler.ts 的 parseLog）
 * ------------------------------------------------------------------ */

/**
 * 匹配 -file-line-error 形式的条目。
 * 文件部分必须含路径分隔符，避免把盘符 `C:` 当成文件。
 */
function matchFileLineError(line) {
  const m = line.match(/^((?:[A-Za-z]:)?[^:\r\n]*[\\/][^:\r\n]+|\.?\/[^:\r\n]+):(\d+):\s*(.+)$/)
  if (!m) return null
  const msg = m[3].trim()
  if (!msg || /^Warning/i.test(msg)) return null
  return { file: m[1].trim(), line: Number.parseInt(m[2], 10), msg }
}

/**
 * 从 .log / stdout 中抽取错误与警告。
 * @returns {{errors:Array<{file:string|null,line:number|null,message:string}>, warnings:Array<{file:string|null,line:number|null,message:string}>}}
 */
export function parseLog(log, mainFile) {
  const errors = []
  const warnings = []
  const lines = String(log || '').split(/\r?\n/)
  let currentFile = mainFile

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 跟踪 \input 进来的子文件：(./chapters/intro.tex
    // 只认 .tex/.bib 且跳过 texmf 发行版目录：TeX 日志里宏包用 (…/iftex.sty 这种嵌套括号，
    // 若把 .sty 也当成「当前文件」，后续警告会被错误地归到宏包身上（原版 compiler.ts 的已知瑕疵）。
    const incMatch = line.match(/\((\.?\/?[^()\s]+\.(?:tex|bib))/i)
    if (incMatch && !/texmf/i.test(incMatch[1])) currentFile = incMatch[1]

    const fileErr = matchFileLineError(line)
    if (fileErr) {
      errors.push({ file: fileErr.file, line: fileErr.line, message: fileErr.msg })
      continue
    }

    // ! LaTeX Error: ...
    const latexErrMatch = line.match(/^!\s+(.+)$/)
    if (latexErrMatch) {
      let lineNum = null
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const lMatch = lines[j].match(/^l\.(\d+)/)
        if (lMatch) { lineNum = Number.parseInt(lMatch[1], 10); break }
      }
      errors.push({ file: currentFile, line: lineNum, message: latexErrMatch[1].trim() })
      continue
    }

    const pkgWarn = line.match(/^Package (.+?) Warning:\s*(.+)$/)
    if (pkgWarn) {
      warnings.push({ file: currentFile, line: null, message: `[${pkgWarn[1]}] ${pkgWarn[2].trim()}` })
      continue
    }

    const latexWarn = line.match(/^LaTeX Warning:\s*(.+)$/)
    if (latexWarn) {
      warnings.push({ file: currentFile, line: null, message: latexWarn[1].trim() })
      continue
    }

    if (/^(Overfull|Underfull) \\hbox/.test(line)) {
      warnings.push({ file: currentFile, line: null, message: line.trim() })
    }
  }

  return { errors, warnings }
}

/* ------------------------------------------------------------------ *
 * 辅助文件清理 / bibtex（移植自 electron/compiler.ts）
 * ------------------------------------------------------------------ */

const AUX_EXTENSIONS = [
  '.aux', '.log', '.out', '.toc', '.lof', '.lot',
  '.bbl', '.blg', '.fls', '.fdb_latexmk', '.synctex.gz',
  '.nav', '.snm', '.vrb', '.bcf', '.run.xml',
  '.xdv', '.dvi', '.idx', '.ilg', '.ind', '.glo', '.gls'
]

/** 删除主文件同名的一堆辅助文件，返回被删列表（相对文件名）。 */
export function cleanAuxFiles(mainPath) {
  const dir = dirname(mainPath)
  const base = basename(mainPath, extname(mainPath))
  const deleted = []
  for (const ext of AUX_EXTENSIONS) {
    const target = join(dir, `${base}${ext}`)
    try {
      if (existsSync(target)) {
        unlinkSync(target)
        deleted.push(`${base}${ext}`)
      }
    } catch { /* 被占用则忽略 */ }
  }
  return deleted
}

/** .aux 里是否出现 \bibdata（即文档真的引用了 .bib）。 */
export function auxNeedsBibtex(mainPath) {
  const auxPath = join(dirname(mainPath), `${basename(mainPath, extname(mainPath))}.aux`)
  try {
    if (!existsSync(auxPath)) return false
    return readFileSync(auxPath, 'utf8').includes('\\bibdata')
  } catch {
    return false
  }
}

/** 运行 bibtex（仅当 .aux 引用了 .bib）。 */
export async function runBibtex(mainPath, options = {}) {
  const { texlivePath = null, env, timeoutMs = 60000, signal } = options
  const dir = dirname(mainPath)
  const base = basename(mainPath, extname(mainPath))

  if (!auxNeedsBibtex(mainPath)) {
    return { ran: false, success: true, log: '[bibtex] 文档未引用 .bib，跳过' }
  }

  const command = getEnginePath(texlivePath, 'bibtex') || 'bibtex'
  const result = await runProcess(command, [base], { cwd: dir, env, timeoutMs, signal })
  const log = `${result.stdout}${result.stderr}`
  if (result.error) return { ran: true, success: false, log: `[bibtex] 启动失败: ${result.error}` }
  if (result.timedOut) return { ran: true, success: false, log: `${log}\n[bibtex] 超时` }
  return { ran: true, success: result.code === 0, log }
}

/* ------------------------------------------------------------------ *
 * 编译主流程
 * ------------------------------------------------------------------ */

/**
 * 编译一个 LaTeX 文档。
 *
 * mode:
 *   quick —— 单趟 draft 编译（图片占位，最快拿到 PDF）
 *   full  —— 完整流程：主编译 →（需要时）bibtex → 主编译 →（需要时）第三趟
 *   clean —— 先清辅助文件，再走 full
 *
 * @param {object} options
 * @param {string} options.filePath  .tex 绝对路径
 * @param {string} [options.engine]  xelatex | pdflatex | lualatex | latexmk（缺省按导言区自动挑）
 * @param {'quick'|'full'|'clean'} [options.mode]
 * @param {string|null} [options.texlivePath]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.synctex] 是否产出 .synctex.gz（默认 true）
 * @param {AbortSignal} [options.signal]
 * @param {(step:string)=>void} [options.onStep]
 */
export async function compileDocument(options) {
  const {
    filePath,
    engine: requestedEngine,
    mode = 'full',
    texlivePath = null,
    timeoutMs = 120000,
    synctex = true,
    signal,
    onStep = () => {}
  } = options

  const startedAt = Date.now()
  const dir = dirname(filePath)
  const base = basename(filePath, extname(filePath))
  const pdfPath = join(dir, `${base}.pdf`)
  const logPath = join(dir, `${base}.log`)

  if (!existsSync(filePath)) {
    return {
      success: false,
      file: filePath,
      engine: requestedEngine || 'xelatex',
      enginePath: null,
      pdfPath: null,
      logPath: null,
      exitCode: null,
      durationMs: 0,
      passes: 0,
      bibtex: null,
      cleaned: [],
      errors: [{ file: filePath, line: null, message: '源文件不存在' }],
      warnings: [],
      logTail: ''
    }
  }

  // 自动挑引擎：读导言区
  let engine = requestedEngine || ''
  if (!engine || engine === 'auto') {
    let head = ''
    try { head = readFileSync(filePath, 'utf8').slice(0, 2500) } catch { /* 读不到就用回退值 */ }
    engine = pickLatexEngine(head, 'xelatex')
  }

  const enginePath = getEnginePath(texlivePath, engine) || engine
  const env = { ...process.env }
  if (texlivePath) env.PATH = `${texlivePath};${env.PATH || ''}`

  const cleaned = mode === 'clean' ? cleanAuxFiles(filePath) : []
  const commonArgs = ['-interaction=nonstopmode', '-file-line-error', '-halt-on-error']
  if (synctex) commonArgs.push('-synctex=1')

  const passes = []
  let lastLog = ''
  let bibtex = null
  let aborted = false

  /** 跑一趟引擎，返回 runProcess 结果并刷新 lastLog。 */
  const runEngine = async (draft) => {
    let args
    if (engine === 'latexmk') {
      args = ['-pdfxe', ...commonArgs, basename(filePath)]
    } else if (draft) {
      args = [...commonArgs, `-jobname=${base}`, `\\PassOptionsToPackage{draft}{graphicx}\\input{${base}}`]
    } else {
      args = [...commonArgs, basename(filePath)]
    }
    onStep(`运行 ${engine}${draft ? '（draft）' : ''}：${enginePath} ${args.join(' ')}`)
    const result = await runProcess(enginePath, args, { cwd: dir, env, timeoutMs, signal })
    // TeX 的完整日志在 .log 里，stdout 只是节选
    try {
      if (existsSync(logPath)) lastLog = readFileSync(logPath, 'utf8')
      else lastLog = `${result.stdout}${result.stderr}`
    } catch {
      lastLog = `${result.stdout}${result.stderr}`
    }
    passes.push({ draft: Boolean(draft), code: result.code, timedOut: result.timedOut, error: result.error })
    return result
  }

  if (mode === 'quick') {
    const first = await runEngine(true)
    aborted = first.aborted
  } else {
    const first = await runEngine(false)
    aborted = first.aborted
    if (!aborted) {
      // 只有第一趟真的跑起来了才继续后续流程
      bibtex = await runBibtex(filePath, { texlivePath, env, timeoutMs, signal })
      const second = await runEngine(false)
      aborted = second.aborted
      // 交叉引用 / 参考文献编号没稳定时再补一趟
      if (!aborted && /Rerun to get|Rerun LaTeX|undefined (references|citations)|Citation .* undefined/i.test(lastLog)) {
        await runEngine(false)
      }
    }
  }

  const parsed = parseLog(lastLog, filePath)
  const lastPass = passes[passes.length - 1] || {}
  const success = !aborted && lastPass.code === 0 && existsSync(pdfPath)

  if (aborted && !parsed.errors.length) {
    parsed.errors.push({ file: filePath, line: null, message: '编译被中断（AbortSignal）' })
  }
  if (lastPass.timedOut && !parsed.errors.length) {
    parsed.errors.push({ file: filePath, line: null, message: `编译超时（超过 ${timeoutMs}ms）` })
  }
  if (lastPass.error && !parsed.errors.length) {
    parsed.errors.push({ file: null, line: null, message: `无法启动编译器（${enginePath}）：${lastPass.error}` })
  }

  return {
    success,
    file: filePath,
    engine,
    enginePath,
    pdfPath: success ? pdfPath : null,
    logPath: existsSync(logPath) ? logPath : null,
    exitCode: lastPass.code === undefined ? null : lastPass.code,
    durationMs: Date.now() - startedAt,
    passes: passes.length,
    bibtex: bibtex ? { ran: bibtex.ran, success: bibtex.success } : null,
    cleaned,
    errors: parsed.errors,
    warnings: parsed.warnings,
    logTail: lastLog
  }
}

/* ------------------------------------------------------------------ *
 * 大纲 / 结构解析
 * ------------------------------------------------------------------ */

const SECTION_COMMANDS = [
  ['\\part', 0],
  ['\\chapter', 1],
  ['\\section', 2],
  ['\\subsection', 3],
  ['\\subsubsection', 4],
  ['\\paragraph', 5]
]

/** 解析章节标题、\input/\include 依赖与 \label/\cite 数量。 */
export function parseOutline(source, filePath) {
  const lines = String(source || '').split(/\r?\n/)
  const sections = []
  const inputs = []
  let labels = 0
  let cites = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*%/.test(line)) continue

    for (const [command, level] of SECTION_COMMANDS) {
      const pattern = new RegExp(`${command.replace('\\', '\\\\')}\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}`)
      const m = line.match(pattern)
      if (m) {
        sections.push({ level, command: command.slice(1), title: m[1].trim(), line: i + 1 })
        break
      }
    }

    const inputMatch = line.match(/\\(?:input|include)\s*\{([^}]*)\}/)
    if (inputMatch) {
      const target = inputMatch[1].trim()
      inputs.push({ path: target.endsWith('.tex') ? target : `${target}.tex`, line: i + 1 })
    }

    labels += (line.match(/\\label\s*\{/g) || []).length
    cites += (line.match(/\\cite[a-zA-Z]*\s*(?:\[[^\]]*\])*\s*\{/g) || []).length
  }

  return { file: filePath, sections, inputs, labels, cites, lines: lines.length }
}

/* ------------------------------------------------------------------ *
 * 墨灵TeX 设置读取（尽力而为：读不到就用探测结果）
 * ------------------------------------------------------------------ */

/** 读取桌面版 墨灵TeX 的 config.json，复用用户已经配好的 texlivePath / engine。 */
export function readMolingConfig() {
  const appData = process.env.APPDATA
  if (!appData) return null
  const candidates = [
    join(appData, 'latex-editor', 'config.json'),
    join(appData, '墨灵TeX', 'config.json')
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return { path: candidate, config: JSON.parse(readFileSync(candidate, 'utf8')) }
      }
    } catch { /* 配置损坏则忽略 */ }
  }
  return null
}
