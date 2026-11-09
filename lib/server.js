/**
 * moling_latex 宿主侧的数据通道：一条挂在 `/moling/api` 的前缀 HTTP 路由。
 *
 *   POST /moling/api/<endpoint>   JSON 请求体 = 端点入参，返回 { ok, value } / { ok, error }
 *   GET  /moling/api/ping         探活（浏览器 / 脚本都能打）
 *
 * 端点：ping / status / workspaces / open-root / open-file / tree /
 *       read-file / write-file / compile / clean / pdf
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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { cleanAuxFiles, compileDocument, detectTexLive, findOnPath, getEnginePath, runProcess } from './latex.js'

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

  const readPdf = (root, relPath) => {
    const full = safeResolve(root, relPath)
    if (!isFile(full) || extname(full).toLowerCase() !== '.pdf') throw new MolingError('PDF 不存在')
    const size = statSync(full).size
    if (size > MAX_PDF_BYTES) throw new MolingError(`PDF 过大（${size} 字节）`)
    const bytes = readFileSync(full)
    return {
      rel: relative(root, full).split(sep).join('/'),
      name: basename(full),
      bytes: bytes.length,
      mtime: statSync(full).mtimeMs,
      base64: bytes.toString('base64')
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

    clean(payload) {
      const root = acceptRoot(payload?.root)
      const target = safeResolve(root, payload?.file)
      if (!isFile(target)) throw new MolingError(`文件不存在：${target}`)
      return { file: target, deleted: cleanAuxFiles(target) }
    },

    pdf(payload) {
      const root = acceptRoot(payload?.root)
      return readPdf(root, payload?.path)
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

function sendBytes(res, code, bytes, type) {
  res.writeHead(code, { 'content-type': type, 'content-length': String(bytes.length), 'cache-control': 'no-store' })
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
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      const status = error instanceof MolingError ? 400 : 500
      sendJson(res, status, { ok: false, error: String(error?.message || error) })
    }
  }
}
