/**
 * moling_latex 宿主侧的数据通道：一条挂在 `/moling/api` 的前缀 HTTP 路由。
 *
 *   POST /moling/api/<endpoint>   JSON 请求体 = 端点入参，返回 { ok, value } / { ok, error }
 *   GET  /moling/api/ping         探活（浏览器 / 脚本都能打）
 *
 * 端点：ping / status / workspaces / open-root / open-file / tree /
 *       read-file / write-file / compile / clean / pdf / pdf-page
 *
 * `pdf-page` 是本机 poppler（pdftoppm）把某一页栅格化成 PNG 直接返回二进制，
 * 让预览走「降分辨率的图片」而不是浏览器内置 PDF 阅读器（PDFium 按设备像素
 * 渲染整页，滚动/缩放时重绘开销大）。GET 形式：?root=&path=&page=&dpi=
 *
 * 为什么是 HTTP 而不是别的：这是本机同装插件 dsh-drawai 在同一版本里验证过的通道
 * （它用 fetch('/drawai/api/save') 保存画布）。面板在浏览器里同源请求，不需要 CORS、
 * 不需要令牌；DSH 的 Connection RPC 通道虽然更"官方"，但对第三方文件插件没有可用的
 * 注册入口（只有动态插件拿得到 host.call）。
 *
 * 安全边界：文件系统可达范围限制在「DSH 已注册工作区 + 用户显式打开过的目录
 * （打开文件时取其所在目录）+ config.allowedRoots」之内；所有 path 都解析并校验
 * 必须落在 root 之内；写文件只接受文本类型。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanAuxFiles, compileDocument, detectTexLive, findOnPath, getEnginePath, parseOutline, runProcess } from './latex.js'
import { synctexBackward, synctexForward } from './synctex.js'

/** 面板数据通道的前缀。 */
export const API_PREFIX = '/moling/api'

/** 面板里可编辑的文本类型。 */
const TEXT_EXT = new Set([
  '.tex', '.ltx', '.latex', '.bib', '.sty', '.cls', '.def', '.cfg',
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml', '.csv', '.log'
])
/** 面板里可预览的二进制类型。 */
const VIEW_EXT = new Set(['.pdf'])
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '.venv', '__pycache__',
  'out', 'dist', 'release', 'build', '.dsh', '.vscode', '.idea'
])
const MAX_FILES = 4000
const MAX_DEPTH = 10
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const MAX_PDF_BYTES = 48 * 1024 * 1024
const MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * 预览栅格化参数。
 * 默认 96dpi ≈ A4 一页 794×1123 像素，足够看清正文，又远小于「设备像素级」渲染的成本。
 * 清晰度三档在面板里可选（72 / 96 / 144），上下限在这里兜住。
 */
const PDF_DPI_DEFAULT = 96
const PDF_DPI_MIN = 48
const PDF_DPI_MAX = 200
/** 栅格化结果缓存目录：键 = 绝对路径 + mtime + dpi + 页码，重新编译换了 mtime 自然换键。 */
const PDF_CACHE_DIR = join(tmpdir(), 'dsh-moling-pdf')
/** 打包好的浏览器侧资源（编辑器内核等）所在目录。 */
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vendor')

/** 业务错误：带一个 RPC 错误码。 */
class MolingError extends Error {
  constructor(message, code = 'bad-request') {
    super(message)
    this.name = 'MolingError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** target 是否在 root 之内（Windows 下大小写不敏感）。 */
function isUnder(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  const rs = process.platform === 'win32' ? r.toLowerCase() : r
  const ts = process.platform === 'win32' ? t.toLowerCase() : t
  return ts === rs || ts.startsWith(rs.endsWith(sep) ? rs : rs + sep)
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

/** 取整并夹进 [min,max]；非法输入用 fallback。 */
function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/* ------------------------------------------------------------------ *
 * 与传输无关的核心
 * ------------------------------------------------------------------ */

/**
 * 造出面板的全部操作。
 * @param {object} deps
 * @param {() => {allowedRoots?:string[]}} deps.getConfig
 * @param {() => Array<{path:string,title?:string}>} deps.getWorkspaces
 * @param {() => {texlivePath?:string|null, engine?:string, timeoutMs?:number}} deps.getTexEnv
 */
export function createPanelCore(deps) {
  const { getConfig = () => ({}), getWorkspaces = () => [], getTexEnv = () => ({}) } = deps || {}

  /** 用户显式打开过的目录（打开文件时取其所在目录）。进程内有效。 */
  const openedRoots = new Set()

  const allowedRoots = () => {
    const list = []
    for (const workspace of getWorkspaces()) {
      if (workspace?.path) list.push(resolve(workspace.path))
    }
    for (const extra of getConfig().allowedRoots || []) {
      if (typeof extra === 'string' && extra.trim()) list.push(resolve(extra.trim()))
    }
    for (const extra of openedRoots) list.push(extra)
    return [...new Set(list)]
  }

  const workspacesView = () => {
    const registered = getWorkspaces().map((workspace) => ({
      path: workspace.path,
      title: workspace.title || basename(workspace.path),
      kind: 'workspace'
    }))
    const extras = allowedRoots()
      .filter((path) => !registered.some((entry) => entry.path === path))
      .map((path) => ({ path, title: basename(path) || path, kind: 'opened' }))
    return registered.concat(extras)
  }

  const acceptRoot = (root) => {
    if (typeof root !== 'string' || root.trim().length === 0) throw new MolingError('缺少 root 参数')
    const full = resolve(root.trim())
    if (!existsSync(full) || !isDirectory(full)) throw new MolingError(`目录不存在或不是目录：${full}`)
    const allowed = allowedRoots()
    if (allowed.length > 0 && !allowed.some((candidate) => isUnder(candidate, full) || isUnder(full, candidate))) {
      throw new MolingError(`目录不在允许范围内。请用面板的「打开目录…」显式打开，或写进插件 config.allowedRoots：${full}`)
    }
    return full
  }

  /** root + 相对/绝对路径 → root 内的绝对路径。 */
  const safeResolve = (root, target) => {
    if (typeof target !== 'string' || target.length === 0) throw new MolingError('缺少 path 参数')
    const rootPath = resolve(root)
    const full = resolve(rootPath, target)
    if (!isUnder(rootPath, full) || full === rootPath) throw new MolingError('路径越界或非法')
    return full
  }

  const texStatus = async (signal) => {
    const env = getTexEnv() || {}
    const detection = detectTexLive(env.texlivePath || null)
    const engines = {}
    for (const engine of ['xelatex', 'pdflatex', 'lualatex', 'latexmk', 'bibtex', 'synctex']) {
      engines[engine] = getEnginePath(detection.path, engine) || findOnPath(engine)
    }
    let version = null
    if (detection.found) {
      const result = await runProcess(detection.engine || 'xelatex', ['--version'], { timeoutMs: 15000, signal })
      const first = `${result.stdout}${result.stderr}`.split(/\r?\n/).find((line) => line.trim().length > 0)
      version = first ? first.trim() : null
    }
    return { found: detection.found, source: detection.source, binDir: detection.path, version, engines }
  }

  /**
   * 找 poppler 的小工具（pdftoppm / pdfinfo）。TeX Live 自带，和引擎在同一个 bin 目录，
   * 所以先查探测到的 TeX bin，再退回 PATH。找不到返回 null —— 预览会回退到浏览器内置阅读器。
   */
  const popplerTool = (name) => {
    const env = getTexEnv() || {}
    const detection = detectTexLive(env.texlivePath || null)
    return getEnginePath(detection.path, name) || findOnPath(name)
  }

  /**
   * PDF 的页数与首页尺寸（pt）——正向定位要把 PDF 点坐标换算成页面里的百分比，
   * 所以尺寸得从 pdfinfo 里拿。读不到就返回 pages:0（前端据此回退到内置阅读器）。
   */
  const readPdfInfo = async (full) => {
    const tool = popplerTool('pdfinfo')
    if (!tool) return { pages: 0, pageSize: null }
    const result = await runProcess(tool, [full], { timeoutMs: 20000 })
    if (result.code !== 0) return { pages: 0, pageSize: null }
    const out = result.stdout || ''
    const pagesMatch = /^Pages:\s+(\d+)/m.exec(out)
    const sizeMatch = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(out)
    return {
      pages: pagesMatch ? Number(pagesMatch[1]) : 0,
      pageSize: sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : null
    }
  }

  /**
   * 把第 page 页栅格化成 PNG（带磁盘缓存）。
   * 走 poppler 而不是让浏览器自己渲染 PDF，是为了能选「低于设备像素」的分辨率：
   * PDFium 只会按设备像素渲染，滚动重绘的成本压不下来。
   */
  const rasterizePdfPage = async (full, page, dpi) => {
    const tool = popplerTool('pdftoppm')
    if (!tool) throw new MolingError('没找到 pdftoppm（TeX Live 自带的 poppler），无法生成降分辨率预览')
    const rev = String(statSync(full).mtimeMs)
    const key = createHash('sha1').update(`${full}|${rev}|${dpi}|${page}`).digest('hex').slice(0, 20)
    const cacheFile = join(PDF_CACHE_DIR, `${key}.png`)
    if (isFile(cacheFile)) return readFileSync(cacheFile)
    mkdirSync(PDF_CACHE_DIR, { recursive: true })
    const result = await runProcess(tool, [
      '-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', full,
      join(PDF_CACHE_DIR, key)
    ], { timeoutMs: 60000 })
    if (result.code !== 0 || !isFile(cacheFile)) {
      const detail = String(result.stderr || result.error || '').trim().slice(0, 300)
      throw new MolingError(`pdftoppm 生成第 ${page} 页失败：${detail || '没有产出文件'}`)
    }
    return readFileSync(cacheFile)
  }

  /** 递归扫描：同时给出扁平 files 与嵌套 tree（面板画目录树用）。 */
  const scan = (root) => {
    const files = []
    const rootNode = { name: basename(root) || root, rel: '', type: 'dir', children: [] }
    const dirNodes = new Map([['', rootNode]])
    const queue = [{ dir: root, depth: 0, node: rootNode }]
    let truncated = false
    let total = 0

    const nodeFor = (dir, parentNode) => {
      const rel = relative(root, dir).split(sep).join('/')
      const existing = dirNodes.get(rel)
      if (existing) return existing
      const node = { name: basename(dir), rel, type: 'dir', children: [] }
      dirNodes.set(rel, node)
      parentNode.children.push(node)
      return node
    }

    while (queue.length > 0) {
      const { dir, depth, node } = queue.shift()
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }

      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue
          if (depth + 1 > MAX_DEPTH) { truncated = true; continue }
          queue.push({ dir: full, depth: depth + 1, node: nodeFor(full, node) })
          continue
        }
        if (!entry.isFile()) continue
        total += 1
        const ext = extname(entry.name).toLowerCase()
        if (!TEXT_EXT.has(ext) && !VIEW_EXT.has(ext)) continue
        if (files.length >= MAX_FILES) { truncated = true; continue }
        let size = 0
        let mtime = 0
        try {
          const info = statSync(full)
          size = info.size
          mtime = info.mtimeMs
        } catch { /* 忽略不可读文件 */ }
        const rel = relative(root, full).split(sep).join('/')
        const editable = TEXT_EXT.has(ext)
        files.push({ rel, name: entry.name, dir: relative(root, dir).split(sep).join('/') || '.', ext, size, mtime, editable })
        node.children.push({ name: entry.name, rel, type: 'file', ext, size, mtime, editable })
      }
    }

    const sortNode = (current) => {
      current.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      for (const child of current.children) if (child.type === 'dir') sortNode(child)
    }
    sortNode(rootNode)

    return {
      files,
      tree: rootNode,
      truncated,
      total,
      skipped: Math.max(0, total - files.length)
    }
  }

  const readTextFile = (root, relPath) => {
    const full = safeResolve(root, relPath)
    if (!isFile(full)) throw new MolingError(`文件不存在：${full}`)
    const ext = extname(full).toLowerCase()
    if (!TEXT_EXT.has(ext)) throw new MolingError(`不支持读取的类型：${ext || '(无后缀)'}`)
    const size = statSync(full).size
    if (size > MAX_TEXT_BYTES) throw new MolingError(`文件过大（${size} 字节）`)
    return { path: full, rel: relative(root, full).split(sep).join('/'), name: basename(full), text: readFileSync(full, 'utf8'), size }
  }

  const writeTextFile = (root, relPath, content) => {
    if (typeof content !== 'string') throw new MolingError('缺少 content')
    const full = safeResolve(root, relPath)
    const ext = extname(full).toLowerCase()
    if (!TEXT_EXT.has(ext)) throw new MolingError(`不支持写入的类型：${ext || '(无后缀)'}`)
    if (!existsSync(dirname(full))) mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
    return {
      path: full,
      rel: relative(root, full).split(sep).join('/'),
      bytes: Buffer.byteLength(content, 'utf8'),
      mtime: statSync(full).mtimeMs
    }
  }

  /**
   * 读 PDF。`meta: true` 只回元信息（不传 base64）——面板走「降分辨率图片」预览时
   * 根本不需要整份 PDF 进内存，48MB 的 PDF 转成 base64 是 64MB 的字符串，白花时间。
   */
  const readPdf = (root, relPath, options = {}) => {
    const meta = options.meta === true
    const full = safeResolve(root, relPath)
    if (!isFile(full) || extname(full).toLowerCase() !== '.pdf') throw new MolingError('PDF 不存在')
    const size = statSync(full).size
    if (size > MAX_PDF_BYTES) throw new MolingError(`PDF 过大（${size} 字节）`)
    const base = {
      abs: full,
      rel: relative(root, full).split(sep).join('/'),
      name: basename(full),
      bytes: size,
      mtime: statSync(full).mtimeMs
    }
    if (meta) return base
    return { ...base, base64: readFileSync(full).toString('base64') }
  }

  /** 面板操作表：与传输无关；抛 MolingError 表示业务失败。 */
  const endpoints = {
    ping() {
      const allowed = allowedRoots()
      return { api: API_PREFIX, defaultRoot: allowed[0] || null, allowedRoots: allowed }
    },

    status(_payload, signal) {
      return texStatus(signal)
    },

    workspaces() {
      const allowed = allowedRoots()
      return {
        workspaces: workspacesView(),
        openedRoots: [...openedRoots],
        allowedRoots: allowed,
        defaultRoot: allowed[0] || null
      }
    },

    /** 显式登记一个目录（面板「打开目录…」）。 */
    'open-root'(payload) {
      const requested = typeof payload?.root === 'string' ? payload.root.trim() : ''
      if (!requested) throw new MolingError('缺少 root 参数')
      const full = resolve(requested)
      if (!existsSync(full) || !isDirectory(full)) throw new MolingError(`目录不存在或不是目录：${full}`)
      openedRoots.add(full)
      return { root: full, allowedRoots: allowedRoots(), workspaces: workspacesView() }
    },

    /**
     * 显式打开单个文件（面板「打开文件…」）：把所在目录登记为允许根并返回内容，
     * 于是"灵活加载"不必先有工作区。
     */
    'open-file'(payload) {
      const requested = typeof payload?.path === 'string' ? payload.path.trim().replace(/^"(.*)"$/, '$1') : ''
      if (!requested) throw new MolingError('缺少 path 参数')
      let full = resolve(requested)
      if (!existsSync(full) && !extname(full) && existsSync(`${full}.tex`)) full = `${full}.tex`
      if (!isFile(full)) throw new MolingError(`文件不存在：${full}`)
      const root = dirname(full)
      openedRoots.add(root)
      return { root, file: readTextFile(root, basename(full)), allowedRoots: allowedRoots(), workspaces: workspacesView() }
    },

    tree(payload) {
      const root = acceptRoot(payload?.root)
      const result = scan(root)
      return {
        root,
        count: result.files.length,
        total: result.total,
        skipped: result.skipped,
        truncated: result.truncated,
        files: result.files,
        tree: result.tree
      }
    },

    'read-file'(payload) {
      const root = acceptRoot(payload?.root)
      return readTextFile(root, payload?.path)
    },

    'write-file'(payload) {
      const root = acceptRoot(payload?.root)
      return writeTextFile(root, payload?.path, payload?.content)
    },

    async compile(payload, signal) {
      const root = acceptRoot(payload?.root)
      const target = safeResolve(root, payload?.file)
      if (!isFile(target)) throw new MolingError(`源文件不存在：${target}`)
      const env = getTexEnv() || {}
      const result = await compileDocument({
        filePath: target,
        engine: typeof payload?.engine === 'string' && payload.engine ? payload.engine : (env.engine || 'auto'),
        mode: ['quick', 'full', 'clean'].includes(payload?.mode) ? payload.mode : 'full',
        texlivePath: env.texlivePath || null,
        timeoutMs: Number.isFinite(payload?.timeoutMs) ? payload.timeoutMs : (env.timeoutMs || 120000),
        signal
      })
      const pdfRel = result.pdfPath ? relative(root, result.pdfPath).split(sep).join('/') : null
      const pdfMtime = result.pdfPath && existsSync(result.pdfPath) ? statSync(result.pdfPath).mtimeMs : null
      return { ...result, root, pdfRel, pdfMtime }
    },

    /**
     * SyncTeX 正反向定位（面板的「tex ↔ pdf 互跳」用）。
     *   {direction:'forward', root, file, pdf, line} → {page, x, y}
     *   {direction:'backward', root, file, pdf, page, x, y} → {line, file}
     * 坐标单位是 PDF 点（1/72 英寸），y 自页面顶部算起（synctex edit 的约定）。
     */
    async synctex(payload) {
      const root = acceptRoot(payload?.root)
      const texPath = safeResolve(root, payload?.file)
      if (!isFile(texPath)) throw new MolingError(`源文件不存在：${texPath}`)
      const pdfPath = payload?.pdf
        ? safeResolve(root, payload.pdf)
        : texPath.replace(/\.(tex|ltx|latex)$/i, '.pdf')
      if (!isFile(pdfPath)) throw new MolingError('PDF 还不存在，先编译一次')
      const env = getTexEnv() || {}
      const options = { texlivePath: env.texlivePath || null }
      if (payload?.direction === 'backward') {
        const page = clampInt(payload?.page, 1, 9999, 1)
        const x = Number(payload?.x) || 0
        const y = Number(payload?.y) || 0
        const result = await synctexBackward(page, x, y, pdfPath, options)
        return { direction: 'backward', ...result }
      }
      const line = clampInt(payload?.line, 1, 1000000, 1)
      const result = await synctexForward(texPath, line, pdfPath, options)
      return { direction: 'forward', ...result }
    },

    clean(payload) {
      const root = acceptRoot(payload?.root)
      const target = safeResolve(root, payload?.file)
      if (!isFile(target)) throw new MolingError(`文件不存在：${target}`)
      return { file: target, deleted: cleanAuxFiles(target) }
    },

    /** 面板「提纲」：解析当前 .tex 的章节标题（\part…\paragraph）与行号。 */
    outline(payload) {
      const root = acceptRoot(payload?.root)
      const target = safeResolve(root, payload?.file)
      if (!isFile(target)) throw new MolingError(`文件不存在：${target}`)
      const ext = extname(target).toLowerCase()
      if (ext !== '.tex' && ext !== '.ltx' && ext !== '.latex') throw new MolingError('提纲只支持 .tex 文件')
      const size = statSync(target).size
      if (size > MAX_TEXT_BYTES) throw new MolingError(`文件过大（${size} 字节）`)
      const parsed = parseOutline(readFileSync(target, 'utf8'), target)
      return {
        rel: relative(root, target).split(sep).join('/'),
        sections: parsed.sections,
        lines: parsed.lines,
        labels: parsed.labels,
        cites: parsed.cites
      }
    },

    /**
     * 浏览器侧的静态资源（目前只有编辑器内核 lib/vendor/cm6.js）。
     * 只允许 vendor 目录下、名字是 `[a-z0-9._-].js|css` 的文件，不回显任何目录信息。
     */
    asset(payload) {
      const name = String(payload?.name || '')
      if (!/^[A-Za-z0-9._-]+\.(js|css)$/.test(name)) throw new MolingError(`非法资源名：${name || '(空)'}`)
      const full = join(VENDOR_DIR, name)
      if (!isFile(full)) throw new MolingError(`资源不存在：${name}`)
      const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8'
      return { __bytes: readFileSync(full), __type: type }
    },

    /** PDF 元信息 + 整份 base64（面板「新标签」与内置阅读器回退用）。 */
    async pdf(payload) {
      const root = acceptRoot(payload?.root)
      const meta = payload?.meta === true || payload?.meta === '1' || payload?.meta === 'true'
      const info = readPdf(root, payload?.path, { meta })
      const pdfInfo = await readPdfInfo(info.abs)
      return {
        ...info,
        pages: pdfInfo.pages,
        pageSize: pdfInfo.pageSize,
        raster: Boolean(popplerTool('pdftoppm')),
        dpi: PDF_DPI_DEFAULT
      }
    },

    /**
     * 第 page 页的 PNG（GET 也可以：?root=&path=&page=&dpi=）。
     * 返回值带 __bytes，由 handler 直接写二进制，不走 JSON。
     */
    async 'pdf-page'(payload) {
      const root = acceptRoot(payload?.root)
      const full = safeResolve(root, payload?.path)
      if (!isFile(full) || extname(full).toLowerCase() !== '.pdf') throw new MolingError('PDF 不存在')
      const page = clampInt(payload?.page, 1, 9999, 1)
      const dpi = clampInt(payload?.dpi, PDF_DPI_MIN, PDF_DPI_MAX, PDF_DPI_DEFAULT)
      const png = await rasterizePdfPage(full, page, dpi)
      return { __bytes: png, __type: 'image/png' }
    }
  }

  return { endpoints, allowedRoots, acceptRoot, safeResolve, openedRoots, workspacesView, texStatus }
}

/* ------------------------------------------------------------------ *
 * 入口：HTTP 前缀路由 /moling/api
 * ------------------------------------------------------------------ */

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendText(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function sendBytes(res, code, bytes, type, cache = 'no-store') {
  res.writeHead(code, { 'content-type': type, 'content-length': String(bytes.length), 'cache-control': cache })
  res.end(bytes)
}

/** 读请求体；解析失败明确报错，不再静默变成 `{}`。 */
function readBody(req) {
  return new Promise((done) => {
    let raw = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      raw += String(chunk)
      if (raw.length > MAX_BODY_BYTES) { tooLarge = true; req.destroy() }
    })
    req.on('end', () => {
      if (tooLarge) { done({ error: `请求体超过 ${MAX_BODY_BYTES} 字节` }); return }
      if (raw.length === 0) { done({ value: {} }); return }
      try {
        done({ value: JSON.parse(raw) })
      } catch (error) {
        done({ error: `请求体不是合法 JSON：${String(error?.message || error)}` })
      }
    })
    req.on('error', () => done({ error: '读取请求体失败' }))
  })
}

/**
 * 造一个符合 webServer.register 契约的 handler：`/moling/api/<endpoint>`。
 * 一律返回 JSON：成功 `{ ok: true, value }`，失败 `{ ok: false, error }`。
 * @param {object} deps 同 createPanelCore
 */
export function createPanelHandler(deps) {
  const core = createPanelCore(deps)

  return async function handle(req, res) {
    let url
    try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { sendJson(res, 400, { ok: false, error: '非法 URL' }); return }
    const method = (req.method || 'GET').toUpperCase()
    let endpoint = url.pathname.slice(API_PREFIX.length)
    if (endpoint.startsWith('/')) endpoint = endpoint.slice(1)
    if (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1)

    const fail = (code, message) => sendJson(res, code, { ok: false, error: message })

    if (!endpoint) { fail(404, '缺少端点名'); return }
    const action = core.endpoints[endpoint]
    if (typeof action !== 'function') { fail(404, `未知端点 ${endpoint}`); return }

    try {
      let payload = {}
      if (method === 'POST') {
        const parsed = await readBody(req)
        if (parsed.error) { fail(400, parsed.error); return }
        payload = parsed.value
      } else {
        // GET 允许用查询参数传参，方便 curl / 浏览器地址栏排查
        payload = Object.fromEntries(url.searchParams.entries())
        if (payload.root && payload.path) { /* 原样透传 */ }
      }
      const value = await action(payload)
      // 二进制端点（pdf-page）不走 JSON：URL 里带了 mtime 与 dpi，结果可以长期缓存
      if (value && Buffer.isBuffer(value.__bytes)) {
        sendBytes(res, 200, value.__bytes, value.__type || 'application/octet-stream', 'public, max-age=31536000, immutable')
        return
      }
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      const status = error instanceof MolingError ? 400 : 500
      sendJson(res, status, { ok: false, error: String(error?.message || error) })
    }
  }
}
