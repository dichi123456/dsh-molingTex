/**
 * dsh-plugin-moling-latex —— 宿主半侧（工具 + 面板数据通道）
 *
 * 两种消费方式：
 *   1. DSH 工具：让本体里的 Agent 直接编译论文、看报错、定位源码行、读大纲；
 *   2. HTTP 路由 /moling-latex：供浏览器半侧（lib/client.js）的「moling_latex」侧栏面板使用。
 *
 * 工具清单：
 *   latex_compile  编译 .tex（quick / full / clean 三种模式）
 *   latex_status   探测 TeX Live / MiKTeX 与各引擎路径
 *   latex_synctex  SyncTeX 正反向同步（源码行 ↔ PDF 坐标）
 *   latex_clean    清理 .aux/.log/.synctex.gz 等辅助文件
 *   latex_outline  解析章节大纲、\input 依赖、\label/\cite 数量
 *
 * 本文件不 import 任何 @deepseek-ai/* 包：插件以 link: 方式安装，Node 会按真实路径
 * 解析依赖，而真实路径下没有 profile 的 node_modules。因此这里手写标准 JSON Schema，
 * 并在 execute 里自行校验参数（defineTool 只做 DSL 编译，并非必需）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve as resolvePath } from 'node:path'
import {
  cleanAuxFiles,
  compileDocument,
  detectTexLive,
  findOnPath,
  getEnginePath,
  parseOutline,
  readMolingConfig,
  runProcess
} from './latex.js'
import { synctexBackward, synctexForward } from './synctex.js'
import { createPanelHandler, API_PREFIX } from './server.js'

export const name = 'moling_latex'
export const inject = ['tools']

const ENGINE_NAMES = ['xelatex', 'pdflatex', 'lualatex', 'latexmk']

/** 统一的文本 ContentBlock。 */
const text = (value) => [{ type: 'text', text: value }]

/* ------------------------------------------------------------------ *
 * 参数解析与校验辅助
 * ------------------------------------------------------------------ */

/** 会话工作区（未声明时回退进程 cwd）。 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** 把模型给的路径解析成绝对路径：支持相对工作区、`~`，并容忍省略 .tex 后缀。 */
function resolveTexPath(input, exec) {
  let raw = String(input).trim().replace(/^"(.*)"$/, '$1')
  if (raw.startsWith('~')) {
    raw = resolvePath(process.env.USERPROFILE || process.env.HOME || '', raw.slice(1).replace(/^[\\/]+/, ''))
  }
  let full = isAbsolute(raw) ? raw : resolvePath(sessionCwd(exec), raw)
  if (!existsSync(full) && !extname(full)) {
    const withExt = `${full}.tex`
    if (existsSync(withExt)) full = withExt
  }
  return full
}

function asObject(args) {
  return args !== null && typeof args === 'object' ? args : {}
}

function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`缺少必填参数 ${key}（应为非空字符串）`)
  }
  return value.trim()
}

function optionalEnum(args, key, allowed) {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`参数 ${key} 必须是 ${allowed.join(' | ')} 之一`)
  }
  return value
}

function optionalNumber(args, key) {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`参数 ${key} 必须是数字`)
  return parsed
}

/** 日志值截断：只保留末尾 maxChars，避免把整份 .log 写进会话记录。 */
function tail(text_, maxChars) {
  const value = String(text_ || '')
  if (value.length <= maxChars) return value
  return `…（已截断前 ${value.length - maxChars} 字符）\n${value.slice(-maxChars)}`
}

/** `file:line` 形式的定位串。 */
function locate(issue) {
  if (!issue?.file) return '(未知位置)'
  return issue.line ? `${issue.file}:${issue.line}` : issue.file
}

/* ------------------------------------------------------------------ *
 * 结果渲染
 * ------------------------------------------------------------------ */

const MAX_LISTED_ERRORS = 30
const MAX_LISTED_WARNINGS = 15

function formatCompile(value) {
  const lines = []
  const seconds = (value.durationMs / 1000).toFixed(1)
  const bib = value.bibtex?.ran ? (value.bibtex.success ? ' + bibtex✓' : ' + bibtex✗') : ''
  lines.push(`${value.success ? '编译成功' : '编译失败'} | 引擎 ${value.engine} | ${seconds}s | ${value.passes} 趟${bib}`)
  lines.push(`源文件: ${value.file}`)
  lines.push(`PDF: ${value.pdfPath || '(未生成)'}`)
  if (value.cleaned?.length) lines.push(`已清理 ${value.cleaned.length} 个辅助文件`)

  if (value.errors?.length) {
    lines.push('', `错误 (${value.errors.length}):`)
    for (const issue of value.errors.slice(0, MAX_LISTED_ERRORS)) {
      lines.push(`  ${locate(issue)} — ${issue.message}`)
    }
    if (value.errors.length > MAX_LISTED_ERRORS) {
      lines.push(`  …另有 ${value.errors.length - MAX_LISTED_ERRORS} 条`)
    }
  }

  if (value.warnings?.length) {
    lines.push('', `警告 (${value.warnings.length}):`)
    for (const issue of value.warnings.slice(0, MAX_LISTED_WARNINGS)) {
      lines.push(`  ${locate(issue)} — ${issue.message}`)
    }
    if (value.warnings.length > MAX_LISTED_WARNINGS) {
      lines.push(`  …另有 ${value.warnings.length - MAX_LISTED_WARNINGS} 条`)
    }
  }

  if (!value.success && value.logTail) {
    lines.push('', '日志尾部:', trimLog(value.logTail))
  }
  return lines.join('\n')
}

/** 日志去噪：丢掉 LaTeX Font Info 之类的例行流水，只留最后 40 行。 */
const LOG_NOISE = /^(LaTeX Font Info:|File: |Package: |\)$|\($)/

function trimLog(log) {
  const kept = String(log)
    .split(/\r?\n/)
    .filter((line) => !LOG_NOISE.test(line.trim()))
  const tailLines = kept.slice(-40)
  const omitted = kept.length - tailLines.length
  return omitted > 0
    ? `…（略去前 ${omitted} 行例行输出）\n${tailLines.join('\n')}`
    : tailLines.join('\n')
}

function formatStatus(value) {
  const lines = []
  lines.push(value.found ? `TeX 发行版: 已找到（来源 ${value.source}）` : 'TeX 发行版: 未找到')
  if (value.binDir) lines.push(`bin 目录: ${value.binDir}`)
  if (value.version) lines.push(`版本: ${value.version}`)
  const engines = Object.entries(value.engines || {})
    .map(([engine, path]) => `  ${engine}: ${path || '(缺失)'}`)
  if (engines.length) lines.push('引擎:', ...engines)
  if (value.appConfigPath) {
    lines.push(`墨灵TeX 配置: ${value.appConfigPath}（texlivePath=${value.appConfigTexlivePath || '空'}）`)
  }
  if (!value.found) {
    lines.push('', '提示：安装 TeX Live 后重开 DSH，或在插件 config 里指定 texlivePath（bin 目录）。')
  }
  return lines.join('\n')
}

function formatOutline(value) {
  const lines = [`${value.file}（共 ${value.lines} 行；\\label ${value.labels} 个；\\cite ${value.cites} 处）`]
  if (value.sections?.length) {
    lines.push('', '结构:')
    for (const section of value.sections) {
      lines.push(`${'  '.repeat(section.level)}${section.title}  (${section.command}, L${section.line})`)
    }
  } else {
    lines.push('', '结构: （未发现章节命令）')
  }
  if (value.inputs?.length) {
    lines.push('', '依赖:')
    for (const input of value.inputs) lines.push(`  ${input.path}  (L${input.line})`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 输出 schema 片段
 * ------------------------------------------------------------------ */

const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] }
const ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line', 'message'],
  properties: { file: NULLABLE_STRING, line: NULLABLE_INTEGER, message: { type: 'string' } }
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const settings = {
    texlivePath: typeof config.texlivePath === 'string' ? config.texlivePath : '',
    engine: typeof config.engine === 'string' && config.engine ? config.engine : 'auto',
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 120000,
    maxLogChars: Number.isFinite(config.maxLogChars) && config.maxLogChars > 0 ? config.maxLogChars : 8000,
    allowedRoots: Array.isArray(config.allowedRoots)
      ? config.allowedRoots.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      : []
  }

  /** 解析一次 TeX 环境：插件配置 > 墨灵TeX 配置 > 自动探测。 */
  const resolveTexEnv = () => {
    const moling = readMolingConfig()
    const preferred = settings.texlivePath
      || (moling?.config?.texlivePath ? String(moling.config.texlivePath) : '')
    const detection = detectTexLive(preferred || null)
    return {
      detection,
      texlivePath: detection.path,
      moling,
      preferred
    }
  }

  /* ------------------------------ latex_compile ------------------------------ */

  ctx.tools.register({
    name: 'latex_compile',
    description:
      '编译一个 LaTeX 文档并返回错误/警告定位。mode=quick 单趟 draft（最快出 PDF）；'
      + 'mode=full 完整流程（主编译 → 需要时 bibtex → 再编译 → 视 Rerun 提示补一趟）；'
      + 'mode=clean 先删辅助文件再走 full。引擎缺省按导言区自动识别（ctex/中文 → xelatex，'
      + 'IEEEtran/elsarticle/article → pdflatex），可显式指定 xelatex/pdflatex/lualatex/latexmk。'
      + '失败时返回带 file:line 的错误列表与日志尾部，便于直接跳转修改。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要编译的 .tex 文件；绝对路径，或以会话工作区为基准的相对路径（可省略 .tex 后缀）。' },
        mode: { type: 'string', enum: ['quick', 'full', 'clean'], description: '编译模式，缺省 full。' },
        engine: { type: 'string', enum: ['auto', ...ENGINE_NAMES], description: '编译引擎，缺省 auto（按导言区识别）。' },
        texlivePath: { type: 'string', description: 'TeX Live/MiKTeX 的 bin 目录；缺省用插件配置或 墨灵TeX 的配置，再不行自动探测。' },
        timeoutMs: { type: 'number', description: '整体超时（毫秒），缺省 120000；超时会终结整棵进程树。' }
      },
      required: ['file']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['success', 'file', 'engine', 'enginePath', 'pdfPath', 'logPath', 'exitCode', 'durationMs', 'passes', 'bibtex', 'cleaned', 'errors', 'warnings', 'logTail'],
        properties: {
          success: { type: 'boolean' },
          file: { type: 'string' },
          engine: { type: 'string' },
          enginePath: { type: 'string' },
          pdfPath: NULLABLE_STRING,
          logPath: NULLABLE_STRING,
          exitCode: NULLABLE_INTEGER,
          durationMs: { type: 'number' },
          passes: { type: 'integer' },
          bibtex: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['ran', 'success'],
                properties: { ran: { type: 'boolean' }, success: { type: 'boolean' } }
              }
            ]
          },
          cleaned: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: ISSUE_SCHEMA },
          warnings: { type: 'array', items: ISSUE_SCHEMA },
          logTail: { type: 'string' }
        }
      },
      render: (_args, value) => text(formatCompile(value))
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: `latex ${asObject(args).mode || 'full'} ${basename(String(asObject(args).file || ''))}`,
      description: '编译 LaTeX 文档'
    }),
    async execute(args, exec) {
      const input = asObject(args)
      const filePath = resolveTexPath(requireString(input, 'file'), exec)
      const mode = optionalEnum(input, 'mode', ['quick', 'full', 'clean']) || 'full'
      const engine = optionalEnum(input, 'engine', ['auto', ...ENGINE_NAMES]) || settings.engine
      const texlivePath = typeof input.texlivePath === 'string' && input.texlivePath.trim()
        ? input.texlivePath.trim()
        : resolveTexEnv().texlivePath
      const timeoutMs = optionalNumber(input, 'timeoutMs') || settings.timeoutMs

      const result = await compileDocument({
        filePath,
        engine,
        mode,
        texlivePath,
        timeoutMs,
        signal: exec?.signal
      })
      return { ...result, logTail: tail(result.logTail, settings.maxLogChars) }
    }
  })

  /* ------------------------------ latex_status ------------------------------ */

  ctx.tools.register({
    name: 'latex_status',
    description:
      '探测本机 TeX 发行版：TeX Live / MiKTeX 的 bin 目录、版本，以及 xelatex/pdflatex/lualatex/'
      + 'latexmk/bibtex/synctex 各自是否能找到。编译报「找不到引擎」时先跑这个。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found', 'source', 'binDir', 'version', 'engines', 'appConfigPath', 'appConfigTexlivePath'],
        properties: {
          found: { type: 'boolean' },
          source: { type: 'string' },
          binDir: NULLABLE_STRING,
          version: NULLABLE_STRING,
          engines: { type: 'object' },
          appConfigPath: NULLABLE_STRING,
          appConfigTexlivePath: NULLABLE_STRING
        }
      },
      render: (_args, value) => text(formatStatus(value))
    },
    presentCall: () => ({ card: 'generic', title: 'latex_status', kind: 'execute' }),
    async execute(_args, exec) {
      const { detection, moling, preferred } = resolveTexEnv()

      const engines = {}
      for (const engine of [...ENGINE_NAMES, 'bibtex', 'synctex']) {
        engines[engine] = getEnginePath(detection.path, engine) || findOnPath(engine)
      }

      let version = null
      if (detection.found) {
        const result = await runProcess(detection.engine || 'xelatex', ['--version'], { timeoutMs: 15000, signal: exec?.signal })
        const firstLine = `${result.stdout}${result.stderr}`.split(/\r?\n/).find((line) => line.trim().length > 0)
        version = firstLine ? firstLine.trim() : null
      }

      return {
        found: detection.found,
        source: detection.source,
        binDir: detection.path,
        version,
        engines,
        appConfigPath: moling?.path ?? null,
        appConfigTexlivePath: moling?.config?.texlivePath ? String(moling.config.texlivePath) : (preferred || null)
      }
    }
  })

  /* ------------------------------ latex_synctex ------------------------------ */

  ctx.tools.register({
    name: 'latex_synctex',
    description:
      'SyncTeX 双向同步。direction=forward：由源码位置（tex + line）求 PDF 的 page/x/y；'
      + 'direction=backward：由 PDF 坐标（pdf + page + x + y，y 自页面顶部算起，单位 pt）求源码文件与行号。'
      + '需要先编译并生成 .synctex.gz（latex_compile 默认带 -synctex=1）。',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['forward', 'backward'], description: '同步方向。' },
        pdf: { type: 'string', description: 'PDF 文件路径（绝对或相对工作区）。' },
        tex: { type: 'string', description: 'forward 必填：源 .tex 文件路径。' },
        line: { type: 'integer', description: 'forward 必填：源码行号。' },
        page: { type: 'integer', description: 'backward 必填：PDF 页码（从 1 开始）。' },
        x: { type: 'number', description: 'backward 必填：页面内水平坐标（pt）。' },
        y: { type: 'number', description: 'backward 必填：自页面顶部的垂直坐标（pt）。' },
        texlivePath: { type: 'string', description: 'TeX Live/MiKTeX 的 bin 目录，缺省自动探测。' }
      },
      required: ['direction', 'pdf']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['success', 'direction', 'page', 'x', 'y', 'line', 'file', 'error'],
        properties: {
          success: { type: 'boolean' },
          direction: { type: 'string' },
          page: NULLABLE_INTEGER,
          x: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          y: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          line: NULLABLE_INTEGER,
          file: NULLABLE_STRING,
          error: NULLABLE_STRING
        }
      },
      render: (_args, value) => {
        if (!value.success) return text(`SyncTeX ${value.direction} 失败：${value.error}`)
        return value.direction === 'forward'
          ? text(`同步到 PDF: 第 ${value.page} 页 x=${value.x} y=${value.y}`)
          : text(`同步到源码: ${value.file}:${value.line}`)
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `latex_synctex ${asObject(args).direction || ''}`.trim(),
      kind: 'other'
    }),
    async execute(args, exec) {
      const input = asObject(args)
      const direction = optionalEnum(input, 'direction', ['forward', 'backward'])
      if (!direction) throw new Error('参数 direction 必须是 forward | backward')
      const pdfPath = resolveTexPath(requireString(input, 'pdf'), exec)
      const texlivePath = typeof input.texlivePath === 'string' && input.texlivePath.trim()
        ? input.texlivePath.trim()
        : resolveTexEnv().texlivePath

      if (direction === 'forward') {
        const texPath = resolveTexPath(requireString(input, 'tex'), exec)
        const line = optionalNumber(input, 'line')
        if (line === undefined) throw new Error('forward 方向需要参数 line')
        const result = await synctexForward(texPath, Math.round(line), pdfPath, { texlivePath, signal: exec?.signal })
        return { direction, page: result.page, x: result.x, y: result.y, line: null, file: null, success: result.success, error: result.error ?? null }
      }

      const page = optionalNumber(input, 'page')
      const x = optionalNumber(input, 'x')
      const y = optionalNumber(input, 'y')
      if (page === undefined || x === undefined || y === undefined) {
        throw new Error('backward 方向需要参数 page、x、y')
      }
      const result = await synctexBackward(Math.round(page), x, y, pdfPath, { texlivePath, signal: exec?.signal })
      return { direction, page: null, x: null, y: null, line: result.line, file: result.file, success: result.success, error: result.error ?? null }
    }
  })

  /* ------------------------------- latex_clean ------------------------------- */

  ctx.tools.register({
    name: 'latex_clean',
    description:
      '删除某个 .tex 主文件对应的辅助文件（.aux/.log/.toc/.out/.bbl/.synctex.gz/.fls/'
      + '.fdb_latexmk/.nav/.snm 等），用于「从头编译」或清理仓库。不删除 .tex/.pdf/.bib。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '主 .tex 文件（绝对或相对会话工作区）。' }
      },
      required: ['file']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'deleted'],
        properties: { file: { type: 'string' }, deleted: { type: 'array', items: { type: 'string' } } }
      },
      render: (_args, value) => text(
        value.deleted.length
          ? `已删除 ${value.deleted.length} 个辅助文件：\n${value.deleted.map((n) => `  ${n}`).join('\n')}`
          : '没有需要清理的辅助文件。'
      )
    },
    presentCall: (args) => ({ card: 'generic', title: `latex_clean ${basename(String(asObject(args).file || ''))}`, kind: 'delete' }),
    execute(args, exec) {
      const input = asObject(args)
      const filePath = resolveTexPath(requireString(input, 'file'), exec)
      if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`)
      return { file: filePath, deleted: cleanAuxFiles(filePath) }
    }
  })

  /* ------------------------------ latex_outline ------------------------------ */

  ctx.tools.register({
    name: 'latex_outline',
    description:
      '解析 .tex 的结构：\\part/\\chapter/\\section/\\subsection/\\subsubsection/\\paragraph 的标题与行号，'
      + '\\input/\\include 依赖，以及 \\label 与 \\cite 的数量。用于在不读全文的情况下定位章节。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要解析的 .tex 文件（绝对或相对会话工作区）。' }
      },
      required: ['file']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'lines', 'labels', 'cites', 'sections', 'inputs'],
        properties: {
          file: { type: 'string' },
          lines: { type: 'integer' },
          labels: { type: 'integer' },
          cites: { type: 'integer' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['level', 'command', 'title', 'line'],
              properties: {
                level: { type: 'integer' },
                command: { type: 'string' },
                title: { type: 'string' },
                line: { type: 'integer' }
              }
            }
          },
          inputs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'line'],
              properties: { path: { type: 'string' }, line: { type: 'integer' } }
            }
          }
        }
      },
      render: (_args, value) => text(formatOutline(value))
    },
    presentCall: (args) => ({ card: 'read', title: `latex_outline ${basename(String(asObject(args).file || ''))}`, path: String(asObject(args).file || '') }),
    execute(args, exec) {
      const input = asObject(args)
      const filePath = resolveTexPath(requireString(input, 'file'), exec)
      if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`)
      let source = ''
      try {
        if (statSync(filePath).size > 8 * 1024 * 1024) throw new Error('文件过大（>8MB）')
        source = readFileSync(filePath, 'utf8')
      } catch (error) {
        throw new Error(`读取失败：${String(error?.message || error)}`)
      }
      return parseOutline(source, filePath)
    }
  })

  /* ------------------------- 浏览器半侧的数据通道 ------------------------- */

  // 已注册工作区（可选服务，取不到就让面板走 config.allowedRoots / 任意目录）。
  const getWorkspaces = () => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
      return registry?.list?.() ?? []
    } catch {
      return []
    }
  }

  const panelDeps = {
    getConfig: () => settings,
    getWorkspaces,
    getTexEnv: () => {
      const env = resolveTexEnv()
      return { texlivePath: env.texlivePath, engine: settings.engine, timeoutMs: settings.timeoutMs }
    }
  }

  /* 面板的数据通道：/moling/api 前缀 HTTP 路由。
     与同机插件 dsh-drawai 的做法一致（它用 fetch('/drawai/api/save') 保存画布）：
     面板在浏览器里同源请求，不需要 CORS、不需要令牌。
     webServer 在 headless 组合下不存在，所以用可选注入；工具仍照常提供。 */
  const handler = createPanelHandler(panelDeps)
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'moling_latex: panel api route'
    )
  })
}
