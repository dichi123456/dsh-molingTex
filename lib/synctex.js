/**
 * SyncTeX 双向同步 —— 由 墨灵TeX 的 electron/synctex.ts 移植。
 *
 * TeX Live 2024 产出的是压缩式 synctex，自研解析器不可靠，直接调用官方 CLI。
 *   view -i "line:col:file" -o pdf   源码 → PDF
 *   edit -o "page:x:y:pdf"           PDF → 源码（y 自页面顶部算起）
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getEnginePath, runProcess } from './latex.js'

/** 找 synctex 可执行文件：显式路径 → 由 xelatex 推断 → PATH 裸命令。 */
export function findSynctexBin(texlivePath) {
  const candidates = []
  if (texlivePath) {
    candidates.push(join(texlivePath, 'synctex.exe'))
    candidates.push(join(texlivePath, 'synctex'))
  }
  const engine = getEnginePath(texlivePath || null, 'xelatex')
  if (engine) {
    const binDir = dirname(engine)
    candidates.push(join(binDir, 'synctex.exe'))
    candidates.push(join(binDir, 'synctex'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // 交给 PATH 解析
  return 'synctex'
}

/** 运行 synctex：结果可能写在 stderr，也可能非零退出但仍有有效输出。 */
async function runSynctex(bin, args, signal) {
  const result = await runProcess(bin, args, { timeoutMs: 8000, signal })
  const out = `${result.stdout}${result.stderr}`
  if (out.includes('SyncTeX result begin')) return out
  throw new Error(result.error || out.trim() || 'synctex 无输出')
}

/** 正向同步：源码行 → PDF 页码与坐标。 */
export async function synctexForward(texPath, line, pdfPath, options = {}) {
  const { texlivePath = null, signal } = options
  try {
    if (!existsSync(pdfPath)) {
      return { success: false, page: null, x: null, y: null, error: `PDF 文件不存在：${pdfPath}` }
    }
    const bin = findSynctexBin(texlivePath)
    const out = await runSynctex(bin, ['view', '-i', `${line}:1:${texPath}`, '-o', pdfPath], signal)

    const pageM = out.match(/Page:(\d+)/)
    const xM = out.match(/x:([\d.-]+)/)
    const yM = out.match(/y:([\d.-]+)/)
    if (!pageM) return { success: false, page: null, x: null, y: null, error: 'synctex 未返回页码' }

    return {
      success: true,
      page: Number.parseInt(pageM[1], 10),
      x: xM ? Number.parseFloat(xM[1]) : null,
      y: yM ? Number.parseFloat(yM[1]) : null
    }
  } catch (error) {
    return { success: false, page: null, x: null, y: null, error: String(error?.message || error) }
  }
}

/** 反向同步：PDF 坐标 → 源码文件与行号。 */
export async function synctexBackward(page, x, y, pdfPath, options = {}) {
  const { texlivePath = null, signal } = options
  try {
    if (!existsSync(pdfPath)) {
      return { success: false, line: null, file: null, error: `PDF 文件不存在：${pdfPath}` }
    }
    const bin = findSynctexBin(texlivePath)
    const arg = `${page}:${Number(x).toFixed(2)}:${Number(y).toFixed(2)}:${pdfPath}`
    const out = await runSynctex(bin, ['edit', '-o', arg], signal)

    const lineM = out.match(/Line:(\d+)/)
    const fileM = out.match(/Input:(.+)$/m)
    if (!lineM) return { success: false, line: null, file: null, error: 'synctex 未返回行号' }

    return {
      success: true,
      line: Number.parseInt(lineM[1], 10),
      file: fileM ? fileM[1].trim() : null
    }
  } catch (error) {
    return { success: false, line: null, file: null, error: String(error?.message || error) }
  }
}
