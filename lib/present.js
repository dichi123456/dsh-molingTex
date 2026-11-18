/**
 * 观众窗：/moling/present
 *
 * 为什么观众窗不做成第二个 DSH 窗口：桌面版主进程给主窗装了
 *   window.webContents.setWindowOpenHandler(...) -> 一律 { action: 'deny' }
 * 于是 about:blank 的 window.open 连原生窗口都建不出来（用户实测：任务栏里连闪烁
 * 都没有）。但同一处对 http(s) URL 会走 shell.openExternal —— 所以观众页改成
 * 开在系统默认浏览器里，那里是货真价实的独立窗口，可以拖到第二块屏、F11 全屏。
 *
 * 代价：两边是两个浏览器进程，BroadcastChannel 跨不过去。两窗同步因此改走宿主
 * 中转：主窗 POST 放映状态、观众页轮询；观众页 POST 按键、主窗轮询取走。全是同机
 * 127.0.0.1 上每 220ms 一次的小 JSON，开销可以忽略。
 */

import { readBody } from './server.js'

export const PRESENT_PREFIX = '/moling/present'

/** 主窗多久没心跳就算放映断了（观众页据此显示「已结束」）。 */
const PRESENT_STALE_MS = 8000

/** 排队按键上限：观众连按几十下也不会撑爆内存。 */
const PRESENT_KEY_LIMIT = 32

function blankState() {
  return {
    root: '', path: '', rev: '', dpi: 144, title: '',
    page: 1, total: 0, black: false, white: false, badge: false,
    live: false, at: 0
  }
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

function asFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function asNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const AUDIENCE_CSS = [
  'html,body{margin:0;height:100%;background:#000;overflow:hidden}',
  '#stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}',
  '#cur{width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;display:block;background:#000}',
  '#black,#white{position:fixed;inset:0;display:none}',
  '#black{background:#000}',
  '#white{background:#fff}',
  '#badge{position:fixed;right:16px;bottom:12px;display:none;color:rgba(255,255,255,.66);font:14px/1 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}',
  '#poster{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#010409;color:#e6edf3}',
  '.poster-in{text-align:center;font:15px/1.9 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}',
  '.poster-in b{display:block;font-size:20px;margin-bottom:8px}',
  '.poster-in span{display:block;color:#8b949e;font-size:13px;margin-bottom:18px}',
  '#start{height:36px;padding:0 20px;border-radius:8px;border:1px solid #58a6ff;background:#21262d;color:#58a6ff;font:inherit;cursor:pointer}',
  '#hint{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:none;padding:7px 14px;border-radius:999px;background:rgba(1,4,9,.72);color:#c9d1d9;font:13px/1 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;pointer-events:none}'
].join('')

const AUDIENCE_SCRIPT = [
  "var STATE_URL = '/moling/present/state'",
  "var KEY_URL = '/moling/present/key'",
  'var lastSrc = ""',
  'var sawLive = false',
  'var sawFullscreen = false',
  'var fsFail = false',
  'var lastBlack = false',
  'var lastWhite = false',
  'var polling = false',
  'function $(id) { return document.getElementById(id) }',
  '',
  'function pageUrl(s) {',
  '  if (!s || !s.path || !s.page) return ""',
  "  var url = '/moling/api/pdf-page?root=' + encodeURIComponent(s.root || '')",
  "    + '&path=' + encodeURIComponent(s.path) + '&page=' + s.page + '&dpi=' + (s.dpi || 144)",
  "  if (s.rev) url += '&v=' + encodeURIComponent(s.rev)",
  '  return url',
  '}',
  '',
  'function hidePoster() {',
  '  var poster = $("poster")',
  '  if (poster) poster.style.display = "none"',
  '}',
  '',
  'function showPoster(title, sub, button) {',
  '  var poster = $("poster")',
  '  if (!poster) return',
  '  var titleEl = $("poster-title")',
  '  if (poster.style.display === "flex" && titleEl && titleEl.textContent === title) return',
  '  poster.style.display = "flex"',
  '  if (titleEl) titleEl.textContent = title',
  '  var subEl = $("poster-sub")',
  '  if (subEl) subEl.textContent = sub',
  '  var btn = $("start")',
  '  if (!btn) return',
  '  btn.textContent = button',
  '  btn.style.display = button ? "inline-block" : "none"',
  '}',
  '',
  'function inFullscreen() {',
  '  return !!(document.fullscreenElement || document.webkitFullscreenElement)',
  '}',
  '',
  'function syncHint() {',
  '  var hint = $("hint")',
  '  if (!hint) return',
  '  var poster = $("poster")',
  '  var posterOn = poster && poster.style.display !== "none"',
  '  var want = sawLive && !posterOn && !inFullscreen() && !lastBlack && !lastWhite',
  '  hint.style.display = want ? "block" : "none"',
  '}',
  '',
  'function begin() {',
  '  hidePoster()',
  '  fsFail = false',
  '  var el = document.documentElement',
  '  var req = el.requestFullscreen || el.webkitRequestFullscreen',
  '  if (!req) { fsFail = true; syncHint(); return false }',
  '  try {',
  '    var p = req.call(el)',
  '    if (p && p.then) {',
  '      p.then(function () { sawFullscreen = true; syncHint() }).catch(function () { fsFail = true; syncHint() })',
  '    } else {',
  '      sawFullscreen = true',
  '    }',
  '    syncHint()',
  '    return true',
  '  } catch (e) { fsFail = true; syncHint(); return false }',
  '}',
  '',
  'function postKey(key) {',
  '  try {',
  '    fetch(KEY_URL, {',
  '      method: "POST",',
  '      headers: { "content-type": "application/json" },',
  '      body: JSON.stringify({ key: key })',
  '    })',
  '  } catch (e) {}',
  '}',
  '',
  '// 换页：先离屏载完再换 <img> 的 src。',
  '// 观众屏分辨率高（288 / 400 dpi）时单页要 1~2 秒，直接换 src 会让投影上闪白、',
  '// 或者短暂显示上一页——观众看到的就是「翻页卡了一下」。',
  '// 载失败（网络抖掉 / 图没写完）就带一次 cache-buster 重试，别把空白留在投影上。',
  'function showPage(url) {',
  '  var want = url',
  '  var busy = $("cur")',
  '  var loader = new Image()',
  '  loader.onload = function () {',
  '    if (lastSrc !== want) return',
  '    busy.src = want',
  '  }',
  '  loader.onerror = function () {',
  '    if (lastSrc !== want) return',
  '    var retry = new Image()',
  '    retry.onload = function () { if (lastSrc === want) busy.src = want + "&r=" + Date.now() }',
  '    retry.src = want + "&r=" + Date.now()',
  '  }',
  '  loader.src = want',
  '}',
  '',
  'function apply(s) {',
  '  if (!s) return',
  '  if (!s.live) {',
  '    if (sawLive) showPoster("放映已结束", "主窗那边已经停止投屏，这个窗口可以直接关掉", "")',
  '    else showPoster("等待主窗开始放映…", "在主窗里点一下「投屏」，这一页就会自动出现画面", "")',
  '    syncHint()',
  '    return',
  '  }',
  '  sawLive = true',
  '  hidePoster()',
  '  var url = pageUrl(s)',
  '  if (url && url !== lastSrc) {',
  '    lastSrc = url',
  '    showPage(url)',
  '    var nextPage = (s.page || 1) + 1',
  '    if (!s.total || nextPage <= s.total) {',
  '      var pre = new Image()',
  '      pre.src = pageUrl({ root: s.root, path: s.path, rev: s.rev, dpi: s.dpi, page: nextPage })',
  '    }',
  '  }',
  '  lastBlack = !!s.black',
  '  lastWhite = !!s.white',
  '  $("black").style.display = s.black ? "block" : "none"',
  '  $("white").style.display = s.white ? "block" : "none"',
  '  $("badge").style.display = (s.badge && !s.black && !s.white) ? "block" : "none"',
  '  $("badge").textContent = (s.page || 1) + " / " + (s.total || 1)',
  '  syncHint()',
  '}',
  '',
  'function poll() {',
  '  if (polling) return',
  '  polling = true',
  '  fetch(STATE_URL, { cache: "no-store" })',
  '    .then(function (r) { return r.json() })',
  '    .then(function (j) { if (j && j.ok) apply(j.value) })',
  '    .catch(function () {})',
  '    .then(function () { polling = false; setTimeout(poll, 220) })',
  '}',
  '',
  'document.addEventListener("keydown", function (event) {',
  '  if (event.ctrlKey || event.metaKey || event.altKey) return',
  '  var key = event.key',
  '  if (key === "F5" || key === "F11" || key === "F12" || key === "Tab") return',
  '  postKey((event.shiftKey && key.length > 1 ? "Shift+" : "") + key)',
  '  if (key === " " || key === "Enter" || key === "Escape" || key === "PageUp" || key === "PageDown" || key.indexOf("Arrow") === 0) event.preventDefault()',
  '}, true)',
  '',
  'document.addEventListener("click", function (event) {',
  '  var target = event.target',
  '  if (target && target.id === "start") { begin(); return }',
  '  var poster = $("poster")',
  '  if (poster && poster.style.display !== "none") { begin(); return }',
  '  // 放映中还没拿到全屏：这一下点击就用来进全屏（浏览器要求该窗自身手势），不翻页',
  '  if (sawLive && !inFullscreen()) { begin(); if (!fsFail) return }',
  '  postKey("ArrowRight")',
  '})',
  '',
  'document.addEventListener("fullscreenchange", function () {',
  '  sawFullscreen = inFullscreen()',
  '  if (sawFullscreen) fsFail = false',
  '  syncHint()',
  '})',
  'document.addEventListener("webkitfullscreenchange", function () {',
  '  sawFullscreen = inFullscreen()',
  '  if (sawFullscreen) fsFail = false',
  '  syncHint()',
  '})',
  '',
  'poll()'
].join('\n')

const AUDIENCE_DOC = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>墨灵TeX 放映</title><style>' + AUDIENCE_CSS + '</style></head><body>'
  + '<div id="stage"><img id="cur" alt=""></div>'
  + '<div id="black"></div><div id="white"></div><div id="badge"></div>'
  + '<div id="poster"><div class="poster-in">'
  + '<b id="poster-title">点击开始放映</b>'
  + '<span id="poster-sub">整页任意处点一下就能进全屏（浏览器要求这个窗口自己有一次手势）· 之后用 → / ← 翻页，Esc 退出</span>'
  + '<button id="start">开始放映</button>'
  + '<div id="hint">点一下画面即可全屏 · → / ← 翻页</div>'
  + '</div></div>'
  + '<script>' + AUDIENCE_SCRIPT + '<\/script>'
  + '</body></html>'

/**
 * 造观众页 + 中转 handler（挂 PRESENT_PREFIX）。
 *
 *   GET  /moling/present         观众页本身（一整页 HTML）
 *   GET  /moling/present/state   观众页轮询的放映状态
 *   POST /moling/present/state   主窗推状态（心跳；live:false 表示收摊）
 *   GET  /moling/present/key     主窗取走排队的按键
 *   POST /moling/present/key     观众页推按键
 */
export function createPresentHandler() {
  let view = blankState()
  let keys = []

  async function onState(req, res, method) {
    if (method === 'POST') {
      const parsed = await readBody(req)
      if (parsed.error) { sendJson(res, 400, { ok: false, error: parsed.error }); return }
      const body = parsed.value || {}
      const live = asFlag(body.live)
      view = {
        root: asText(body.root),
        path: asText(body.path),
        rev: asText(body.rev),
        dpi: asNumber(body.dpi, 144, 36, 400),
        title: asText(body.title).slice(0, 200),
        page: asNumber(body.page, 1, 1, 9999),
        total: asNumber(body.total, 0, 0, 9999),
        black: asFlag(body.black),
        white: asFlag(body.white),
        badge: asFlag(body.badge),
        live,
        at: Date.now()
      }
      // 收摊时把没取走的按键扔掉，免得下次开映第一下就莫名翻页。
      // 注意：正常心跳不能清队列，否则观众在两次轮询之间按的键会被心跳抹掉。
      if (!live) keys = []
      sendJson(res, 200, { ok: true, value: { at: view.at } })
      return
    }
    const stale = view.at > 0 && (Date.now() - view.at > PRESENT_STALE_MS)
    sendJson(res, 200, { ok: true, value: Object.assign({}, view, { stale }) })
  }

  async function onKey(req, res, method) {
    if (method === 'POST') {
      const parsed = await readBody(req)
      if (parsed.error) { sendJson(res, 400, { ok: false, error: parsed.error }); return }
      const key = asText((parsed.value || {}).key).slice(0, 40)
      if (key && keys.length < PRESENT_KEY_LIMIT) keys.push(key)
      sendJson(res, 200, { ok: true, value: { queued: keys.length } })
      return
    }
    const drained = keys
    keys = []
    sendJson(res, 200, { ok: true, value: { keys: drained } })
  }

  async function handle(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch (failure) {
      sendJson(res, 400, { ok: false, error: '非法 URL' })
      return
    }
    const method = (req.method || 'GET').toUpperCase()
    let sub = url.pathname.startsWith(PRESENT_PREFIX) ? url.pathname.slice(PRESENT_PREFIX.length) : url.pathname
    if (sub.startsWith('/')) sub = sub.slice(1)
    if (sub.endsWith('/')) sub = sub.slice(0, -1)
    try {
      if (!sub) { sendHtml(res, 200, AUDIENCE_DOC); return }
      if (sub === 'state') { await onState(req, res, method); return }
      if (sub === 'key') { await onKey(req, res, method); return }
      sendJson(res, 404, { ok: false, error: '未知观众页端点 ' + sub })
    } catch (failure) {
      sendJson(res, 500, { ok: false, error: String((failure && failure.message) || failure) })
    }
  }

  /** 自测用：看当前状态 / 队列 / 清空。 */
  handle.presentView = function () { return view }
  handle.presentKeys = function () { return keys.slice() }
  handle.resetPresent = function () { view = blankState(); keys = [] }
  return handle
}
