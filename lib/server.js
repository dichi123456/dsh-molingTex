/**
 * moling_latex 宿主侧的数据通道：一条挂在 `/moling/api` 的前缀 HTTP 路由。
 *
 *   POST /moling/api/<endpoint>   JSON 请求体 = 端点入参，返回 { ok, value } / { ok, error }
 *   GET  /moling/api/ping         探活（浏览器 / 脚本都能打）
 *
 * 端点：ping / status / workspaces / open-root / open-file / tree /
 *       read-file / write-file / stat / compile / clean / pdf / pdf-page /
 *       asset / synctex / outline / templates / use-template
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanAuxFiles, compileDocument, detectTexLive, findOnPath, getEnginePath, parseOutline, runProcess } from './latex.js'
import { synctexBackward, synctexForward } from './synctex.js'

/** 面板数据通道的前缀。 */
export const API_PREFIX = '/moling/api'

/**
 * 面板里可编辑的文本类型。
 * 后一行是 LaTeX 的**编译辅助文件**：它们本来就是纯文本，能打开看（.aux/.toc/.log 常用来查
 * 「交叉引用为什么是 ??」），也便于手动删掉重编 —— 之前树里一个都看不到，用户以为插件失灵。
 */
const TEXT_EXT = new Set([
  '.tex', '.ltx', '.latex', '.bib', '.sty', '.cls', '.def', '.cfg',
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml', '.csv', '.log',
  '.aux', '.toc', '.out', '.bbl', '.blg', '.fls', '.fdb_latexmk',
  '.snm', '.nav', '.vrb', '.idx', '.ind', '.ilg', '.lof', '.lot'
])
/** 面板里可预览的二进制类型。 */
const VIEW_EXT = new Set(['.pdf'])
/**
 * LaTeX 编译产物：全项目搜索默认跳过。
 * 搜 `\ref`、`\label` 会命中一堆自动生成的 .aux/.toc，真正想找的正文反而被淹掉。
 */
const AUX_EXT = new Set([
  '.aux', '.toc', '.out', '.bbl', '.blg', '.fls', '.fdb_latexmk',
  '.snm', '.nav', '.vrb', '.idx', '.ind', '.ilg', '.lof', '.lot'
])
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
/**
 * 内置模板素材目录（tools/sync-templates.mjs 从桌面版同步过来的产物）：
 *   lib/templates/index.json        元数据（卡片文案 / 分类 / 引擎 / 文件清单）
 *   lib/templates/<id>/<相对路径>    模板文件本身（主 tex 统一叫 main.tex，另有 cls/sty/图片）
 * 模板量约 1.1 MB，**不能塞进 client.js**（那份已经内联了 400 KB 编辑器内核），
 * 所以由宿主读盘、按需落地。
 */
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates')

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

  /**
   * 面板最近一次编译用的档位（mode/engine/文件）。
   * 工具侧 latex_compile 未显式传 mode/engine 时沿用它，让「大模型编的」和
   * 「用户在面板里看到的那套」是同一个模式、同一个引擎。
   */
  let lastCompile = null

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
   * PDF 的页数与**逐页**尺寸（pt）。
   *
   * 为什么必须逐页：面板的预览是「一页一张 <img>」，页面容器的长宽比决定页面图会不会被
   * 拉伸。早先只拿首页尺寸、其余页按 A4 占位，于是 beamer 幻灯片（4:3 / 16:9）被纵向
   * 拉成 A4 —— 用户报「幻灯片比例显示不友好」。混合横竖页（论文里插一张横向大图）同理。
   *
   * `-f 1 -l 9999` 让 pdfinfo 逐页打印 `Page N size: W x H pts`；越界的上界它不报错。
   * 老版本 poppler 不认这两个开关时退回一次普通调用（只拿首页尺寸）。
   * 读不到就返回 pages:0（前端据此回退到内置阅读器）。
   */
  const readPdfInfo = async (full) => {
    const tool = popplerTool('pdfinfo')
    if (!tool) return { pages: 0, pageSize: null, pageSizes: null }
    let result = await runProcess(tool, ['-f', '1', '-l', '9999', full], { timeoutMs: 20000 })
    if (result.code !== 0) result = await runProcess(tool, [full], { timeoutMs: 20000 })
    if (result.code !== 0) return { pages: 0, pageSize: null, pageSizes: null }
    const out = result.stdout || ''
    const pagesMatch = /^Pages:\s+(\d+)/m.exec(out)
    const pages = pagesMatch ? Number(pagesMatch[1]) : 0
    // 逐页尺寸：Page 3 size:  362.83 x 272.13 pts (letter)
    const pageSizes = []
    const perPage = /^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm
    let hit
    while ((hit = perPage.exec(out)) !== null) {
      const index = Number(hit[1]) - 1
      if (!Number.isFinite(index) || index < 0) continue
      pageSizes[index] = { width: Number(hit[2]), height: Number(hit[3]) }
    }
    // 兜底：只有 `Page size:`（首页）的老输出
    const sizeMatch = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(out)
    const firstSize = sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : null
    // 稀疏数组补洞：中间缺页的沿用上一页尺寸，别给前端留 undefined
    const sizes = pageSizes.length ? pageSizes : null
    if (sizes) {
      for (let i = 0; i < pages; i++) {
        if (!sizes[i]) sizes[i] = sizes[i - 1] || firstSize || null
      }
    }
    return {
      pages,
      pageSize: (sizes && sizes[0]) || firstSize,
      pageSizes: sizes
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
    const info = statSync(full)
    if (info.size > MAX_TEXT_BYTES) throw new MolingError(`文件过大（${info.size} 字节）`)
    return {
      path: full,
      rel: relative(root, full).split(sep).join('/'),
      name: basename(full),
      text: readFileSync(full, 'utf8'),
      size: info.size,
      // mtime 一并回给面板记「版本戳」：轮询拿它比对，才知道磁盘上有没有新版本
      mtime: info.mtimeMs
    }
  }

  /**
   * 项目里所有目录的指纹：`相对路径:mtime:这一层的名字表`。
   *   · 新增 / 删除 / 重命名 → 名字表变（**不看时间戳**：Windows 目录 mtime 粒度约 15ms，
   *     同一毫秒里建了又删会算出同一个指纹，实测 flaky）
   *   · 同名替换 → 目录 mtime 变
   *   · 只改文件内容 → 指纹不变（那由逐文件 stat 兜，不该白刷文件树）
   * 只 readdir + statSync 目录，不读文件内容，够面板每 2 秒轮询一次。
   */
  const dirFingerprint = (root) => {
    const rows = []
    const queue = [{ dir: root, depth: 0 }]
    while (queue.length > 0) {
      const { dir, depth } = queue.shift()
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      let mtime = 0
      try { mtime = statSync(dir).mtimeMs } catch { mtime = 0 }
      const rel = relative(root, dir).split(sep).join('/')
      const names = entries.map((entry) => entry.name).sort().join(',')
      rows.push(`${rel}:${mtime}:${names}`)
      if (depth + 1 > MAX_DEPTH) continue
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
      }
    }
    rows.sort()
    return createHash('sha1').update(rows.join('\n')).digest('hex').slice(0, 20)
  }

  /**
   * 全项目搜索：在 `root` 下所有可编辑文本里找 `query`。
   *
   * 为什么不复用 `read-file` 一个个读：那要 N 次 HTTP 往返，几百个文件就是几百次；
   * 这里一次 BFS 读完直接回命中列表，面板只发一次请求。
   *
   * 默认**跳过编译产物**（.aux/.log/.toc/.bbl…）：搜 `\ref` 会命中一堆自动生成的东西，
   * 真正想找的正文反而被淹掉；要看这些文件时显式传 `includeAux: true`。
   *
   * `regex` 走用户正则；查询串限长 200 字符，避免拿病态正则把宿主拖死（RegExp 没法设超时）。
   * 命中总数封顶（默认 500），超了置 `truncated: true` 让面板提示「结果太多，换个更精确的词」。
   */
  const searchProject = (root, options = {}) => {
    const query = typeof options.query === 'string' ? options.query : ''
    if (!query) throw new MolingError('缺少 query 参数')
    if (query.length > 200) throw new MolingError('查询串太长（上限 200 字符）')

    const caseSensitive = options.caseSensitive === true
    const useRegex = options.regex === true
    const includeAux = options.includeAux === true
    const maxResults = Math.min(Math.max(Number(options.maxResults) || 500, 1), 2000)

    let pattern
    try {
      pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } catch {
      throw new MolingError('正则写法有误')
    }
    let matcher
    try {
      matcher = new RegExp(pattern, caseSensitive ? 'g' : 'gi')
    } catch (error) {
      throw new MolingError(`正则无效：${error.message}`)
    }

    const files = scan(root).files.filter((entry) => entry.editable)
    const matches = []
    let scanned = 0
    let truncated = false
    let skipped = 0

    for (const entry of files) {
      if (matches.length >= maxResults) { truncated = true; break }
      if (!includeAux && AUX_EXT.has(entry.ext)) continue
      if (entry.size > MAX_TEXT_BYTES) { skipped += 1; continue }
      let text = ''
      try { text = readFileSync(join(root, entry.rel), 'utf8') } catch { skipped += 1; continue }
      scanned += 1
      const lines = text.split(/\r\n|\n|\r/)
      for (let index = 0; index < lines.length; index++) {
        if (matches.length >= maxResults) { truncated = true; break }
        const lineText = lines[index]
        if (!lineText) continue
        matcher.lastIndex = 0
        let hit
        while ((hit = matcher.exec(lineText)) !== null) {
          matches.push({
            rel: entry.rel,
            line: index + 1,
            col: hit.index + 1,
            // 命中那一行原文（面板里做上下文预览）；太长就截断，别把整行塞进响应
            text: lineText.length > 400 ? lineText.slice(0, 400) + '…' : lineText,
            from: hit.index,
            to: hit.index + Math.max(hit[0].length, 1)
          })
          if (hit[0].length === 0) matcher.lastIndex += 1
          if (matches.length >= maxResults) { truncated = true; break }
        }
      }
    }

    return {
      root,
      query,
      matches,
      truncated,
      scanned,
      skipped,
      // 命中的文件数（面板里按文件分组显示标题）
      files: [...new Set(matches.map((item) => item.rel))].length
    }
  }

  /**
   * 读项目里所有 `.bib`，抽出文献 key（`\cite{}` 补全用）。
   * 解析刻意宽松：`@article{key,` 就算一条；`title/author/year` 有就顺带取（给弹窗做副标题）。
   * 不引 bibtex 解析器 —— 补全只需要 key，把整个 BibTeX 语法搬进来不值得。
   */
  const readBibEntries = (root) => {
    const entries = []
    const seen = new Set()
    const files = scan(root).files.filter((entry) => entry.ext === '.bib' && entry.size <= MAX_TEXT_BYTES)
    for (const file of files) {
      let text = ''
      try { text = readFileSync(join(root, file.rel), 'utf8') } catch { continue }
      // 逐条切：@类型{key, ... } —— 用非贪婪到下一个 @ 或文末，够宽松也不会跨条串味
      const re = /@([A-Za-z]+)\s*\{\s*([^,\s}]+)\s*,([\s\S]*?)(?=\n\s*@|\s*$)/g
      let hit
      while ((hit = re.exec(text)) !== null) {
        const type = String(hit[1] || '').toLowerCase()
        if (type === 'string' || type === 'comment' || type === 'preamble') continue
        const key = hit[2]
        if (!key || seen.has(key)) continue
        seen.add(key)
        const body = hit[3] || ''
        const field = (name) => {
          const m = new RegExp(name + '\\s*=\\s*(?:\\{([^{}]*)\\}|"([^"]*)"|([\\w-]+))', 'i').exec(body)
          if (!m) return ''
          const raw = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]
          return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        }
        entries.push({
          key,
          type,
          title: field('title'),
          author: field('author'),
          year: field('year'),
          file: file.rel
        })
        if (entries.length >= 2000) return entries
      }
    }
    return entries
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

  /**
   * 内置模板清单（lib/templates/index.json）。
   * 读不到就当"没有模板"——旧版本安装包或裁剪过的分发不该让启动页整块崩掉。
   */
  const templateIndex = () => {
    const file = join(TEMPLATES_DIR, 'index.json')
    if (!isFile(file)) return { templates: [], categories: [] }
    let parsed = null
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { parsed = null }
    const templates = Array.isArray(parsed?.templates) ? parsed.templates : []
    // 分类按模板里出现的先后顺序去重（index.json 已按桌面版导航排好）
    const categories = []
    for (const item of templates) {
      const name = typeof item?.category === 'string' ? item.category : ''
      if (name && !categories.includes(name)) categories.push(name)
    }
    return { templates, categories }
  }

  /** 模板文件清单：以 index.json 为准（不现场扫盘，避免把 .git 之类的东西也带出来）。 */
  const templateFiles = (item) => {
    const files = Array.isArray(item?.files) ? item.files.filter((rel) => typeof rel === 'string' && rel) : []
    return files.map((rel) => {
      // 只允许模板目录内的相对路径：`..` / 绝对路径一律挡掉
      const full = resolve(TEMPLATES_DIR, item.id, rel)
      if (!isUnder(join(TEMPLATES_DIR, item.id), full) || full === join(TEMPLATES_DIR, item.id)) {
        throw new MolingError(`模板文件路径非法：${rel}`)
      }
      return { rel: rel.split('\\').join('/'), full }
    })
  }

  /**
   * 按模板把一个新项目落地到 root 下。
   *   · 目标目录**非空** → 一律落到 `<root>/<模板id>[-n]/`，绝不把模板文件散进
   *     用户已有的项目里（踩过的坑：往一个有论文的目录里导模板，cls/sty/figures/
   *     全散在根上，还顺带一个 main.tex 抢走"进项目自动打开"的位置）
   *   · 空目录 → 直接落在 root 本身（用户选的就是它，别多套一层）
   *   · 模板文件按相对路径逐字节拷贝（cls/sty/图片都是二进制安全的）
   * 返回落地后的实际根目录、主文件名与写出的文件清单。
   */
  const useTemplate = (root, templateId) => {
    const { templates } = templateIndex()
    const item = templates.find((entry) => entry?.id === templateId)
    if (!item) throw new MolingError(`没有这个模板：${templateId || '(空)'}`)
    const files = templateFiles(item)
    if (files.length === 0) throw new MolingError(`模板 ${item.id} 没有文件清单`)

    // 目录里已经有东西（用户自己的项目、之前导入的残留）→ 换到一个干净的 <模板id> 子目录
    let occupied = false
    try { occupied = readdirSync(root).length > 0 } catch { occupied = false }
    let target = root
    let main = item.main || 'main.tex'
    if (occupied) {
      let name = item.id
      let index = 2
      while (existsSync(join(root, name))) { name = `${item.id}-${index}`; index += 1 }
      target = join(root, name)
    }
    mkdirSync(target, { recursive: true })

    const created = []
    for (const file of files) {
      if (!isFile(file.full)) throw new MolingError(`模板文件缺失：${item.id}/${file.rel}`)
      const dest = join(target, file.rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(file.full, dest)
      created.push(file.rel)
    }
    return {
      template: { id: item.id, name: item.name, category: item.category, engine: item.engine },
      root: target,
      main,
      files: created
    }
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

    /** 全项目搜索：一次请求回全部命中（面板「在项目里找」）。 */
    search(payload) {
      const root = acceptRoot(payload?.root)
      return searchProject(root, payload || {})
    },

    /**
     * 项目里所有 .bib 的文献条目（`\cite{` 补全用）。
     * 面板原来只扫当前文档的 `\bibitem`，用 BibTeX 的项目一个都补不出来。
     * 解析刻意写得宽松：只要 `@类型{key,` 就算一条，title/author/year 有就带上（给补全弹窗做副标题）。
     */
    bib(payload) {
      const root = acceptRoot(payload?.root)
      return { entries: readBibEntries(root) }
    },

    /**
     * 内置模板清单（启动页「模板」区用）。
     * 只回元数据与文件清单，**不回内容** —— 模板合计 1.1 MB，逐个传会让首屏变慢；
     * 内容在 `use-template` 落地时由宿主直接从磁盘拷。
     */
    templates() {
      const { templates, categories } = templateIndex()
      return {
        templates: templates.map((item) => ({
          id: item.id,
          name: item.name,
          category: item.category,
          engine: item.engine,
          description: item.description,
          accent: item.accent,
          layout: item.layout,
          main: item.main || 'main.tex',
          files: Array.isArray(item.files) ? item.files.length : 0,
          bytes: Number(item.bytes) || 0
        })),
        categories
      }
    },

    /**
     * 按模板落地一个新项目：把模板文件（主 tex + cls/sty/图片）拷进 root。
     * 目标里已有 main.tex 时自动换到 `<root>/<模板id>[-n]/`，不覆盖已有项目。
     */
    'use-template'(payload) {
      const root = acceptRoot(payload?.root)
      return useTemplate(root, payload?.template)
    },

    /**
     * 外部改动探测（面板「大模型改了 tex → 编辑区自动刷新」的轮询接口）：
     *   {root, paths:[rel…]} → {entries:{rel:{mtime,size,exists}}, dirs:'<目录指纹>'}
     * 只 stat 不读内容：N 次 statSync + 一次目录指纹，比整棵 tree 轻得多。
     * `dirs` 负责「新建/删除/重命名」（按目录里的名字表算，不依赖 mtime 粒度），
     * `entries` 负责已打开文件的内容改动。
     * 越界或不存在的路径回 exists:false，不让一个坏路径把整轮轮询掀翻。
     */
    stat(payload) {
      const root = acceptRoot(payload?.root)
      const wanted = Array.isArray(payload?.paths) ? payload.paths.slice(0, 64) : []
      const entries = {}
      for (const rel of wanted) {
        if (typeof rel !== 'string' || rel.length === 0) continue
        let full = null
        try { full = safeResolve(root, rel) } catch { full = null }
        let info = null
        if (full) { try { info = statSync(full) } catch { info = null } }
        entries[rel] = info && info.isFile()
          ? { exists: true, mtime: info.mtimeMs, size: info.size }
          : { exists: false, mtime: 0, size: 0 }
      }
      return { entries, dirs: dirFingerprint(root) }
    },

    async compile(payload, signal) {
      const root = acceptRoot(payload?.root)
      const target = safeResolve(root, payload?.file)
      if (!isFile(target)) throw new MolingError(`源文件不存在：${target}`)
      const env = getTexEnv() || {}
      const engine = typeof payload?.engine === 'string' && payload.engine ? payload.engine : (env.engine || 'auto')
      const mode = ['quick', 'once', 'full', 'clean'].includes(payload?.mode) ? payload.mode : 'full'
      // 记下用户这次用的档位：工具侧（latex_compile）没显式传参时沿用它，
      // 免得两边一个 quick 一个 full、一个 xelatex 一个 pdflatex 编同一份文档。
      lastCompile = { root, file: target, mode, engine, at: Date.now() }
      const result = await compileDocument({
        filePath: target,
        engine,
        mode,
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
        // 逐页尺寸：幻灯片（4:3 / 16:9）与混合横竖页靠它算每页长宽比，
        // 不然一律按 A4 占位 → 页面图被纵向拉伸
        pageSizes: pdfInfo.pageSizes,
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

  return { endpoints, allowedRoots, acceptRoot, safeResolve, openedRoots, workspacesView, texStatus, lastCompileOf: () => lastCompile }
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

  const handle = async function handle(req, res) {
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
  // 供宿主侧工具（latex_compile 等）解析相对路径用：不依赖会话 cwd
  handle.core = core
  return handle
}
