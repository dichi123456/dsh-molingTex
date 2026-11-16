/**
 * LaTeX 引擎适配层 —— 由 墨灵TeX 的 electron/texlive.ts + electron/compiler.ts 移植而来。
 *
 * 与 Electron 版本的区别：
 *   1. 只依赖 node 内置模块（插件以 link: 方式安装，解析不到 profile 的 node_modules）；
 *   2. 不再使用全局 currentProcess / currentTimer，每次调用自带 AbortSignal 与超时；
 *   3. 引擎探测不再 spawn `where`，直接扫 PATH 环境变量。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
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
 * 带 -file-line-error 时，**警告也会**写成 `./main.tex:274: Package hyperref Warning: …`
 * 或 `./main.tex:274: Underfull \hbox …`，与错误的格式一模一样。
 * 以前只挡了 `^Warning`，于是这两类全被算成错误 → 面板报「编译失败 · 2 条」
 * 而 PDF 明明生成成功（用户 2026-11-16 报的就是这个）。
 */
function isWarningMessage(msg) {
  return /^(?:Package|Class|LaTeX|Module|Font)\s+\S*\s*Warning:/i.test(msg)
    || /^LaTeX (?:Font )?Warning:/i.test(msg)
    || /^(?:Overfull|Underfull) \\[hv]box/i.test(msg)
    || /^Missing character:/i.test(msg)
    || /Token not allowed in a PDF string/i.test(msg)
}

/**
 * TeX Live 2024 的 xdvipdfmx 有个随机缺陷：写 PDF 时会抛
 * `xdvipdfmx:fatal: pdf_link_obj(): passed invalid object.`，随后
 * `No output PDF file written.`，xelatex 以 exit≠0 结束，但 .log 里
 * **一条 LaTeX 错误都没有**（排版本身是成功的，.xdv 也正常产出）。
 *
 * 实测（用户 m05857 的答辩 beamer，TeX Live 2024 / xdvipdfmx 20240407）：
 * 同一份 .xdv 连跑 6 次 xdvipdfmx → 1 成功 5 失败；换新目录、去掉 synctex
 * 都一样；12 张插图单独编译各 4 次 0 失败。所以只能靠**重试**，不能靠
 * 「换个写法」修掉。
 *
 * 返回可读原因（有就说明是这一类故障），否则 null。
 */
export function pdfBackendFatal(log) {
  const text = String(log || '')
  const fatal = text.match(/xdvipdfmx:fatal:\s*(.+)/)
  if (fatal) return `PDF 写出失败（xdvipdfmx）：${fatal[1].trim()}`
  if (/No output PDF file written/.test(text)) return 'PDF 写出失败：没有生成输出文件（No output PDF file written）'
  if (/fwrite: Broken pipe/i.test(text)) return 'PDF 写出失败：编译进程管道中断（fwrite: Broken pipe）'
  return null
}

/** 同一个 PDF 后端偶发失败最多自动重跑几趟（每趟都是完整重排，别给太多）。 */
export const PDF_BACKEND_RETRIES = 2

/* ------------------------------------------------------------------ *
 * 插图净化：把带对象流的 PDF 图重写成扁平结构
 * ------------------------------------------------------------------ */

/**
 * 为什么需要这一步（实测结论，别当玄学）：
 *
 * `pdf_link_obj(): passed invalid object.` 不是随机故障，是**某几张插图**触发的。
 * 真项目 25 张 `\includegraphics` 里有 6 张是 PDF 1.5 对象流（`/ObjStm` + `/Type /XRef`），
 * 只把这 6 张用 `pdftocairo -pdf` 重写（矢量保真，逐像素差异只在抗锯齿级别），
 * 同一份 .xdv 连跑 15 次从 8/15 变成 15/15；不重写的话连跑 20 次还会挂 5 次。
 *
 * 重写结果按「绝对路径 + mtime + 体积」缓存在临时目录，改图才会重算，
 * 不往用户项目里写任何文件。图没变时后续编译只多一次拷贝。
 */
const FIGURE_CACHE_DIR = join(tmpdir(), 'dsh-moling-figcache')

/** 只认 `\includegraphics`（含带星号与可选参数的形式）。 */
const GRAPHICS_RE = /\\includegraphics\*?(?:\[[^\]]*\])?\{([^}]+)\}/g

/**
 * 收集主文件（及其 `\input` / `\include` 的本地子文件）里引用的图片路径。
 * 解析不到的图一律跳过 —— 宁可不重写，也不猜路径。
 */
function collectGraphicRefs(texPath) {
  const refs = []
  const seen = new Set()
  const queue = [texPath]
  while (queue.length && refs.length < 500) {
    const current = queue.shift()
    const key = current.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    let text = ''
    try {
      if (statSync(current).size > 4 * 1024 * 1024) continue
      text = readFileSync(current, 'utf8')
    } catch { continue }
    let match
    GRAPHICS_RE.lastIndex = 0
    while ((match = GRAPHICS_RE.exec(text))) {
      const ref = match[1].trim()
      if (ref && !refs.includes(ref)) refs.push(ref)
    }
    // 子文件（\input{x} / \include{x}，可省略 .tex）
    const inputRe = /\\(?:input|include)\{([^}]+)\}/g
    while ((match = inputRe.exec(text))) {
      const rel = match[1].trim()
      const candidates = [rel, `${rel}.tex`].map((name) => join(dirname(current), name))
      for (const candidate of candidates) {
        if (existsSync(candidate)) { queue.push(candidate); break }
      }
    }
  }
  return refs
}

/** 这份 PDF 里有没有对象流 / 交叉引用流（xdvipdfmx 就是在这类结构上翻车的）。 */
export function pdfHasObjectStream(fullPath) {
  try {
    const text = readFileSync(fullPath).toString('latin1')
    return text.includes('/ObjStm') || /\/Type\s*\/XRef/.test(text)
  } catch {
    return false
  }
}

/** 用 pdftocairo 把一张 PDF 图重写成扁平结构（输出路径必须是 ASCII，中文路径它写不了）。 */
async function rewriteFigure(src, dest, options) {
  const bin = getEnginePath(options.texlivePath || null, 'pdftocairo') || findOnPath('pdftocairo')
  if (!bin) return false
  try { mkdirSync(dirname(dest), { recursive: true }) } catch { return false }
  const tmp = join(FIGURE_CACHE_DIR, `tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.pdf`)
  const result = await runProcess(bin, ['-pdf', src, tmp], {
    timeoutMs: 60000,
    signal: options.signal
  })
  let ok = false
  try {
    if (result.code === 0 && existsSync(tmp)) {
      copyFileSync(tmp, dest)
      ok = true
    }
  } catch { ok = false } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 临时文件清不掉也不影响结果 */ }
  }
  return ok
}

/**
 * 开编前准备「净化后的插图影子目录」。
 *
 * 返回 `{ shadowDir, rewritten }`：把 `shadowDir` 塞进 `TEXINPUTS` 最前面，
 * 排版时就会优先解析到重写过的图。没有需要净化的图（或 pdftocairo 缺失）返回 null，
 * 此时编译行为与以前完全一致。
 *
 * **必须在 xelatex 之前设好 TEXINPUTS**：`.xdv` 里记的是排版时解析到的路径，
 * 只在 xdvipdfmx 阶段换图无效（实测 11/12，等于没换）。
 */
export async function prepareFigureShadow(mainPath, options = {}) {
  const dir = dirname(mainPath)
  const targets = []
  for (const ref of collectGraphicRefs(mainPath)) {
    const full = join(dir, ref)
    if (!existsSync(full)) continue
    if (extname(full).toLowerCase() !== '.pdf') continue
    if (!pdfHasObjectStream(full)) continue
    targets.push({ ref, full })
  }
  if (!targets.length) return null
  const shadowDir = join(
    FIGURE_CACHE_DIR,
    `shadow-${createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 12)}`
  )
  const rewritten = []
  for (const item of targets) {
    let info = null
    try { info = statSync(item.full) } catch { continue }
    const key = createHash('sha1')
      .update(`${item.full.toLowerCase()}|${info.mtimeMs}|${info.size}`)
      .digest('hex')
    const cached = join(FIGURE_CACHE_DIR, `${key}.pdf`)
    if (!existsSync(cached)) {
      if (!await rewriteFigure(item.full, cached, options)) continue
      rewritten.push(item.ref)
    }
    const dest = join(shadowDir, item.ref)
    try {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(cached, dest)
    } catch { /* 单张失败就退回原图，不影响整体编译 */ }
  }
  if (!existsSync(shadowDir)) return null
  return { shadowDir, rewritten }
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
      // 警告也是这个格式（`文件:行: Package xxx Warning: …`），不能一律当错误
      if (isWarningMessage(fileErr.msg)) {
        warnings.push({ file: fileErr.file, line: fileErr.line, message: fileErr.msg })
      } else if (!/^\\\S*\s*->/.test(fileErr.msg)) {
        // `\badmacro ->\foo` 这种是上一行错误的上下文片段，不是独立错误（否则同一条错误数两遍）
        errors.push({ file: fileErr.file, line: fileErr.line, message: fileErr.msg })
      }
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

/**
 * 中断之后要防一手的辅助文件。
 *
 * 只收「下一趟排版会读回去」的那几个：`.aux`（交叉引用/标签）、`.nav`/`.snm`/`.out`/`.toc`
 * （beamer 与目录）、`.bcf`（biblatex 控制文件）。`.log` 与 `.pdf` 不在内 —— 它们只是产物，
 * 读坏了不影响下一趟排版，把它们也算脏只会让清理面变大。
 */
const AUX_DIRTY_EXTENSIONS = ['.aux', '.nav', '.out', '.toc', '.snm', '.bcf']

/**
 * 脏标记存在临时目录，不往用户项目里塞文件。
 * 键 = 目录 + 主文件名（小写，Windows 路径大小写不敏感）。
 */
const AUX_DIRTY_STORE = join(tmpdir(), 'dsh-moling-aux-dirty.json')

function dirtyKey(mainPath) {
  return `${dirname(mainPath)}|${basename(mainPath, extname(mainPath))}`.toLowerCase()
}

function readDirtyStore() {
  try {
    const parsed = JSON.parse(readFileSync(AUX_DIRTY_STORE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDirtyStore(map) {
  try {
    mkdirSync(dirname(AUX_DIRTY_STORE), { recursive: true })
    writeFileSync(AUX_DIRTY_STORE, JSON.stringify(map), 'utf8')
  } catch { /* 写不进临时目录就算了，退化成「这次不防」而不是把编译拦下来 */ }
}

/** 这份文档当前有没有「上次中断留下的脏辅助文件」；有则返回 { at, files }。 */
export function isAuxDirty(mainPath) {
  const entry = readDirtyStore()[dirtyKey(mainPath)]
  return entry && Array.isArray(entry.files) && entry.files.length ? entry : null
}

/** 把这一趟确实写坏的辅助文件记成脏（下次编译前清）。 */
export function markAuxDirty(mainPath, files) {
  const list = Array.isArray(files) ? files.filter((name) => typeof name === 'string' && name) : []
  if (!list.length) return null
  const map = readDirtyStore()
  map[dirtyKey(mainPath)] = { at: Date.now(), files: list }
  writeDirtyStore(map)
  return list
}

/** 清掉脏标记（不论有没有真的清理文件）。 */
export function clearAuxDirty(mainPath) {
  const map = readDirtyStore()
  const key = dirtyKey(mainPath)
  if (!(key in map)) return false
  delete map[key]
  writeDirtyStore(map)
  return true
}

/**
 * 上次中断留下的脏辅助文件：这次开编前先清掉，并把清掉的文件名还给调用方。
 *
 * 只清**被标记过的那几个**，不是整个目录的辅助文件 —— 「每次编译都 clean」
 * 会把本来能省一趟的交叉引用信息也一起扔掉（AGENTS.md 里明确不要）。
 */
export function recoverDirtyAux(mainPath) {
  const entry = isAuxDirty(mainPath)
  if (!entry) return []
  const dir = dirname(mainPath)
  const deleted = []
  for (const name of entry.files) {
    const target = join(dir, basename(name))
    try {
      if (existsSync(target)) {
        unlinkSync(target)
        deleted.push(basename(name))
      }
    } catch { /* 被占用则留给这一趟自己去覆盖 */ }
  }
  clearAuxDirty(mainPath)
  return deleted
}

/** 记下开编前这几个辅助文件的 mtime，用来判断「这一趟到底写坏了哪几个」。 */
function snapshotAuxTimes(mainPath) {
  const dir = dirname(mainPath)
  const base = basename(mainPath, extname(mainPath))
  const times = {}
  for (const ext of AUX_DIRTY_EXTENSIONS) {
    try {
      const target = join(dir, `${base}${ext}`)
      times[ext] = existsSync(target) ? statSync(target).mtimeMs : null
    } catch {
      times[ext] = null
    }
  }
  return times
}

/**
 * 编译没跑完 / 跑挂了之后，判断这一趟把哪几个辅助文件写成了半截。
 *
 * 判据：① 文件现在存在；② 这一趟确实写过它（开编前没有，或者 mtime 变新了）。
 * 只按「存在」判会把上一趟留下的好文件也标记成脏，下次白清一遍。
 */
function collectDamagedAux(mainPath, before) {
  const dir = dirname(mainPath)
  const base = basename(mainPath, extname(mainPath))
  const damaged = []
  for (const ext of AUX_DIRTY_EXTENSIONS) {
    const name = `${base}${ext}`
    const target = join(dir, name)
    try {
      if (!existsSync(target)) continue
      const mtime = statSync(target).mtimeMs
      const previous = before ? before[ext] : null
      if (previous === null || previous === undefined || mtime > previous) damaged.push(name)
    } catch { /* 读不到就跳过，别让防护本身把编译弄挂 */ }
  }
  return damaged
}

/**
 * 这一趟是不是「中途死掉」的那种失败（而不是普通的排版错误）。
 *
 * 普通排版错误（少个括号、未定义命令）会在 `.aux` 写完整之前就停，但 TeX 自己会
 * 处理得很干净；真正会留下半截 `.aux` 的是这几类：Emergency stop、fatal、
 * 后端没写出 PDF，以及用户手动中断（AbortSignal）。
 */
export function auxDamageLikely(log, aborted) {
  if (aborted) return true
  const text = String(log || '')
  return /Emergency stop/i.test(text)
    || /fatal/i.test(text)
    || /No output PDF file written/i.test(text)
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
 *   quick —— 单趟 draft 编译（图片占位，看不到图，最快拿到 PDF）
 *   once  —— 单趟完整编译（图片照常插入，不跑 bibtex / 不补趟）
 *   full  —— 完整流程：主编译 →（需要时）bibtex → 主编译 →（需要时）第三趟
 *   clean —— 先清辅助文件，再走 full
 *
 * @param {object} options
 * @param {string} options.filePath  .tex 绝对路径
 * @param {string} [options.engine]  xelatex | pdflatex | lualatex | latexmk（缺省按导言区自动挑）
 * @param {'quick'|'once'|'full'|'clean'} [options.mode]
 * @param {string|null} [options.texlivePath]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.synctex] 是否产出 .synctex.gz（默认 true）
 * @param {AbortSignal} [options.signal]
 * @param {(step:string)=>void} [options.onStep]
 */
async function compileOnce(options) {
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
      passCodes: [],
      pdfRetries: 0,
      bibtex: null,
      cleaned: [],
      recovered: [],
      figuresRewritten: 0,
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

  // 插图净化：把带对象流的 PDF 图重写到影子目录，并让 TEXINPUTS 优先解析影子副本。
  // 这一步在排版**之前**，因为 .xdv 记的是排版时解析到的图路径（只给后端换图无效）。
  // 没有需要净化的图时返回 null，编译行为与以前完全一致。
  let figureShadow = null
  if (engine !== 'latexmk') {
    try {
      figureShadow = await prepareFigureShadow(filePath, { texlivePath, signal })
    } catch { figureShadow = null }
    if (figureShadow) {
      const current = env.TEXINPUTS || ''
      env.TEXINPUTS = `${figureShadow.shadowDir};${dir};${current}`
      if (figureShadow.rewritten.length) {
        onStep(`净化插图：${figureShadow.rewritten.length} 张 PDF 图含对象流，已重写（消除 xdvipdfmx 缺陷）`)
      }
    }
  }

  // 上次编译中途死掉（Emergency stop / fatal / 后端没写出 PDF / 用户中断）会留下半截
  // `.aux`、`.nav` 之类；下一趟排版把半截文件读回去，症状就是「第一次失败、再点一次才成功」。
  // 这里只清**上次被标记为脏的那几个**，不是每次都 clean —— 平时照常复用交叉引用信息。
  const recovered = mode === 'clean' ? [] : recoverDirtyAux(filePath)
  const cleaned = mode === 'clean' ? cleanAuxFiles(filePath) : []
  // 开编前给辅助文件拍个 mtime 快照：只有「这一趟确实写过」的才算它写坏的
  const auxBefore = snapshotAuxTimes(filePath)
  const commonArgs = ['-interaction=nonstopmode', '-file-line-error', '-halt-on-error']
  if (synctex) commonArgs.push('-synctex=1')

  // 中间趟不写 PDF：xelatex 加 -no-pdf，最后只调一次 xdvipdfmx。
  // 实测（真项目、13MB PDF）：带 PDF 写出的一趟 6.7s，只排版的一趟 3.0s；
  // 完整编译要 3~4 趟，省下的是「每趟都重写一遍 PDF」的时间（full 24s → 约 12s）。
  // 这也顺带把 xdvipdfmx 那个随机缺陷的暴露面从「每趟」缩到「最后一次」。
  const xdvPath = join(dir, `${base}.xdv`)
  const noPdfIntermediate = engine === 'xelatex' && mode !== 'quick'

  const passes = []
  let lastLog = ''
  let bibtex = null
  let aborted = false
  let pdfRetries = 0

  /** 跑一趟引擎，返回 runProcess 结果并刷新 lastLog。 */
  const runEngineOnce = async (draft) => {
    let args
    if (engine === 'latexmk') {
      args = ['-pdfxe', ...commonArgs, basename(filePath)]
    } else if (draft) {
      args = [...commonArgs, `-jobname=${base}`, `\\PassOptionsToPackage{draft}{graphicx}\\input{${base}}`]
    } else {
      args = [...commonArgs, basename(filePath)]
    }
    // 中间趟只排版不写 PDF（见 noPdfIntermediate 的说明）
    if (noPdfIntermediate) args = ['-no-pdf', ...args]
    onStep(`运行 ${engine}${draft ? '（draft）' : ''}：${enginePath} ${args.join(' ')}`)
    const result = await runProcess(enginePath, args, { cwd: dir, env, timeoutMs, signal })
    // TeX 的完整日志在 .log 里，stdout 只是节选
    try {
      if (existsSync(logPath)) lastLog = readFileSync(logPath, 'utf8')
      else lastLog = `${result.stdout}${result.stderr}`
    } catch {
      lastLog = `${result.stdout}${result.stderr}`
    }
    passes.push({
      draft: Boolean(draft),
      code: result.code,
      timedOut: result.timedOut,
      error: result.error,
      // 留给失败兜底用：xdvipdfmx 的 fatal 只出现在 stdout/stderr，.log 里没有
      stdout: String(result.stdout || '').slice(-4000),
      stderr: String(result.stderr || '').slice(-4000)
    })
    return result
  }

  /**
   * 中间趟用了 -no-pdf，PDF 要在这里单独生成一次。
   * xdvipdfmx 有那个随机缺陷（见 pdfBackendFatal），所以同样带重试。
   */
  const runPdfBackend = async () => {
    const bin = getEnginePath(texlivePath, 'xdvipdfmx') || 'xdvipdfmx'
    const args = ['-q', `${base}.xdv`]
    let result = null
    for (let attempt = 0; attempt <= PDF_BACKEND_RETRIES; attempt += 1) {
      if (attempt > 0) {
        pdfRetries += 1
        onStep(`PDF 后端（xdvipdfmx）偶发失败，自动重跑第 ${attempt} 次`)
      }
      onStep(`运行 xdvipdfmx：${bin} ${args.join(' ')}`)
      result = await runProcess(bin, args, { cwd: dir, env, timeoutMs, signal })
      const output = `${result.stdout}${result.stderr}`
      if (result.aborted || result.timedOut || result.error || result.code === 0) break
      if (!pdfBackendFatal(output) && !pdfBackendFatal(lastLog)) break
    }
    passes.push({
      draft: false,
      backend: 'xdvipdfmx',
      code: result.code,
      timedOut: result.timedOut,
      error: result.error,
      stdout: String(result.stdout || '').slice(-4000),
      stderr: String(result.stderr || '').slice(-4000)
    })
    return result
  }

  /**
   * 跑一趟引擎；若失败原因是 xdvipdfmx 那个随机缺陷（见 pdfBackendFatal），
   * 自动重跑同一趟。文档没变、失败点在 PDF 后端，重跑是安全且有效的。
   */
  const runEngine = async (draft) => {
    let result = await runEngineOnce(draft)
    let attempt = 0
    while (attempt < PDF_BACKEND_RETRIES) {
      if (result.aborted || result.code === 0) break
      if (parseLog(lastLog, filePath).errors.length) break
      if (!pdfBackendFatal(`${result.stdout}${result.stderr}`) && !pdfBackendFatal(lastLog)) break
      attempt += 1
      pdfRetries += 1
      onStep(`PDF 后端（xdvipdfmx）偶发失败，自动重跑第 ${attempt} 次`)
      result = await runEngineOnce(draft)
    }
    return result
  }

  if (mode === 'quick') {
    const first = await runEngine(true)
    aborted = first.aborted
  } else if (mode === 'once') {
    // 只排版一趟：图片照常插入（不 draft），但不跑 bibtex、不补趟。
    // 交叉引用 / 目录 / 参考文献编号可能还是上一趟的，换来的是最短的等待时间。
    const first = await runEngine(false)
    aborted = first.aborted
    if (!aborted && noPdfIntermediate) {
      const backend = await runPdfBackend()
      if (backend.aborted) aborted = true
    }
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
      // 中间趟都没写 PDF（-no-pdf），最后一趟排版跑完了才生成一次 PDF
      if (!aborted && noPdfIntermediate) {
        const backend = await runPdfBackend()
        if (backend.aborted) aborted = true
      }
    }
  }

  const parsed = parseLog(lastLog, filePath)
  const lastPass = passes[passes.length - 1] || {}
  // 中间趟（-no-pdf）不写 PDF，成败要看「最后一趟排版」+「PDF 后端」两段
  const typesetPasses = passes.filter((item) => item.backend !== 'xdvipdfmx')
  const lastTypeset = typesetPasses[typesetPasses.length - 1] || {}
  const success = !aborted
    && (lastTypeset.code === undefined || lastTypeset.code === 0)
    && lastPass.code === 0
    && existsSync(pdfPath)

  if (aborted && !parsed.errors.length) {
    parsed.errors.push({ file: filePath, line: null, message: '编译被中断（AbortSignal）' })
  }
  if (lastPass.timedOut && !parsed.errors.length) {
    parsed.errors.push({ file: filePath, line: null, message: `编译超时（超过 ${timeoutMs}ms）` })
  }
  if (lastPass.error && !parsed.errors.length) {
    parsed.errors.push({ file: null, line: null, message: `无法启动编译器（${enginePath}）：${lastPass.error}` })
  }
  // 兜底：exit≠0 但日志里没有 LaTeX 错误（典型是 PDF 后端崩了），
  // 以前这里什么都不加 → 面板只说「编译失败」却列不出任何原因（用户 m05857 报的正是这个）。
  if (!success && !parsed.errors.length && !aborted && !lastPass.timedOut && !lastPass.error) {
    const reason = pdfBackendFatal(`${lastLog}`)
      || pdfBackendFatal(`${lastPass.stdout || ''}${lastPass.stderr || ''}`)
      || pdfBackendFatal(`${lastTypeset.stdout || ''}${lastTypeset.stderr || ''}`)
    const badCode = lastPass.code === 0 ? lastTypeset.code : lastPass.code
    parsed.errors.push({
      file: filePath,
      line: null,
      message: reason
        ? `${reason}${pdfRetries ? `（已自动重跑 ${pdfRetries} 次仍失败，可再点一次编译）` : ''}`
        : `编译失败（exit=${badCode === undefined ? '?' : badCode}），日志里没有 LaTeX 错误`
    })
  }
  // bibtex 没跑通不一定要命（有的模板根本不用），但要让用户看见，别只剩一句「编译失败」
  if (bibtex && bibtex.ran && !bibtex.success) {
    parsed.warnings.push({ file: filePath, line: null, message: '[bibtex] 未成功，参考文献编号可能不对' })
  }

  // 这一趟死在中途 → 把它写过的辅助文件记成脏，下次开编前先清
  if (!success && auxDamageLikely(lastLog, aborted)) {
    const damaged = collectDamagedAux(filePath, auxBefore)
    if (damaged.length) markAuxDirty(filePath, damaged)
  } else if (success) {
    // 编通了：上一轮的脏标记（如果有）已经没意义了
    clearAuxDirty(filePath)
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
    // 完整编译要跑多趟：日志与成败**只取最后一趟**，中间趟的产物不上屏
    passes: passes.length,
    passCodes: passes.map((item) => (item.code === undefined ? null : item.code)),
    // PDF 后端偶发失败自动重跑了几趟（0 = 没触发）
    pdfRetries,
    bibtex: bibtex ? { ran: bibtex.ran, success: bibtex.success } : null,
    cleaned,
    // 这次开编前因为「上次中断」清掉的辅助文件（空数组 = 没触发）
    recovered,
    // 这次开编前重写过的插图数（含对象流的 PDF 图；0 = 没有需要净化的图）
    figuresRewritten: figureShadow ? figureShadow.rewritten.length : 0,
    errors: parsed.errors,
    warnings: parsed.warnings,
    logTail: lastLog
  }
}

/* ------------------------------------------------------------------ *
 * 编译互斥队列（同一份文档串行）
 * ------------------------------------------------------------------ */

/**
 * 同一 dir+base 的编译必须串行。
 *
 * 面板（/moling/api/compile）与工具（latex_compile）是两个独立入口，
 * 谁也不知道对方在编：并发跑会同时写同一个 .aux/.log/.pdf，
 * 后写的那趟读到半截 aux，症状就是「编译报错，清掉辅助文件才能再编」。
 * 这里按「主文件名」排队：后来的等前面的跑完再开，不丢也不并。
 */
const compileQueues = new Map()

function queueKey(filePath) {
  return join(dirname(filePath), basename(filePath, extname(filePath)))
}

export async function compileDocument(options) {
  const key = queueKey(options?.filePath || '')
  const previous = compileQueues.get(key) || Promise.resolve()
  let release = null
  const current = previous.then(() => new Promise((resolve) => { release = resolve }))
  compileQueues.set(key, current)
  try {
    await previous.catch(() => {})   // 前一趟失败了也不该把这一趟拦住
    return await compileOnce(options)
  } finally {
    if (release) release()
    if (compileQueues.get(key) === current) compileQueues.delete(key)
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
