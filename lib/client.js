/**
 * dsh-plugin-moling-latex —— 浏览器半侧（右侧栏标签页）
 *
 * 形态：在 DSH 右侧栏注册一个「墨灵 LaTeX」标签页类型（与 文档 / 文件 / 指南 并列），
 * 指南页里有一张入口卡片。
 *
 * 布局（对齐墨灵TeX 桌面版）：
 *   ┌ 顶栏：工作区 / 目录 / 文件 / 树 / 保存 / 编译 ─────────────┐
 *   ├ 左：标签条 + 编辑器（占满）      ┬ 右：日志 ↔ PDF 切换       ┤
 *   │   · 文件树是浮在这一栏上的抽屉   │   （主文件 tex | pdf 左右） │
 *   └ 状态行 ──────────────────────────────────────────────────┘
 *
 * 主题：只用 DSH 的主题 token（--dsw-alias-*），因此亮/暗两套自动跟随，
 * 不在样式里写死颜色（PDF 页面本身的白底来自 PDF 内容）。
 *
 * 数据：同源 fetch('/moling/api/<endpoint>')，与同机插件 dsh-drawai 的做法一致。
 * 状态：模块级 store（组件卸载/重建不丢）+ localStorage。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-moling-latex',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    /** 标签类型身份（也是正文槽位的 key）。 */
    var ID = 'dsh-plugin-moling-latex'
    /** 标签种类（右栏按 kind 派发正文）。 */
    var KIND = 'moling'
    var API = '/moling/api'
    var STORE_KEY = 'moling_latex.panel.v3'
    var LINE_H = 18

    /* ------------------------------------------------------------------ *
     * 数据通道
     * ------------------------------------------------------------------ */

    function describe(failure) {
      var message = String(failure && failure.message ? failure.message : failure)
      if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
        return '连不上宿主的数据通道（' + message + '）。多半是插件未挂载：在「设置 → 插件」里确认 moling_latex 已启用，或重开 DSH。'
      }
      return message
    }

    function api(endpoint, payload) {
      return fetch(API + '/' + endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {})
      }).catch(function (failure) {
        throw new Error(describe(failure))
      }).then(function (response) {
        return response.json().catch(function () { return null }).then(function (json) {
          if (!response.ok || !json || json.ok !== true) {
            throw new Error((json && json.error) || ('HTTP ' + response.status))
          }
          return json.value
        })
      })
    }

    function base64ToBlobUrl(base64, type) {
      var binary = atob(base64)
      var bytes = new Uint8Array(binary.length)
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return URL.createObjectURL(new Blob([bytes], { type: type }))
    }

    /* ------------------------------------------------------------------ *
     * 亮/暗：按页面实际底色判断，交给原生控件（select 弹层、滚动条、光标）
     * 一个匹配的 color-scheme；并在 <html> 属性变化时重新判断。
     * ------------------------------------------------------------------ */

    function detectScheme() {
      try {
        var probes = [document.body, document.documentElement]
        for (var i = 0; i < probes.length; i++) {
          if (!probes[i]) continue
          var bg = getComputedStyle(probes[i]).backgroundColor || ''
          var match = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
          if (!match) continue
          var luma = (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) / 255
          return luma < 0.5 ? 'dark' : 'light'
        }
      } catch (error) { /* 读不到就按暗色 */ }
      return 'dark'
    }

    function watchScheme() {
      var applyScheme = function () {
        var next = detectScheme()
        if (next !== state.scheme) patch({ scheme: next })
      }
      applyScheme()
      var observer = null
      try {
        observer = new MutationObserver(applyScheme)
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-appearance']
        })
      } catch (error) { /* 没有 MutationObserver 就只在装载时判断一次 */ }
      return function () { if (observer) observer.disconnect() }
    }

    /* ------------------------------------------------------------------ *
     * 模块级 store
     * ------------------------------------------------------------------ */

    var state = {
      ctx: null,
      view: 'welcome',       // 'welcome' 启动页 | 'workbench' tex|pdf 工作台
      online: '',
      status: null,
      workspaces: [],
      root: '',
      tree: null,
      files: [],
      total: 0,
      skipped: 0,
      truncated: false,
      expanded: {},
      treeOpen: false,
      filter: '',
      tabs: [],
      activeId: null,
      log: null,
      pane: 'pdf',
      pdfUrl: '',
      pdfRel: '',
      pdfFor: '',
      mode: 'full',
      engine: 'auto',
      busy: '',
      error: '',
      notice: '',
      recents: [],
      scheme: 'dark',
      // 右栏（PDF/日志）占正文区的比例；文件树抽屉占左栏的比例
      split: 0.45,
      treeWidth: 0.76,
      dragging: false,
      booted: false
    }

    var listeners = new Set()
    var nextId = 1

    function emit() {
      listeners.forEach(function (listener) {
        try { listener() } catch (error) { /* 单个订阅者出错不影响其它 */ }
      })
    }

    function patch(next) {
      Object.assign(state, next)
      emit()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return function () { listeners.delete(listener) }
    }

    function activeTab() {
      for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].id === state.activeId) return state.tabs[i]
      return null
    }

    function findTab(root, rel) {
      for (var i = 0; i < state.tabs.length; i++) {
        if (state.tabs[i].root === root && state.tabs[i].rel === rel) return state.tabs[i]
      }
      return null
    }

    function findTabById(id) {
      for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].id === id) return state.tabs[i]
      return null
    }

    function setTab(id, next) {
      patch({ tabs: state.tabs.map(function (tab) { return tab.id === id ? Object.assign({}, tab, next) : tab }) })
    }

    function persist() {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({
          mode: state.mode,
          engine: state.engine,
          pane: state.pane,
          filter: state.filter,
          expanded: state.expanded,
          split: state.split,
          treeWidth: state.treeWidth,
          // 只记「最近打开」，不再自动恢复上次的文件与工作区：
          // 每次进来先落在启动页，由用户点一个项目再进工作台。
          recents: state.recents.slice(0, 16)
        }))
      } catch (error) { /* 隐私模式忽略 */ }
    }

    function restored() {
      try {
        var raw = window.localStorage.getItem(STORE_KEY)
        return raw ? JSON.parse(raw) : null
      } catch (error) {
        return null
      }
    }

    /** 数值夹取。 */
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /**
     * 通用拖动：按下后接管 mousemove/mouseup。
     * 拖动期间把 iframe 的指针事件关掉（store.dragging），否则鼠标滑到 PDF 预览上会丢事件。
     */
    function beginDrag(event, onMove, onDone) {
      event.preventDefault()
      var previousSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'
      patch({ dragging: true })
      var move = function (moveEvent) { onMove(moveEvent) }
      var up = function () {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        document.body.style.userSelect = previousSelect
        patch({ dragging: false })
        if (typeof onDone === 'function') onDone()
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    }

    /** 记一条「最近打开」：kind = 'dir' | 'file'。
        dir 的 value 是目录绝对路径；file 额外带 abs（文件绝对路径），
        因为宿主 open-file 端点要的是绝对路径——只存相对路径会报「文件不存在」。 */
    function pushRecent(entry) {
      var recents = state.recents.filter(function (item) {
        return !(item.kind === entry.kind && item.value === entry.value && item.root === entry.root)
      })
      recents.unshift(Object.assign({ at: Date.now() }, entry))
      return recents.slice(0, 16)
    }

    /** 相对路径 + 根目录 → 绝对路径（统一成 Windows 反斜杠）。 */
    function absolutePath(root, rel) {
      if (!root) return String(rel || '')
      // 根目录与相对路径都统一成反斜杠：宿主 open-file 收的是 Windows 绝对路径
      var base = String(root).replace(/[\\/]+$/, '').split('/').join('\\')
      var tail = String(rel || '').replace(/^[\\/]+/, '').split('/').join('\\')
      return tail ? base + '\\' + tail : base
    }

    /** 最近文件条目 → 绝对路径（兼容老版本只存了相对路径的记录）。 */
    function recentAbsolute(entry) {
      if (!entry) return ''
      if (entry.abs) return entry.abs
      var value = String(entry.value || '')
      if (/^[A-Za-z]:[\\/]/.test(value) || value.charAt(0) === '/') return value
      return absolutePath(entry.root, value)
    }

    /** 相对时间，给启动页用。 */
    function timeAgo(at) {
      if (!at) return ''
      var delta = Math.max(0, Date.now() - at)
      var minute = 60000
      var hour = 60 * minute
      var day = 24 * hour
      if (delta < minute) return '刚刚'
      if (delta < hour) return Math.floor(delta / minute) + ' 分钟前'
      if (delta < day) return Math.floor(delta / hour) + ' 小时前'
      if (delta < 30 * day) return Math.floor(delta / day) + ' 天前'
      var date = new Date(at)
      return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
    }

    /** 目录/文件的显示名。 */
    function basename(path) {
      var text = String(path || '')
      var index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return index >= 0 ? text.slice(index + 1) : text
    }

    /* ------------------------------------------------------------------ *
     * 动作
     * ------------------------------------------------------------------ */

    /** 只刷新工作区列表（欢迎页与顶栏下拉用），不自动选根目录。 */
    function loadWorkspaces(preferRoot) {
      return api('workspaces', {}).then(function (data) {
        var list = (data.workspaces || []).slice()
        patch({ workspaces: list, online: 'ok', root: preferRoot || state.root })
        return preferRoot || state.root
      })
    }

    function loadStatus() {
      return api('status', {}).then(function (data) { patch({ status: data }) })
    }

    function loadTree(root) {
      var target = root || state.root
      if (!target) return Promise.resolve()
      patch({ busy: 'tree' })
      return api('tree', { root: target }).then(function (data) {
        patch({
          root: target,
          tree: data.tree || null,
          files: data.files || [],
          total: data.total || 0,
          skipped: data.skipped || 0,
          truncated: Boolean(data.truncated),
          busy: '',
          error: '',
          online: 'ok'
        })
        persist()
      }).catch(function (failure) {
        patch({ files: [], tree: null, busy: '', error: describe(failure), online: 'error' })
      })
    }

    function openTab(root, rel) {
      var existing = findTab(root, rel)
      if (existing) {
        patch({ activeId: existing.id, treeOpen: false, view: 'workbench' })
        persist()
        return Promise.resolve(existing)
      }
      if (/\.pdf$/i.test(rel)) {
        patch({ pdfRel: rel, pane: 'pdf', treeOpen: false, view: 'workbench' })
        return refreshPdf(root, rel)
      }
      var id = 'tab-' + (nextId++)
      patch({
        tabs: state.tabs.concat([{ id: id, root: root, rel: rel, name: rel.split('/').pop(), text: '', dirty: false, loading: true }]),
        activeId: id,
        busy: 'open',
        error: '',
        treeOpen: false,
        view: 'workbench'
      })
      return api('read-file', { root: root, path: rel }).then(function (data) {
        setTab(id, { text: data.text, loading: false })
        patch({
          busy: '',
          notice: null,
          recents: pushRecent({
            kind: 'file',
            value: rel,
            root: root,
            abs: absolutePath(root, rel),
            title: rel.split('/').pop()
          })
        })
        persist()
      }).catch(function (failure) {
        patch({
          busy: '',
          error: describe(failure),
          tabs: state.tabs.filter(function (tab) { return tab.id !== id }),
          activeId: state.tabs.length > 1 ? state.tabs[0].id : null
        })
      })
    }

    function closeTab(id) {
      var rest = state.tabs.filter(function (tab) { return tab.id !== id })
      patch({ tabs: rest, activeId: state.activeId === id ? (rest.length ? rest[0].id : null) : state.activeId })
      persist()
    }

    function saveTab(id) {
      var tab = findTabById(id)
      if (!tab || !tab.dirty) return Promise.resolve()
      patch({ busy: 'save' })
      var text = tab.text
      return api('write-file', { root: tab.root, path: tab.rel, content: text }).then(function (data) {
        setTab(id, { dirty: false })
        patch({ busy: '', error: '', notice: '已保存 ' + tab.rel + '（' + (data.bytes || 0) + ' 字节）' })
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure) })
      })
    }

    function compileActive() {
      var tab = activeTab()
      if (!tab) { patch({ error: '先打开一个 .tex 文件' }); return Promise.resolve() }
      patch({ busy: 'compile', error: '', notice: '正在编译 ' + tab.rel + ' …' })
      var chain = tab.dirty ? saveTab(tab.id) : Promise.resolve()
      return chain.then(function () {
        return api('compile', { root: tab.root, file: tab.rel, mode: state.mode, engine: state.engine })
      }).then(function (data) {
        patch({
          log: data,
          busy: '',
          error: '',
          pane: data.success ? 'pdf' : 'log',
          notice: data.success
            ? '编译成功 · ' + data.engine + ' · ' + (data.durationMs / 1000).toFixed(1) + 's · ' + data.passes + ' 趟'
            : '编译失败 · ' + (data.errors || []).length + ' 条错误'
        })
        if (data.success && data.pdfRel) return refreshPdf(tab.root, data.pdfRel, data.pdfMtime)
        return undefined
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure), notice: null, pane: 'log' })
      })
    }

    function refreshPdf(root, rel, rev) {
      var key = root + '|' + rel + '|' + (rev || '')
      if (state.pdfFor === key && state.pdfUrl) return Promise.resolve()
      patch({ busy: 'pdf' })
      return api('pdf', { root: root, path: rel }).then(function (data) {
        var url = base64ToBlobUrl(data.base64, 'application/pdf')
        var previous = state.pdfUrl
        patch({ pdfUrl: url, pdfRel: rel, pdfFor: key, busy: '', error: '', pane: 'pdf' })
        if (previous && previous.indexOf('blob:') === 0) {
          try { URL.revokeObjectURL(previous) } catch (error) { /* 忽略 */ }
        }
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure) })
      })
    }

    function cleanActive() {
      var tab = activeTab()
      if (!tab) return Promise.resolve()
      patch({ busy: 'clean' })
      return api('clean', { root: tab.root, file: tab.rel }).then(function (data) {
        patch({ busy: '', error: '', notice: '已清理 ' + (data.deleted || []).length + ' 个辅助文件' })
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure) })
      })
    }

    /** 进工作台：选中某个根目录、拉文件树、打开抽屉。 */
    function enterRoot(root, options) {
      if (!root) return Promise.resolve()
      var settings = options || {}
      patch({ root: root, view: 'workbench', treeOpen: settings.treeOpen !== false, error: '' })
      return loadWorkspaces(root).then(function () { return loadTree(root) })
    }

    /** 打开一个项目文件夹（原生目录选择）。 */
    function openDirectory() {
      var ctx = state.ctx
      var uiWorkspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
      if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
        patch({ error: '当前组合没有目录选择服务（缺少 @deepseek-ai/dsh-host-directory-picker）' })
        return
      }
      uiWorkspace.pickDirectory().then(function (picked) {
        if (!picked) return null
        return api('open-root', { root: picked }).then(function (data) { return data.root || picked })
      }).then(function (root) {
        if (!root) return undefined
        patch({ recents: pushRecent({ kind: 'dir', value: root, title: basename(root) }) })
        persist()
        return enterRoot(root)
      }).catch(function (failure) {
        patch({ error: describe(failure) })
      })
    }

    /** 启动页/顶栏里点一个项目文件夹（可能是最近项目，也可能是下拉里的工作区）。 */
    function openRootFolder(root) {
      patch({ error: '' })
      return api('open-root', { root: root })
        .catch(function () { return null })   // 已注册工作区无需登记
        .then(function () {
          patch({ recents: pushRecent({ kind: 'dir', value: root, title: basename(root) }) })
          persist()
          return enterRoot(root)
        })
        .catch(function (failure) { patch({ error: describe(failure) }) })
    }

    /** 启动页里点一个「最近的文件」：用绝对路径打开，登记其所在目录后进工作台。 */
    function openRecentFile(entry) {
      var target = recentAbsolute(entry)
      if (!target) { patch({ error: '这条记录缺少路径，请用「打开文件夹…」重新打开' }); return Promise.resolve() }
      patch({ busy: 'open', error: '' })
      return api('open-file', { path: target })
        .then(function (data) {
          patch({
            busy: '',
            recents: pushRecent({
              kind: 'file',
              value: data.file.rel,
              root: data.root,
              abs: absolutePath(data.root, data.file.rel),
              title: data.file.name
            })
          })
          persist()
          return enterRoot(data.root, { treeOpen: false }).then(function () {
            return openTab(data.root, data.file.rel)
          })
        })
        .catch(function (failure) { patch({ busy: '', error: describe(failure) }) })
    }

    /** 在（最近的）工作区里新建一个 ctexart 骨架文档并打开。 */
    function newDocument() {
      var root = state.root
      if (!root) {
        var recentDir = (state.recents || []).filter(function (entry) { return entry.kind === 'dir' })[0]
        root = recentDir ? recentDir.value : ''
      }
      if (!root) {
        patch({ error: '先「打开文件夹…」选一个目录，再新建文档' })
        return Promise.resolve()
      }
      var body = [
        '\\documentclass[UTF8]{ctexart}',
        '\\usepackage{amsmath,amssymb,graphicx}',
        '',
        '\\title{未命名文档}',
        '\\author{}',
        '\\date{\\today}',
        '',
        '\\begin{document}',
        '\\maketitle',
        '',
        '\\section{引言}',
        '正文。',
        '',
        '\\end{document}',
        ''
      ].join('\n')

      patch({ busy: 'new', error: '' })
      return api('tree', { root: root }).then(function (data) {
        var used = {}
        ;(data.files || []).forEach(function (file) { used[file.rel] = true })
        var name = 'untitled.tex'
        var index = 2
        while (used[name]) { name = 'untitled-' + index + '.tex'; index += 1 }
        return api('write-file', { root: root, path: name, content: body }).then(function () {
          patch({
            busy: '',
            recents: pushRecent({ kind: 'file', value: name, root: root, abs: absolutePath(root, name), title: name })
          })
          persist()
          return enterRoot(root, { treeOpen: false }).then(function () { return openTab(root, name) })
        })
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure) })
      })
    }

    /** 「打开文件…」：进工作台并展开当前工作区的文件树。 */
    function openTreeOfRoot() {
      if (!state.root) {
        var recentDir = (state.recents || []).filter(function (entry) { return entry.kind === 'dir' })[0]
        if (recentDir) { openRootFolder(recentDir.value); return }
        patch({ error: '先「打开文件夹…」选一个目录' })
        return
      }
      patch({ view: 'workbench', treeOpen: true, error: '' })
      if (!state.tree) loadTree(state.root)
    }

    /** 首次装载：拉状态与工作区列表，落在启动页（不自动打开任何文件夹）。 */
    function boot(ctx) {
      if (state.booted) return
      state.booted = true
      state.ctx = ctx

      var saved = restored()
      if (saved) {
        patch({
          mode: saved.mode || state.mode,
          engine: saved.engine || state.engine,
          pane: saved.pane || state.pane,
          filter: saved.filter || '',
          expanded: saved.expanded || {},
          split: clamp(Number(saved.split) || state.split, 0.2, 0.8),
          treeWidth: clamp(Number(saved.treeWidth) || state.treeWidth, 0.3, 1),
          recents: Array.isArray(saved.recents) ? saved.recents : []
        })
      }
      patch({ view: 'welcome' })

      loadStatus().catch(function (failure) { patch({ error: describe(failure), online: 'error' }) })
      loadWorkspaces().catch(function (failure) { patch({ error: describe(failure), online: 'error' }) })
    }

    /* ------------------------------------------------------------------ *
     * 样式：全部走 DSH 主题 token（亮/暗自动跟随）
     * ------------------------------------------------------------------ */

    var C = {
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      sub: 'var(--dsw-alias-label-secondary, #9aa0a6)',
      line: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.28))',
      lineStrong: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.45))',
      layer1: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.10))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.16))',
      overlay: 'var(--dsw-alias-bg-overlay, #2a2a2a)',
      accent: 'var(--dsw-alias-brand-primary, #4d8bf8)',
      ok: 'var(--dsw-alias-state-success-primary, #4f9d69)',
      warn: 'var(--dsw-alias-state-warn-primary, #d99a2b)',
      err: 'var(--dsw-alias-state-error-primary, #e06c5a)',
      idle: 'var(--dsw-alias-state-idle-primary, #8a8a8a)'
    }
    var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace'

    var S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: C.text, fontSize: 12.5 },
      bar: { display: 'flex', alignItems: 'center', gap: 5, padding: '6px 8px', borderBottom: '1px solid ' + C.line, flexShrink: 0 },
      spacer: { flex: 1 },
      btn: { border: '1px solid ' + C.line, background: 'transparent', color: C.text, borderRadius: 6, padding: '2px 8px', fontSize: 11.5, cursor: 'pointer', lineHeight: '18px' },
      btnOn: { borderColor: C.accent, color: C.accent },
      // 主按钮不实心填色：主题 accent 在深色主题下可能是浅色，
      // 「浅底 + 白字」会看不清。改用中性底 + accent 边框 + 主题文字色。
      btnPrimary: { border: '1px solid ' + C.accent, background: C.layer2, color: C.text, borderRadius: 6, padding: '2px 10px', fontSize: 11.5, cursor: 'pointer', lineHeight: '18px', fontWeight: 500 },
      dimmed: { opacity: 0.45, cursor: 'default' },
      select: { border: '1px solid ' + C.line, background: C.layer1, color: C.text, borderRadius: 6, padding: '1px 4px', fontSize: 11.5, maxWidth: 150 },
      input: { border: '1px solid ' + C.line, background: 'transparent', color: C.text, borderRadius: 6, padding: '2px 6px', fontSize: 11.5, width: '100%', outline: 'none' },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      // 可拖动的竖直分隔条（压在右栏的左边框上）
      vsplit: {
        width: 5, marginLeft: -3, flex: 'none', cursor: 'col-resize',
        position: 'relative', zIndex: 6, background: 'transparent'
      },
      left: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' },
      right: {
        width: '45%', minWidth: 160, borderLeft: '1px solid ' + C.line,
        display: 'flex', flexDirection: 'column', minHeight: 0
      },
      // 预览区底部的状态条（编译结果 / 错误）
      paneStatus: {
        flexShrink: 0, borderTop: '1px solid ' + C.line, padding: '4px 9px',
        fontSize: 11, color: C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      },
      paneStatusError: {
        flexShrink: 0, borderTop: '1px solid ' + C.line, padding: '4px 9px',
        fontSize: 11, color: C.err, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: 72, overflow: 'auto'
      },
      tabsBar: { display: 'flex', alignItems: 'center', gap: 1, borderBottom: '1px solid ' + C.line, overflowX: 'auto', padding: '2px 4px 0', flexShrink: 0, minHeight: 26 },
      tab: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', fontSize: 11.5, cursor: 'pointer', borderTop: '2px solid transparent', color: C.sub, whiteSpace: 'nowrap' },
      tabOn: { color: C.text, borderTop: '2px solid ' + C.accent, background: C.layer1 },
      tabClose: { opacity: 0.55, fontSize: 12, lineHeight: '12px' },
      editorWrap: { flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' },
      // 高亮层：与 textarea 同字体同字号同行高同换行，滚动由 textarea 驱动
      hlWrap: {
        position: 'absolute', inset: 0, margin: 0, overflow: 'hidden', pointerEvents: 'none',
        padding: '6px 8px 6px 0', fontFamily: MONO, fontSize: 12, lineHeight: LINE_H + 'px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontVariantLigatures: 'none', color: C.text, tabSize: 2
      },
      hlLine: { paddingLeft: 56, textIndent: -48 },
      ln: {
        display: 'inline-block', width: 48, boxSizing: 'border-box', paddingRight: 8,
        textAlign: 'right', textIndent: 0, color: C.sub, userSelect: 'none'
      },
      textareaOverlay: {
        position: 'absolute', inset: 0, width: '100%', height: '100%', boxSizing: 'border-box',
        resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: 'transparent',
        caretColor: C.text, fontFamily: MONO, fontSize: 12, lineHeight: LINE_H + 'px',
        padding: '6px 8px 6px 56px', tabSize: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontVariantLigatures: 'none', overflow: 'auto'
      },
      rightHead: { display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderBottom: '1px solid ' + C.line, flexShrink: 0, minHeight: 26 },
      paneTab: { padding: '1px 7px', fontSize: 11.5, cursor: 'pointer', borderRadius: 5, color: C.sub },
      paneTabOn: { color: C.text, background: C.layer1 },
      pane: { flex: 1, overflow: 'auto', padding: '6px 8px', minHeight: 0 },
      pre: { margin: 0, fontFamily: MONO, fontSize: 11, lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.sub },
      issue: { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', color: C.err, cursor: 'pointer', font: 'inherit', fontFamily: MONO, fontSize: 11, padding: '1px 0' },
      warnIssue: { color: C.warn },
      hint: { color: C.sub, fontSize: 11.5 },
      // 启动页
      welcome: { flex: 1, overflow: 'auto', padding: '14px 16px 24px', minHeight: 0 },
      welcomeTitle: { fontSize: 15, fontWeight: 600, marginBottom: 2 },
      welcomeSub: { color: C.sub, fontSize: 11.5, marginBottom: 14, lineHeight: '17px' },
      welcomeActions: { display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' },
      section: { marginBottom: 16 },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, color: C.sub, fontSize: 11.5 },
      card: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', marginBottom: 6,
        border: '1px solid ' + C.line, borderRadius: 8, cursor: 'pointer', background: C.layer1
      },
      cardTitle: { fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      cardMeta: { fontSize: 11, color: C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      chip: { padding: '3px 9px', border: '1px solid ' + C.line, borderRadius: 999, fontSize: 11.5, cursor: 'pointer', color: C.text, background: 'transparent' },
      note: { padding: '3px 8px', fontSize: 11.5, color: C.sub, borderBottom: '1px solid ' + C.line, flexShrink: 0 },
      error: { padding: '4px 8px', fontSize: 11.5, color: C.err, borderBottom: '1px solid ' + C.line, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flexShrink: 0 },
      status: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 8px', fontSize: 10.5, color: C.sub, borderTop: '1px solid ' + C.line, whiteSpace: 'nowrap', overflow: 'hidden', flexShrink: 0 },
      dot: { width: 7, height: 7, borderRadius: 999, display: 'inline-block', flexShrink: 0 },
      // 文件树：浮在编辑区上的抽屉（右边框可拖动）
      overlay: { position: 'absolute', inset: 0, display: 'flex', zIndex: 30 },
      drawer: {
        width: '76%', minWidth: 150, height: '100%', background: C.overlay,
        borderRight: '1px solid ' + C.lineStrong, display: 'flex', flexDirection: 'column',
        position: 'relative', boxShadow: '0 8px 28px rgba(0,0,0,0.35)'
      },
      hsplit: {
        position: 'absolute', top: 0, bottom: 0, right: -3, width: 6,
        cursor: 'col-resize', zIndex: 4, background: 'transparent'
      },
      drawerHead: { display: 'flex', alignItems: 'center', gap: 5, padding: '5px 7px', borderBottom: '1px solid ' + C.line },
      drawerList: { flex: 1, overflow: 'auto', padding: '3px 4px 10px' },
      backdrop: { flex: 1, background: 'rgba(0,0,0,0.28)' },
      row: { display: 'flex', alignItems: 'center', gap: 3, padding: '1px 3px', borderRadius: 5, cursor: 'pointer', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden' },
      rowOn: { background: C.layer1, color: C.accent }
    }

    /* ------------------------------------------------------------------ *
     * LaTeX 语法高亮
     * 带状态的 LaTeX 词法：命令、环境名、引用/标签键、数学（$…$ 与数学环境）、
     * 注释、括号、数字；章节命令整行加粗。纯函数、无依赖；超长文件退化为纯文本。
     * ------------------------------------------------------------------ */

    var TOKEN = {
      command: { color: C.accent, fontWeight: 500 },   // \section \item …
      env: { color: C.err },                           // \begin{equation} 里的 environment 名
      key: { color: C.warn },                          // \cite{} / \ref{} / \label{} 的键
      math: { color: C.ok },                           // 数学区间
      number: { color: C.ok },
      comment: { color: C.sub, fontStyle: 'italic' },
      brace: { color: C.sub }
    }
    var HL_MAX_CHARS = 300000

    /** 这些环境的正文按数学处理。 */
    var MATH_ENVS = {
      equation: 1, align: 1, gather: 1, eqnarray: 1, multline: 1, flalign: 1, alignat: 1,
      displaymath: 1, math: 1, split: 1, cases: 1, matrix: 1, pmatrix: 1, bmatrix: 1,
      'equation*': 1, 'align*': 1, 'gather*': 1, 'multline*': 1, 'eqnarray*': 1,
      'flalign*': 1, 'alignat*': 1
    }
    /** 这些命令的第一个 {…} 参数按「键」上色。 */
    var KEY_COMMANDS = {
      cite: 1, citep: 1, citet: 1, citeauthor: 1, citeyear: 1,
      ref: 1, eqref: 1, autoref: 1, cref: 1, Cref: 1, pageref: 1, nameref: 1,
      label: 1, input: 1, include: 1, includegraphics: 1,
      bibliography: 1, bibliographystyle: 1, url: 1, href: 1, hyperref: 1
    }
    var SECTIONING = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?/

    /**
     * 把一行 LaTeX 切成 [{ text, style }]，并推进跨行状态（数学区间）。
     * @param {string} line
     * @param {{math: null | {kind: 'dollar'} | {kind: 'env', name: string}}} state
     */
    function tokenizeLine(line, state) {
      var out = []
      var index = 0
      var length = line.length
      var push = function (text, style) { if (text) out.push({ text: text, style: style }) }

      while (index < length) {
        // ---- 数学区间未闭合：吞到结束标记为止 ----
        if (state.math) {
          var terminator = state.math.kind === 'env' ? '\\end{' + state.math.name + '}' : '$'
          var found = state.math.kind === 'env'
            ? line.indexOf(terminator, index)
            : line.indexOf('$', index)
          if (found < 0) {
            push(line.slice(index), TOKEN.math)
            break
          }
          if (state.math.kind === 'env') {
            push(line.slice(index, found), TOKEN.math)
            state.math = null
            index = found            // 让 \end{…} 走普通命令分支（环境名仍会上色）
            continue
          }
          push(line.slice(index, found + 1), TOKEN.math)
          state.math = null
          index = found + 1
          continue
        }

        var ch = line.charAt(index)
        // 注释吃掉整行
        if (ch === '%') { push(line.slice(index), TOKEN.comment); break }

        // 命令
        if (ch === '\\') {
          var match = /^\\(?:[A-Za-z@]+|.)/.exec(line.slice(index))
          var command = match ? match[0] : ch
          var name = command.slice(1)
          index += command.length

          // \begin{env} / \end{env}
          if ((name === 'begin' || name === 'end') && line.charAt(index) === '{') {
            var close = line.indexOf('}', index)
            if (close > index) {
              var env = line.slice(index + 1, close)
              push(command, TOKEN.command)
              push('{', TOKEN.brace)
              push(env, TOKEN.env)
              push('}', TOKEN.brace)
              index = close + 1
              if (name === 'begin' && MATH_ENVS[env]) {
                // 同一行后面若能找到 \end{env}，就不进入跨行数学状态
                if (line.indexOf('\\end{' + env + '}', index) < 0) state.math = { kind: 'env', name: env }
              }
              continue
            }
          }

          // \cite{key} / \ref{key} / \label{key} …
          if (KEY_COMMANDS[name]) {
            push(command, TOKEN.command)
            // 可选参数 [..] 按括号色
            if (line.charAt(index) === '[') {
              var bracketEnd = line.indexOf(']', index)
              if (bracketEnd > index) {
                push(line.slice(index, bracketEnd + 1), TOKEN.brace)
                index = bracketEnd + 1
              }
            }
            if (line.charAt(index) === '{') {
              var keyEnd = line.indexOf('}', index)
              if (keyEnd > index) {
                push('{', TOKEN.brace)
                push(line.slice(index + 1, keyEnd), TOKEN.key)
                push('}', TOKEN.brace)
                index = keyEnd + 1
              }
            }
            continue
          }

          push(command, TOKEN.command)
          continue
        }

        // 数学：$$…$$ / $…$
        if (ch === '$') {
          var delimiter = line.charAt(index + 1) === '$' ? '$$' : '$'
          var end = line.indexOf(delimiter, index + delimiter.length)
          if (end > index) {
            push(line.slice(index, end + delimiter.length), TOKEN.math)
            index = end + delimiter.length
            continue
          }
          state.math = { kind: 'dollar' }
          push(ch, TOKEN.math)
          index += 1
          continue
        }

        if (ch === '{' || ch === '}' || ch === '[' || ch === ']') { push(ch, TOKEN.brace); index += 1; continue }

        var digits = /^\d+(?:\.\d+)?/.exec(line.slice(index))
        if (digits && (index === 0 || !/[A-Za-z]/.test(line.charAt(index - 1)))) {
          push(digits[0], TOKEN.number)
          index += digits[0].length
          continue
        }

        var rest = line.slice(index)
        var next = rest.search(/[\\%${}[\]]/)
        if (next > 0) { push(rest.slice(0, next), null); index += next; continue }
        push(ch, null)
        index += 1
      }
      return out
    }

    /** 整篇高亮：逐行分词并传递跨行状态；章节命令整行加粗。 */
    function highlightDocument(text) {
      var rows = text.split('\n')
      var state = { math: null }
      var lines = []
      for (var i = 0; i < rows.length; i++) {
        lines.push({ segments: tokenizeLine(rows[i], state), bold: SECTIONING.test(rows[i]) })
      }
      return lines
    }

    /* 行级缓存：行文本与「进入状态」都没变时，复用上一轮造好的 React 元素。
       收益是在大文件里打字只有被编辑的那一行（及其后状态相同的行）需要重建，
       3000 行 / 4.8 万 span 的文档也不会每敲一个字就全量重排。 */
    var hlCache = { key: null, lines: [] }

    function buildHighlight(text, cacheKey) {
      var rows = text.split('\n')
      if (hlCache.key !== cacheKey) hlCache = { key: cacheKey, lines: [] }
      var previous = hlCache.lines
      var record = new Array(rows.length)
      var state = { math: null }

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i]
        var stateKey = state.math ? state.math.kind + ':' + (state.math.name || '') : ''
        var cached = previous[i]
        if (cached && cached.text === row && cached.stateKey === stateKey) {
          state = { math: cached.stateOut.math ? Object.assign({}, cached.stateOut.math) : null }
          record[i] = cached
          continue
        }
        var bold = SECTIONING.test(row)
        var segments = tokenizeLine(row, state)
        var children = [h('span', { key: 'ln', style: S.ln }, i + 1)]
        for (var j = 0; j < segments.length; j++) {
          children.push(h('span', { key: j, style: segments[j].style }, segments[j].text))
        }
        record[i] = {
          text: row,
          stateKey: stateKey,
          stateOut: { math: state.math ? Object.assign({}, state.math) : null },
          element: h('div', {
            key: i,
            style: bold ? Object.assign({}, S.hlLine, { fontWeight: 600 }) : S.hlLine,
            'data-line': i + 1
          }, children)
        }
      }

      hlCache.lines = record
      var elements = new Array(record.length)
      for (var k = 0; k < record.length; k++) elements[k] = record[k].element
      return elements
    }

    /** 行号 → 字符偏移（1 起）。 */
    function lineOffset(text, line) {
      var index = 0
      for (var i = 1; i < line; i++) {
        var next = text.indexOf('\n', index)
        if (next < 0) return text.length
        index = next + 1
      }
      return index
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */

    function useStore() {
      var pair = React.useState(0)
      var bump = pair[1]
      React.useEffect(function () {
        return subscribe(function () { bump(function (n) { return n + 1 }) })
      }, [])
      return state
    }

    function TreeBranch(props) {
      var node = props.node
      var depth = props.depth || 0
      if (node.type === 'file') {
        var selected = props.activeRel === node.rel
        return h('div', {
          style: Object.assign({}, S.row, selected ? S.rowOn : null, { paddingLeft: 3 + depth * 10 }),
          title: node.rel,
          onClick: function () { props.onOpen(node.rel) }
        }, h('span', { style: { opacity: 0.7, width: 9, display: 'inline-block' } }, node.editable ? '·' : '▤'), node.name)
      }
      var open = props.expanded[node.rel] !== false
      return h('div', null,
        h('div', {
          style: Object.assign({}, S.row, { paddingLeft: 3 + depth * 10, fontWeight: 500 }),
          onClick: function () { props.onToggle(node.rel) }
        }, h('span', { style: { width: 9, display: 'inline-block', opacity: 0.8 } }, open ? '▾' : '▸'), node.name),
        open ? node.children.map(function (child) {
          return h(TreeBranch, {
            key: child.rel || child.name,
            node: child,
            depth: depth + 1,
            expanded: props.expanded,
            activeRel: props.activeRel,
            onOpen: props.onOpen,
            onToggle: props.onToggle
          })
        }) : null
      )
    }

    function LogPane(props) {
      var log = props.log
      if (!log) return h('div', { style: S.hint }, '还没有编译记录。按 F5 或点「编译」。')
      var children = [h('div', {
        key: 'head',
        style: { marginBottom: 4, color: log.success ? C.ok : C.err }
      }, (log.success ? '✓ 编译成功' : '✗ 编译失败') + ' · ' + log.engine + ' · '
        + (log.durationMs / 1000).toFixed(1) + 's · ' + log.passes + ' 趟')]

      ;(log.errors || []).forEach(function (issue, index) {
        children.push(h('button', {
          key: 'e' + index,
          style: S.issue,
          title: '跳到该行',
          onClick: function () { props.onJump(issue.line) }
        }, (issue.file ? String(issue.file).split(/[\\/]/).pop() : '?') + (issue.line ? ':' + issue.line : '') + ' — ' + issue.message))
      })
      ;(log.warnings || []).slice(0, 20).forEach(function (issue, index) {
        children.push(h('div', { key: 'w' + index, style: Object.assign({}, S.pre, S.warnIssue) },
          (issue.file ? String(issue.file).split(/[\\/]/).pop() : '?') + (issue.line ? ':' + issue.line : '') + ' — ' + issue.message))
      })
      if (log.logTail) {
        children.push(h('details', { key: 'log', style: { marginTop: 6 } },
          h('summary', { style: Object.assign({}, S.hint, { cursor: 'pointer' }) }, '日志尾部'),
          h('pre', { style: S.pre }, log.logTail)))
      }
      return h('div', null, children)
    }

    /* ------------------------------------------------------------------ *
     * 启动页（参照墨灵 TeX 桌面版欢迎页）：
     *   大标题 + 副标题 / 「启动」动作行（右对齐快捷键）/ 「最近」行
     *   （类型标签 + 名称 + 右对齐路径）/ 模板式卡片 / 右栏提示
     * ------------------------------------------------------------------ */

    var WELCOME_CSS = [
      '.ml-wrap{display:flex;flex-wrap:wrap;gap:22px 30px;align-items:flex-start}',
      '.ml-main{flex:1 1 340px;min-width:0}',
      '.ml-side{flex:0 1 240px;min-width:0}',
      '.ml-h1{font-size:25px;font-weight:600;letter-spacing:-.2px;margin:2px 0 4px}',
      '.ml-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin-bottom:26px}',
      '.ml-sec{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.6px;margin:20px 0 6px}',
      '.ml-row{display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.ml-row:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.ml-glyph{flex:none;width:18px;text-align:center;opacity:.75;font-size:13px}',
      '.ml-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ml-kbd{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ml-badge{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);width:40px}',
      '.ml-path{flex:none;max-width:46%;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ml-card{display:flex;align-items:center;gap:10px;margin-top:10px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;cursor:pointer}',
      '.ml-card:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.ml-card-title{font-size:13px;font-weight:500}',
      '.ml-card-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.ml-tip{display:flex;gap:9px;padding:6px 2px}',
      '.ml-tip-glyph{flex:none;width:16px;text-align:center;opacity:.75}',
      '.ml-tip-title{font-size:12.5px;font-weight:500;margin-bottom:2px}',
      '.ml-tip-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.ml-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 9px;line-height:18px}'
    ].join('')

    function Welcome(props) {
      var store = props.store

      // 启动页快捷键：Ctrl+N 新建 / Ctrl+K 打开文件夹 / Ctrl+O 文件树
      React.useEffect(function () {
        var onKey = function (event) {
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return
          var key = String(event.key || '').toLowerCase()
          if (key === 'n') { event.preventDefault(); newDocument() }
          else if (key === 'k') { event.preventDefault(); openDirectory() }
          else if (key === 'o') { event.preventDefault(); openTreeOfRoot() }
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [])

      var recents = (store.recents || []).slice(0, 9)
      var recentRowList = recents.map(function (entry) {
        var isDir = entry.kind === 'dir'
        return h('div', {
          key: entry.kind + ':' + (entry.root || '') + ':' + entry.value,
          className: 'ml-row',
          title: isDir ? entry.value : (entry.root ? entry.root + '\\' : '') + entry.value,
          onClick: function () { isDir ? openRootFolder(entry.value) : openRecentFile(entry) }
        },
          h('span', { className: 'ml-badge' }, isDir ? '工作区' : '文件'),
          h('span', { className: 'ml-label' }, entry.title || basename(entry.value)),
          h('span', { className: 'ml-path' }, isDir ? entry.value : (entry.root || ''))
        )
      })

      return h('div', { style: Object.assign({}, S.welcome, { colorScheme: store.scheme }) },
        h('style', null, WELCOME_CSS),
        h('div', { className: 'ml-wrap' },
          h('div', { className: 'ml-main' },
            h('div', { className: 'ml-h1' }, '墨灵 LaTeX'),
            h('div', { className: 'ml-sub' }, '编辑 · 编译 · 预览 — 本地一体化 LaTeX 工作流'),

            h('div', { className: 'ml-sec' }, '启动'),
            h('div', { className: 'ml-row', onClick: newDocument },
              h('span', { className: 'ml-glyph' }, '▤'),
              h('span', { className: 'ml-label' }, '新建文档'),
              h('span', { className: 'ml-kbd' }, 'Ctrl+N')),
            h('div', { className: 'ml-row', onClick: openDirectory },
              h('span', { className: 'ml-glyph' }, '▤'),
              h('span', { className: 'ml-label' }, '打开文件夹…'),
              h('span', { className: 'ml-kbd' }, 'Ctrl+K')),
            h('div', { className: 'ml-row', onClick: openTreeOfRoot },
              h('span', { className: 'ml-glyph' }, '▤'),
              h('span', { className: 'ml-label' }, '打开文件…'),
              h('span', { className: 'ml-kbd' }, 'Ctrl+O')),

            h('div', { className: 'ml-sec' }, '最近'),
            recentRowList.length
              ? recentRowList
              : h('div', { className: 'ml-empty' }, '还没有打开记录。点「打开文件夹…」选一个 LaTeX 项目目录，之后会出现在这里。'),

            h('div', { className: 'ml-sec' }, '模板'),
            h('div', { className: 'ml-card', onClick: newDocument },
              h('span', { className: 'ml-glyph', style: { fontSize: 16 } }, '▤'),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'ml-card-title' }, '新建中文文档'),
                h('div', { className: 'ml-card-desc' }, 'ctexart 骨架：标题 · 作者 · 日期 · 一节正文')),
              h('span', { className: 'ml-path' }, '→'))
          ),

          // 右栏提示（窄时自动折到下方）
          h('div', { className: 'ml-side' },
            h('div', { className: 'ml-sec', style: { marginTop: 2 } }, '提示'),
            h('div', { className: 'ml-tip' },
              h('span', { className: 'ml-tip-glyph' }, '⌨'),
              h('div', null,
                h('div', { className: 'ml-tip-title' }, '快捷键'),
                h('div', { className: 'ml-tip-desc' }, 'F5 编译 · Ctrl+S 保存 · Ctrl+N 新建 · Ctrl+K 打开文件夹 · Ctrl+O 文件树'))),
            h('div', { className: 'ml-tip' },
              h('span', { className: 'ml-tip-glyph' }, '⚙'),
              h('div', null,
                h('div', { className: 'ml-tip-title' }, 'TeX 环境'),
                h('div', { className: 'ml-tip-desc' },
                  store.status && store.status.found
                    ? (String(store.status.version || 'TeX').split('(')[0].trim() + (store.status.binDir ? '\n' + store.status.binDir : ''))
                    : '未检测到 TeX 发行版；请在插件配置里指定 texlivePath'))),
            h('div', { className: 'ml-tip' },
              h('span', { className: 'ml-tip-glyph' }, '●'),
              h('div', null,
                h('div', { className: 'ml-tip-title' }, '数据通道'),
                h('div', { className: 'ml-tip-desc' },
                  store.online === 'ok' ? '正常（/moling/api）' : (store.online === 'error' ? '异常，检查插件是否已挂载' : '未连接'))))
          )
        ),

        store.error ? h('div', { style: Object.assign({}, S.error, { marginTop: 14 }) }, store.error) : null,
        store.busy ? h('div', { style: Object.assign({}, S.note, { marginTop: 10 }) }, store.busy === 'open' ? '正在打开…' : store.busy) : null
      )
    }

    /* ------------------------------------------------------------------ *
     * 工作台：左 tex / 右 pdf，文件树是浮层
     * ------------------------------------------------------------------ */

    function Body(props) {
      var store = useStore()
      React.useEffect(function () { boot(state.ctx) }, [])
      return store.view === 'welcome'
        ? h(Welcome, { store: store })
        : h(Workbench, { props: props })
    }

    function Workbench(props) {
      var store = useStore()
      var textareaRef = React.useRef(null)
      var preRef = React.useRef(null)
      var bodyRef = React.useRef(null)
      var leftRef = React.useRef(null)

      var info = null
      try { info = props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : null } catch (error) { info = null }
      var tabInfo = info && info.tab ? info.tab : null
      var visible = tabInfo ? tabInfo.visible !== false : true

      // 文件树抽屉：Esc 关闭
      React.useEffect(function () {
        if (!store.treeOpen) return undefined
        var onKey = function (event) { if (event.key === 'Escape') patch({ treeOpen: false }) }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [store.treeOpen])

      /** tex|pdf 分隔条拖动。 */
      var startSplitDrag = function (event) {
        var body = bodyRef.current
        if (!body) return
        var rect = body.getBoundingClientRect()
        beginDrag(event, function (moveEvent) {
          var ratio = (rect.right - moveEvent.clientX) / rect.width
          patch({ split: clamp(ratio, 0.2, 0.8) })
        }, persist)
      }

      /** 文件树抽屉右边框拖动。 */
      var startTreeDrag = function (event) {
        var left = leftRef.current
        if (!left) return
        var rect = left.getBoundingClientRect()
        beginDrag(event, function (moveEvent) {
          var ratio = (moveEvent.clientX - rect.left) / rect.width
          patch({ treeWidth: clamp(ratio, 0.3, 1) })
        }, persist)
      }

      var tab = activeTab()
      var tabText = tab ? tab.text : ''

      // 高亮层：按当前文档重建；行级缓存让大文件里打字不再全量重排
      var highlighted = React.useMemo(function () {
        if (!tabText) return []
        if (tabText.length > HL_MAX_CHARS) {
          return tabText.split('\n').map(function (row, i) {
            return h('div', { key: i, style: S.hlLine, 'data-line': i + 1 },
              h('span', { key: 'ln', style: S.ln }, i + 1), row)
          })
        }
        return buildHighlight(tabText, (tab ? tab.id : '') + '|' + tabText.length)
      }, [tabText])

      var onEditorChange = function (event) {
        if (!tab) return
        setTab(tab.id, { text: event.target.value, dirty: true })
      }

      // textarea 滚动 → 高亮层跟随（单一滚动源，避免两套滚动打架）
      var syncScroll = function () {
        var element = textareaRef.current
        var pre = preRef.current
        if (!element || !pre) return
        pre.scrollTop = element.scrollTop
        pre.scrollLeft = element.scrollLeft
      }

      var onEditorScroll = function () { syncScroll() }

      // 浏览器里用 layout effect（避免滚动同步闪一下），SSR 时退化为普通 effect
      var useLayout = typeof window !== 'undefined' && window.document ? React.useLayoutEffect : React.useEffect
      useLayout(function () { syncScroll() })

      var jumpTo = function (line) {
        var element = textareaRef.current
        if (!element || !tab || !line) return
        var index = lineOffset(tab.text, line)
        element.focus()
        element.setSelectionRange(index, index)
        var pre = preRef.current
        var lineEl = pre ? pre.querySelector('[data-line="' + line + '"]') : null
        if (pre && lineEl) {
          pre.scrollTop = Math.max(0, lineEl.offsetTop - pre.clientHeight / 2)
          element.scrollTop = pre.scrollTop
        }
      }

      var onKeyDown = function (event) {
        if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
          event.preventDefault()
          if (tab) saveTab(tab.id)
        } else if (event.key === 'F5') {
          event.preventDefault()
          compileActive()
        } else if (event.key === 'Tab') {
          event.preventDefault()
          if (!tab) return
          var element = event.target
          var start = element.selectionStart
          var end = element.selectionEnd
          setTab(tab.id, { text: tab.text.slice(0, start) + '  ' + tab.text.slice(end), dirty: true })
          requestAnimationFrame(function () { element.setSelectionRange(start + 2, start + 2) })
        }
      }

      var toggleDir = function (path) {
        var expanded = Object.assign({}, store.expanded)
        expanded[path] = expanded[path] === false
        patch({ expanded: expanded })
        persist()
      }

      var filtered = store.filter.trim()
        ? store.files.filter(function (file) { return file.rel.toLowerCase().indexOf(store.filter.trim().toLowerCase()) >= 0 })
        : null

      var treeContent = store.busy === 'tree'
        ? h('div', { style: Object.assign({}, S.hint, { padding: 4 }) }, '读取中…')
        : filtered
          ? (filtered.length
              ? filtered.map(function (file) {
                  return h('div', {
                    key: file.rel,
                    style: Object.assign({}, S.row, { paddingLeft: 6 }),
                    title: file.rel,
                    onClick: function () { openTab(store.root, file.rel) }
                  }, (file.editable ? '·' : '▤'), file.rel)
                })
              : h('div', { style: Object.assign({}, S.hint, { padding: 4 }) }, '没有匹配的文件'))
          : store.tree && store.tree.children.length
            ? store.tree.children.map(function (child) {
                return h(TreeBranch, {
                  key: child.rel || child.name,
                  node: child,
                  depth: 0,
                  expanded: store.expanded,
                  activeRel: tab ? tab.rel : null,
                  onOpen: function (rel) { openTab(store.root, rel) },
                  onToggle: toggleDir
                })
              })
            : h('div', { style: Object.assign({}, S.hint, { padding: 4, whiteSpace: 'pre-wrap' }) },
                store.root
                  ? (store.total > 0 ? '没有可显示的 .tex/.bib/.md/.pdf（另有 ' + store.skipped + ' 个其它文件）' : '这个目录是空的')
                  : '点「目录」选择一个工作目录')

      return h('div', { style: Object.assign({}, S.root, { colorScheme: store.scheme }) },
        // 顶栏
        h('div', { style: S.bar },
          h('button', {
            style: S.btn,
            title: '返回启动页（最近打开的项目）',
            onClick: function () { patch({ view: 'welcome', treeOpen: false }) }
          }, '首页'),
          h('select', {
            style: S.select,
            value: store.root,
            title: store.root || '选择工作区',
            onChange: function (event) {
              var next = event.target.value
              if (next) openRootFolder(next)
            }
          },
            h('option', { value: '' }, '工作区…'),
            store.workspaces.map(function (workspace) {
              return h('option', { key: workspace.path, value: workspace.path }, (workspace.title || workspace.path))
            })
          ),
          h('button', { style: S.btn, onClick: openDirectory, title: '选一个本地目录作为工作根' }, '目录'),
          h('button', {
            style: Object.assign({}, S.btn, store.treeOpen ? S.btnOn : null),
            title: '文件树（浮在编辑区上）',
            onClick: function () {
              var next = !store.treeOpen
              patch({ treeOpen: next })
              if (next && !store.tree && store.root) loadTree(store.root)
            }
          }, '树'),
          h('span', { style: S.spacer }),
          h('button', {
            style: Object.assign({}, S.btn, (!tab || !tab.dirty) ? S.dimmed : null),
            disabled: !tab || !tab.dirty,
            onClick: function () { if (tab) saveTab(tab.id) }
          }, '保存'),
          h('button', {
            style: Object.assign({}, S.btnPrimary, (!tab || store.busy === 'compile') ? S.dimmed : null),
            disabled: !tab || store.busy === 'compile',
            onClick: compileActive
          }, store.busy === 'compile' ? '编译中' : '编译')
        ),

        // 左右两栏：左边 tex，右边 pdf/日志（中间分隔条可拖动）
        h('div', { style: S.body, ref: bodyRef },
          h('div', { style: S.left, ref: leftRef },
            h('div', { style: S.tabsBar },
              store.tabs.length === 0
                ? h('span', { style: Object.assign({}, S.hint, { padding: '2px 4px' }) }, '未打开文件')
                : store.tabs.map(function (item) {
                    return h('span', {
                      key: item.id,
                      style: Object.assign({}, S.tab, item.id === store.activeId ? S.tabOn : null),
                      title: item.root + '\\' + item.rel,
                      onClick: function () { patch({ activeId: item.id }); persist() }
                    },
                      item.name + (item.dirty ? ' ●' : ''),
                      h('span', { style: S.tabClose, onClick: function (event) { event.stopPropagation(); closeTab(item.id) } }, '×'))
                  })
            ),
            h('div', { style: S.editorWrap },
              // 高亮层（含行号），textarea 透明叠在上面负责输入与滚动
              h('div', { style: S.hlWrap, ref: preRef, 'aria-hidden': 'true' }, highlighted),
              tab
                ? h('textarea', {
                    ref: textareaRef,
                    style: S.textareaOverlay,
                    value: tab.text,
                    spellCheck: false,
                    wrap: 'soft',
                    onChange: onEditorChange,
                    onScroll: onEditorScroll,
                    onKeyDown: onKeyDown
                  })
                : h('div', { style: Object.assign({}, S.hint, { padding: 10, whiteSpace: 'pre-wrap' }) },
                    '点「树」打开文件列表，选一个 .tex 开始编辑。\nF5 编译 · Ctrl+S 保存 · 可同时开多个标签。')
            ),

            // 悬浮文件树（右边框可拖动）
            store.treeOpen
              ? h('div', { style: S.overlay },
                  h('div', {
                    style: Object.assign({}, S.drawer, { width: (store.treeWidth * 100).toFixed(1) + '%' })
                  },
                    h('div', { style: S.drawerHead },
                      h('span', { style: { fontWeight: 500 } }, '文件'),
                      h('input', {
                        style: S.input,
                        placeholder: '过滤…',
                        value: store.filter,
                        autoFocus: true,
                        onChange: function (event) { patch({ filter: event.target.value }) }
                      }),
                      h('button', { style: S.btn, onClick: function () { patch({ treeOpen: false }) } }, '×')
                    ),
                    h('div', { style: S.drawerList }, treeContent),
                    store.truncated ? h('div', { style: Object.assign({}, S.hint, { padding: 4 }) }, '文件过多，已截断') : null,
                    h('div', { style: S.hsplit, onMouseDown: startTreeDrag, title: '拖动调整文件树宽度' })
                  ),
                  h('div', { style: S.backdrop, onClick: function () { patch({ treeOpen: false }) } })
                )
              : null
          ),

          // 可拖动的左右分隔条
          h('div', { style: S.vsplit, onMouseDown: startSplitDrag, title: '拖动调整 tex / pdf 宽度' }),

          h('div', { style: Object.assign({}, S.right, { width: (store.split * 100).toFixed(1) + '%' }) },
            h('div', { style: S.rightHead },
              h('span', {
                style: Object.assign({}, S.paneTab, store.pane === 'log' ? S.paneTabOn : null),
                onClick: function () { patch({ pane: 'log' }); persist() }
              }, '日志' + (store.log && store.log.errors && store.log.errors.length ? ' (' + store.log.errors.length + ')' : '')),
              h('span', {
                style: Object.assign({}, S.paneTab, store.pane === 'pdf' ? S.paneTabOn : null),
                onClick: function () { patch({ pane: 'pdf' }); persist() }
              }, 'PDF'),
              h('span', { style: S.spacer }),
              h('select', { style: S.select, value: store.engine, title: '引擎', onChange: function (event) { patch({ engine: event.target.value }); persist() } },
                ['auto', 'xelatex', 'pdflatex', 'lualatex', 'latexmk'].map(function (name) {
                  return h('option', { key: name, value: name }, name)
                })),
              h('select', { style: S.select, value: store.mode, title: '模式', onChange: function (event) { patch({ mode: event.target.value }); persist() } },
                [['full', '完整'], ['quick', '快速'], ['clean', '从头']].map(function (pair) {
                  return h('option', { key: pair[0], value: pair[0] }, pair[1])
                })),
              h('button', { style: S.btn, disabled: !tab, onClick: cleanActive, title: '删除 .aux/.log 等辅助文件' }, '清理'),
              store.pdfUrl ? h('a', { href: store.pdfUrl, target: '_blank', rel: 'noreferrer', style: { color: C.accent, fontSize: 11, textDecoration: 'none' } }, '新标签') : null
            ),
            store.pane === 'log'
              ? h('div', { style: S.pane }, h(LogPane, { log: store.log, onJump: jumpTo }))
              : h('div', { style: Object.assign({}, S.pane, { padding: 0, background: C.layer1 }) },
                  store.pdfUrl
                    ? h('iframe', {
                        src: store.pdfUrl,
                        title: 'PDF 预览',
                        style: {
                          width: '100%', height: '100%', border: 'none', background: '#fff',
                          pointerEvents: store.dragging ? 'none' : 'auto'
                        }
                      })
                    : h('div', { style: Object.assign({}, S.hint, { padding: 8 }) }, '编译成功后在这里预览 PDF。')),
            // 编译状态条：放在预览区底部（对齐墨灵 desktop 的底部状态条）
            store.notice ? h('div', { style: S.paneStatus, title: store.notice }, store.notice) : null,
            store.error ? h('div', { style: S.paneStatusError }, store.error) : null
          )
        ),

        // 状态行
        h('div', { style: S.status },
          h('span', {
            style: Object.assign({}, S.dot, { background: store.online === 'ok' ? C.ok : (store.online === 'error' ? C.err : C.idle) }),
            title: store.online === 'ok' ? '数据通道正常' : (store.online === 'error' ? '数据通道异常' : '未连接')
          }),
          h('span', null, store.busy ? store.busy : '就绪'),
          store.status && store.status.found
            ? h('span', { title: store.status.binDir }, 'TeX')
            : h('span', { style: { color: C.warn } }, '无 TeX'),
          tab ? h('span', { style: { fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis' } }, tab.rel) : null,
          visible ? null : h('span', { style: { marginLeft: 'auto', opacity: 0.7 } }, '后台')
        )
      )
    }

    /* ------------------------------------------------------------------ *
     * 注册：右侧栏标签类型 + 正文
     * ------------------------------------------------------------------ */

    var inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

    function apply(ctx) {
      // 组件从模块级 store 取 ctx（外壳不会把插件 ctx 当 props 传进来）
      state.ctx = ctx

      // 亮/暗：按页面底色判断，写进 store.scheme，供原生控件用
      ctx.effect(function () { return watchScheme() })

      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          title: function () { return '墨灵 LaTeX' },
          guide: [{
            order: 40,
            title: function () { return '墨灵 LaTeX' },
            description: function () { return '本地 LaTeX 工程：编辑 / 编译 / PDF' }
          }],
          keepMounted: true
        })
      })

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Body)
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.ID = ID
    exports.KIND = KIND
    exports.__store = state
    // 供离线自测直接验证词法与路径拼接（不依赖浏览器）
    exports.__tokenize = highlightDocument
    exports.__absolutePath = absolutePath
    exports.__recentAbsolute = recentAbsolute
    return module.exports
  }
})
