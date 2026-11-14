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
    /**
     * 编辑器两层的行号栏宽度（px）：textarea 靠 padding-left 让位，高亮层靠负 text-indent 拉回。
     * 两边必须一致，否则第一列字就整体错位。
     */
    var GUTTER = 56

    /**
     * 平台滚动条宽度（一次探测：塞一个隐藏的 overflow:scroll 元素量 offsetWidth - clientWidth）。
     *
     * 为什么必须两边一样宽：textarea 有滚动条时内容宽度少一个滚动条（约 15px），
     * 高亮层没有滚动条 → 两层换行点不同 → 视觉字形与光标所在字符整体错位，
     * 删除会删到前面去。以前靠 ResizeObserver 量，可文本从空变成有内容时
     * textarea 的**边框盒**没变、观察器不触发 → 量到 0，补偿失效。
     * 现在：textarea 用 `scrollbar-gutter: stable` 永远预留那条槽，
     * 高亮层永远补同样宽度 —— 与内容多少无关，恒定相等。
     */
    var scrollbarProbe = { width: null }

    function scrollbarWidthPx() {
      if (scrollbarProbe.width !== null) return scrollbarProbe.width
      var width = 0
      try {
        var probe = document.createElement('div')
        probe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll'
        document.body.appendChild(probe)
        width = Math.max(0, probe.offsetWidth - probe.clientWidth)
        document.body.removeChild(probe)
      } catch (error) {
        width = 0
      }
      scrollbarProbe.width = width
      return width
    }
    /**
     * 预览清晰度档位。值就是栅格化的 dpi：
     * 72 只够看版式（最省），96 约等于屏幕 1:1（默认），144 放大也清楚。
     * 降分辨率是刻意的——PDF 阅读器按设备像素渲染，滚动时整页重绘，成本压不下来。
     */
    var DPI_CHOICES = [
      { value: 72, label: '低' },
      { value: 96, label: '中' },
      { value: 144, label: '高' }
    ]

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
      // 只在「主题相关属性」变化时重算，且用 rAF 合并：
      // 外壳做面板动画时会连续改 <html> 的 style，跟着每条都 getComputedStyle 会强制重排 → 全局卡顿。
      var pending = false
      var applyScheme = function () {
        pending = false
        var next = detectScheme()
        if (next !== state.scheme) patch({ scheme: next })
      }
      var schedule = function () {
        if (pending) return
        pending = true
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyScheme)
        else setTimeout(applyScheme, 60)
      }
      applyScheme()
      var observer = null
      try {
        observer = new MutationObserver(schedule)
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'data-appearance']
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
      pdfUrl: '',           // 回退用：整份 PDF 的 blob（浏览器内置阅读器）
      pdfRel: '',
      pdfRoot: '',
      pdfRev: '',           // PDF mtime，作为图片的缓存键
      pdfPages: 0,          // 页数（0 = 还不知道 / 拿不到）
      pdfRaster: true,      // true = 降分辨率图片预览；false = 回退内置阅读器
      pdfDpi: 96,           // 预览清晰度（72 低 / 96 中 / 144 高）
      pdfZoom: 1,           // 预览缩放（Ctrl + 滚轮，0.5–3）
      pdfPageSize: null,    // 首页尺寸（PDF 点），定位环换算百分比要用
      pdfFocusPage: 0,      // 需要滚到第几页（0 = 不动）
      syncMark: null,       // {page,x,y}：SyncTeX 定位点（PDF 点坐标，用于画环）
      flashLine: 0,         // 跳转/定位的目标行（让编辑器把它闪一下，跳了才看得见）
      flashAt: 0,           // 触发时间戳：同一个行号重复跳也要重新闪
      syncBusy: '',
      syncNotice: '',       // 定位结果显示在底部状态栏（不占用预览区）
      menu: null,           // 编辑器右键菜单 {x, y, line}
      compileMenu: false,   // 编译分体按钮的小三角展开状态
      outlineOpen: false,   // 「提纲」浮层
      outline: null,        // {sections:[{level,title,line}], lines, labels, cites}
      outlineBusy: '',
      pdfFor: '',
      mode: 'full',
      engine: 'auto',
      busy: '',
      error: '',
      notice: '',
      noticeOk: true,     // 编译/保存结果：true 绿色、false 红色（显示在底部状态栏居中）
      recents: [],
      scheme: 'dark',
      // 模板库（宿主 templates 端点拉来）：清单 + 分类 + 搜索词 + 当前分类
      templates: [],
      templateCategories: [],
      templateQuery: '',
      templateCategory: '',
      templateBusy: '',
      // 模板库二级弹窗：启动页只留一个入口，点开后在弹窗里挑模板
      templatesOpen: false,
      templateStep: 'list',   // 'list' 挑模板 | 'target' 选存放位置（新建文件）
      templatePick: null,     // 选中的模板对象；{ blank: true } 表示空白 ctexart 骨架
      templateTarget: '',     // 第二步选中的存放目录（空 = 还没选）
      // 右栏（PDF/日志）占正文区的比例
      split: 0.45,
      // 文件树抽屉：0 = 自适应（高度按可见行数、宽度按最长文件名）；
      // 用户拖过右边框后记像素宽度，双击边框恢复自适应。
      treeW: 0,
      wrap: true,          // 编辑器软换行（大文件可关掉换行减轻原生 textarea 重排）
      autoCompile: false,  // 「自编」：保存 / 外部同步后自动编译一次（默认关）
      sessionId: '',       // 当前会话 id（造真 chip 时用来取会话作用域 ctx）
      inputSnap: null,     // 输入框 InputState 快照（由 InputBridge 渲染期桥接进来）
      saveMode: 'manual',  // 保存方式：'manual' 手动（Ctrl+S/点按钮）| 'auto' 停止输入后自动存
      saveMenu: false,     // 保存分体按钮的小三角展开状态
      dragging: false,
      booted: false,
      // 自动同步指示灯：null=还没跑过 / true=通 / false=失败（syncError 是原因）
      syncOk: null,
      syncError: ''
    }

    var listeners = new Set()
    var nextId = 1

    /* 外部改动同步（大模型 / 别的编辑器改磁盘 → 面板自己跟上）：
       stamps = 每个文件上次见到的「mtime|size」版本戳，treeSignature = 文件清单签名。 */
    var stamps = {}
    var treeSignature = ''
    var watchWarned = {}
    var missingNoticed = {}   // 文件在清单里消失时只提示一次（不关标签，见 applySyncSnapshot）
    var enteringRoot = false  // 正在进项目：这期间暂停轮询，避免同步把刚打开的主 tex 当成"已删除"
    var watchTimer = null
    var watchBusy = false
    var watchStartedAt = 0     // 本轮请求开始的时刻：请求万一卡死，6 秒后放行，不会永久锁住
    var syncFailAt = 0         // 失败红字的节流时间

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

    /* ------------------------------------------------------------------ *
     * 会话隔离（用户需求：A 会话进项目 A，切到 B 会话进项目 B，两边互不影响）
     *
     * 右栏 tab body 的槽位是 `scope:'session'`，每个会话各挂一份 Body；
     * 但这份 store 是**模块级**的，所有 Body 共用同一个对象 —— 于是在 A 会话
     * 进了项目 A，切到 B 会话照样显示项目 A。
     *
     * 做法：切会话时把「项目相关」的那批字段整块存进 shards[旧会话]，
     * 再把 shards[新会话] 装回来（没存过 → 回启动页，绝不把上一个会话的项目带过来）。
     * 设置类字段（编译方式/引擎/分栏宽/清晰度/最近打开…）**不参与隔离**：
     * 它们是这台机器的偏好，不是某个项目的状态。
     * ------------------------------------------------------------------ */

    /** 参与会话隔离的字段（其余字段全局共享）。 */
    var SESSION_FIELDS = [
      'view', 'root', 'tree', 'files', 'total', 'skipped', 'truncated',
      'expanded', 'treeOpen', 'filter', 'tabs', 'activeId', 'log', 'pane',
      'pdfUrl', 'pdfRel', 'pdfRoot', 'pdfRev', 'pdfPages', 'pdfRaster',
      'pdfPageSize', 'pdfFocusPage', 'pdfFor', 'syncMark', 'syncNotice',
      'outline', 'outlineOpen', 'menu', 'compileMenu', 'notice', 'noticeOk',
      'syncOk', 'syncError', 'error'
    ]

    var sessionShards = {}
    var currentSession = ''

    /** 一份空会话：除设置类字段外，全部回到「刚打开面板」的样子。 */
    function blankSession() {
      return {
        view: 'welcome', root: '', tree: null, files: [], total: 0, skipped: 0,
        truncated: false, expanded: {}, treeOpen: false, filter: '',
        tabs: [], activeId: null, log: null, pane: 'pdf',
        pdfUrl: '', pdfRel: '', pdfRoot: '', pdfRev: '', pdfPages: 0,
        pdfRaster: true, pdfPageSize: null, pdfFocusPage: 0, pdfFor: '',
        syncMark: null, syncNotice: '', outline: null, outlineOpen: false,
        menu: null, compileMenu: false, notice: '', noticeOk: true,
        syncOk: null, syncError: '', error: '',
        stamps: {}, treeSignature: ''
      }
    }

    /** 把当前项目状态整块摘下来（含外部同步用的版本戳）。 */
    function captureSession() {
      var snap = {}
      for (var i = 0; i < SESSION_FIELDS.length; i++) snap[SESSION_FIELDS[i]] = state[SESSION_FIELDS[i]]
      snap.stamps = stamps
      snap.treeSignature = treeSignature
      return snap
    }

    /**
     * 切到某个会话：先存旧的、再装新的。
     * 只在该会话的右栏可见时调用 —— 隐藏着的那份不许抢当前指针。
     * @returns 是否真的切换了（同一个会话重复调用是空操作）
     */
    function switchSession(id) {
      var key = String(id || '')
      if (!key || key === currentSession) return false
      if (currentSession) sessionShards[currentSession] = captureSession()
      currentSession = key
      var snap = sessionShards[key]
      if (!snap) {
        // 这个会话还没进过项目：回启动页。
        // 注意**不要**回收 state.pdfUrl：它属于刚被摘走的那个会话（已经在 shard 里），
        // 回收了下次切回去 PDF 预览就是一张破图。blob 的生命周期由 refreshPdf 管。
        snap = blankSession()
      }
      var next = {}
      for (var i = 0; i < SESSION_FIELDS.length; i++) next[SESSION_FIELDS[i]] = snap[SESSION_FIELDS[i]]
      next.sessionId = key   // 造 @ 引用 chip 时要用当前会话 id
      // 忙闲类字段是"某个请求正在跑"，不跟着项目走：切换时一律清掉，
      // 否则上一个会话里没跑完的编译/取图会让新会话永久卡在「忙」。
      next.busy = ''
      next.syncBusy = ''
      next.outlineBusy = ''
      next.dragging = false
      patch(next)
      stamps = snap.stamps || {}
      treeSignature = snap.treeSignature || ''
      // 提醒记录与待触发的定时器都属于上一个会话的项目，作废
      watchWarned = {}
      missingNoticed = {}
      enteringRoot = false   // 卡在「进项目」中间被切走 → 别让轮询永久暂停
      if (autoCompileTimer) { clearTimeout(autoCompileTimer); autoCompileTimer = null }
      if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null }
      pendingFlash = null
      return true
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
      // 自动保存的唯一触发点：任何「变脏」的改动（打字、粘贴、Tab 缩进…）都走这里
      if (next && next.dirty === true) scheduleAutoSave(id)
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
          treeW: state.treeW,
          wrap: state.wrap !== false,
          autoCompile: state.autoCompile === true,
          saveMode: state.saveMode === 'auto' ? 'auto' : 'manual',
          pdfDpi: state.pdfDpi,
          pdfZoom: state.pdfZoom,
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

    /**
     * 拉模板清单（启动页「模板」区）。
     * 只回元数据：模板文件合计 1.1 MB，落地时才由宿主从磁盘拷。
     * 失败不写 store.error —— 模板区只是启动页的一块配菜，不该把整页染红。
     */
    function loadTemplates() {
      return api('templates', {}).then(function (data) {
        patch({
          templates: Array.isArray(data.templates) ? data.templates : [],
          templateCategories: Array.isArray(data.categories) ? data.categories : []
        })
      }).catch(function () {
        patch({ templates: [], templateCategories: [] })
      })
    }

    function loadTree(root) {
      var target = root || state.root
      if (!target) return Promise.resolve()
      patch({ busy: 'tree' })
      return api('tree', { root: target }).then(function (data) {
        // 取树期间切了会话/切了项目：这份清单属于上一个项目，丢掉（否则新会话被旧文件树覆盖）
        if (normalizePath(target) !== normalizePath(state.root)) return undefined
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
        return undefined
      }).catch(function (failure) {
        if (normalizePath(target) !== normalizePath(state.root)) return
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
        // 读盘期间切了会话/切了项目：这个标签已经不在当前会话里了，别往新会话里塞
        if (!findTabById(id)) return undefined
        stampFile(rel, data.mtime, data.size)   // 记版本戳，轮询拿它比对
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
        return undefined
      }).catch(function (failure) {
        if (!findTabById(id)) return
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
        // 写盘期间切了会话：标签与版本戳都属于上一个会话，这里一律不动
        //（动了就会把旧项目的 notice/戳写进新会话）
        if (!findTabById(id)) return undefined
        stampFile(tab.rel, data.mtime, data.bytes)   // 自己写的：盖上新戳，别下一轮又当外部改动
        setTab(id, { dirty: false })
        patch({ busy: '', error: '', notice: '已保存 ' + tab.rel + '（' + (data.bytes || 0) + ' 字节）' })
        scheduleAutoCompile()   // 「自编」开着就顺手编一次
        return undefined
      }).catch(function (failure) {
        if (!findTabById(id)) return
        patch({ busy: '', error: describe(failure) })
      })
    }

    function compileActive() {
      var tab = activeTab()
      if (!tab) { patch({ error: '先打开一个 .tex 文件' }); return Promise.resolve() }
      patch({ busy: 'compile', error: '', notice: '正在编译 ' + tab.rel + ' …', noticeOk: true })
      var chain = tab.dirty ? saveTab(tab.id) : Promise.resolve()
      return chain.then(function () {
        return api('compile', { root: tab.root, file: tab.rel, mode: state.mode, engine: state.engine })
      }).then(function (data) {
        // 编译期间切了项目：结果属于上一个项目，丢掉（旧日志/旧 PDF 不跟过来）
        if (normalizePath(tab.root) !== normalizePath(state.root)) return undefined
        patch({
          log: data,
          busy: '',
          error: '',
          pane: data.success ? 'pdf' : 'log',
          noticeOk: Boolean(data.success),
          notice: data.success
            ? '编译成功 · ' + data.engine + ' · ' + (data.durationMs / 1000).toFixed(1) + 's · ' + data.passes + ' 趟'
            : '编译失败 · ' + (data.errors || []).length + ' 条错误'
        })
        if (data.success && data.pdfRel) return refreshPdf(tab.root, data.pdfRel, data.pdfMtime)
        return undefined
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure), notice: '编译失败', noticeOk: false, pane: 'log' })
      })
    }

    /**
     * 「自编」= 自动编译。保存成功 / 外部改动同步进来之后，防抖 900ms 编一次：
     *   · 大模型连续改几处 → 只编最后一次，不炸编译进程
     *   · 面板正忙（编译中/读文件中）就跳过这一轮，不排队堆积
     */
    var autoCompileTimer = null
    function scheduleAutoCompile() {
      if (state.autoCompile !== true) return
      if (typeof setTimeout !== 'function') return
      if (autoCompileTimer) { clearTimeout(autoCompileTimer); autoCompileTimer = null }
      autoCompileTimer = setTimeout(function () {
        autoCompileTimer = null
        if (state.autoCompile !== true) return
        if (state.busy) return
        if (!activeTab()) return
        compileActive()
      }, 900)
    }

    /** 保存方式（分体按钮的菜单项）：手动 / 自动。 */
    var SAVE_MODES = [
      ['manual', '手动保存'],
      ['auto', '自动保存']
    ]
    var autoSaveTimer = null
    /**
     * 自动保存：编辑（标签变脏）之后停手 1.2 秒存一次。
     * 手动模式什么都不做；面板忙（编译中）也先不打断，等下一轮编辑再存。
     */
    function scheduleAutoSave(id) {
      if (state.saveMode !== 'auto') return
      if (typeof setTimeout !== 'function') return
      if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null }
      autoSaveTimer = setTimeout(function () {
        autoSaveTimer = null
        if (state.saveMode !== 'auto') return
        var tab = findTabById(id)
        if (!tab || !tab.dirty) return
        saveTab(tab.id)
      }, 1200)
    }

    /** 「提纲」用的章节命令（长命令排前面，避免 \section 抢了 \subsection 的前缀）。 */
    var OUTLINE_COMMANDS = [
      ['subsubsection', 4], ['subsection', 3], ['section', 2],
      ['chapter', 1], ['part', 1], ['paragraph', 5]
    ]

    /**
     * 从内存里的源码解析提纲（不往宿主跑：文件本来就在手里，省一次往返也省得重启）。
     * 与宿主 lib/latex.js 的 parseOutline 同一套规则：跳过注释行，取 {} 里的标题与行号。
     */
    function parseOutlineText(text) {
      var lines = String(text || '').split('\n')
      var sections = []
      var labels = 0
      var cites = 0
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        if (/^\s*%/.test(line)) continue
        for (var j = 0; j < OUTLINE_COMMANDS.length; j++) {
          var name = OUTLINE_COMMANDS[j][0]
          var match = line.match(new RegExp('(^|[^A-Za-z@\\\\])\\\\' + name + '\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}'))
          if (match) {
            sections.push({ level: OUTLINE_COMMANDS[j][1], command: name, title: match[2].trim(), line: i + 1 })
            break
          }
        }
        labels += (line.match(/\\label\s*\{/g) || []).length
        cites += (line.match(/\\cite[a-zA-Z]*\s*(?:\[[^\]]*\])*\s*\{/g) || []).length
      }
      return { sections: sections, lines: lines.length, labels: labels, cites: cites }
    }

    /** 「提纲」：解析当前 tex 的章节标题（\part…\paragraph），供左下角浮层显示。 */
    function loadOutline() {
      var tab = activeTab()
      if (!tab) { patch({ outline: null }); return Promise.resolve() }
      patch({ outline: parseOutlineText(tab.text), outlineBusy: '' })
      return Promise.resolve()
    }

    /** 路径归一化：统一反斜杠、去尾部斜杠、大小写不敏感（Windows）。 */
    function normalizePath(value) {
      return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    }

    /** 取路径最后一段（目录名）。 */
    function baseNameOf(value) {
      var text = String(value || '').replace(/\//g, '\\').replace(/\\+$/, '')
      var index = text.lastIndexOf('\\')
      return index >= 0 ? text.slice(index + 1) : text
    }

    /* ------------------------------------------------------------------ *
     * 文件树抽屉的自适应尺寸（用户要求：高度看文件数量、宽度看最长文件名）
     * 下面几个常量跟 S.drawerHead / S.row 的 padding、fontSize 对齐，
     * 改样式时要一起改，否则宽度会估短、行高会估矮。
     * ------------------------------------------------------------------ */
    var TREE_ROW_H = 21        // S.row：padding 3+3 + 行高 15
    var TREE_INDENT = 10       // 每层缩进（TreeBranch 的 depth * 10）
    var TREE_ROW_PAD = 16      // 行左内边距 3 + 右 8 + 余量
    var TREE_MARK_W = 15       // 行首图标 9 + gap 6
    var TREE_HEAD_H = 27       // S.drawerHead：padding 4+4 + 行高 15 + 下边框 1
    var TREE_LIST_PAD = 10     // S.drawerList：padding 4 + 6
    var TREE_MIN_W = 168       // 表头「文件 N 个 + 过滤框 + ×」至少要这么宽
    var TREE_MAX_W = 560       // 再长的文件名也不让抽屉占满整个编辑区

    /** 估一段文本的像素宽：中文/全角按全角算，其余按半角。只用来挑抽屉宽度。 */
    function treeTextWidth(text) {
      var width = 0
      var value = String(text || '')
      for (var index = 0; index < value.length; index += 1) {
        width += value.charCodeAt(index) > 0x2e7f ? 11.5 : 6.6
      }
      return width
    }

    /**
     * 算出文件树抽屉「刚好装下内容」的尺寸。
     *   rows   —— 当前展开状态下可见的行数（过滤时按过滤结果算）
     *   width  —— 最长那行的名字宽度（夹在 TREE_MIN_W…TREE_MAX_W 之间）
     *   height —— 表头 + 所有行
     * 纯函数：不读 DOM，测试里直接调。
     */
    function treeAutoSize(options) {
      var tree = options && options.tree
      var expanded = (options && options.expanded) || {}
      var files = (options && options.files) || []
      var filter = String((options && options.filter) || '').trim().toLowerCase()
      var entries = []
      var index
      if (filter) {
        for (index = 0; index < files.length; index += 1) {
          var rel = String(files[index].rel || '')
          if (rel.toLowerCase().indexOf(filter) >= 0) entries.push({ name: rel, depth: 0 })
        }
      } else if (tree && tree.children) {
        var walk = function (nodes, depth) {
          for (var cursor = 0; cursor < nodes.length; cursor += 1) {
            var node = nodes[cursor]
            entries.push({ name: String(node.name || node.rel || ''), depth: depth })
            if (node.type !== 'file' && expanded[node.rel] !== false && node.children && node.children.length) {
              walk(node.children, depth + 1)
            }
          }
        }
        walk(tree.children, 0)
      }
      var width = TREE_MIN_W
      for (index = 0; index < entries.length; index += 1) {
        var need = TREE_ROW_PAD + TREE_MARK_W + entries[index].depth * TREE_INDENT +
          treeTextWidth(entries[index].name)
        if (need > width) width = need
      }
      return {
        rows: entries.length,
        width: Math.ceil(Math.min(width, TREE_MAX_W)),
        height: Math.ceil(TREE_HEAD_H + TREE_LIST_PAD + entries.length * TREE_ROW_H)
      }
    }

    /**
     * 当前项目是否已经在左侧 DSH 工作区里打开。
     *   linked   —— 路径命中某个**工作区**
     *   conflict —— 有同名工作区，但路径不是它（换个副本，别把内容发错项目）
     *   none     —— 没有同名也没有同路径
     *   unknown  —— 工作区列表还没拿到
     *
     * 注意：宿主返回的列表里既有 kind:'workspace'（左侧真正的工作区），
     * 也有 kind:'opened'（只是插件自己打开过的目录）。后者**不算连接** ——
     * 之前没过滤，导致"没在工作区里"也显示已连接。
     */
    function connectionOf(root, workspaces) {
      var all = Array.isArray(workspaces) ? workspaces : []
      var list = all.filter(function (entry) {
        return entry && (!entry.kind || entry.kind === 'workspace')
      })
      if (!root) return { state: 'none', text: '未打开项目', detail: '先打开一个项目目录' }
      if (!list.length) {
        return {
          state: 'unknown',
          text: '未连接 DSH 工作区',
          detail: all.length ? '这些目录只是插件打开过，还没进左侧工作区（点一下加入）' : '没拿到 DSH 工作区列表（点一下重试）'
        }
      }
      var target = normalizePath(root)
      var base = baseNameOf(root).toLowerCase()
      var sameName = null
      for (var i = 0; i < list.length; i++) {
        var path = list[i] && list[i].path
        if (!path) continue
        if (normalizePath(path) === target) {
          return {
            state: 'linked',
            text: '已连接 DSH 工作区',
            detail: '这个项目已在左侧工作区：' + (list[i].title || baseNameOf(path)),
            workspace: list[i]
          }
        }
        if (baseNameOf(path).toLowerCase() === base) sameName = list[i]
      }
      if (sameName) {
        return {
          state: 'conflict',
          text: '同名工作区不同路径',
          detail: '左侧有同名工作区但路径不同：' + normalizePath(sameName.path) + '\n点一下把当前路径也加进工作区'
        }
      }
      return { state: 'none', text: '未连接 DSH 工作区', detail: '点一下把「' + baseNameOf(root) + '」加进左侧工作区' }
    }

    /**
     * 把 `@文件:行范围` 变成 DSH 输入框里的**真 chip**（圆角方框那种）。
     *
     * DSH 的 chip = InputState.occurrences 的一条记录，只能由
     * `slash/input-insert-reference` 这个**作用域事件**（`actx.bail`）把某段 token span
     * 替换成 ReferenceInsert 才会生成。公共的 inputActions 看不到这条路径，
     * 但只要拿得到会话作用域 ctx（`ctx.get('sessions').scope(sessionId)`）就能自己发。
     *
     * 步骤：先 setDraft 把 `@文件:行范围` 写进草稿 → 再发事件把这整段 span 换成 chip。
     * 任何一步不行就返回 false，调用方退回纯文本（宁可不好看，也不能没反应）。
     */
    /**
     * 把 `@文件:行范围` 变成 DSH 输入框里的**真 chip**（圆角方框那种）。
     *
     * chip = InputState.occurrences 的一条，只能由 `slash/input-insert-reference`
     * 这个**作用域事件**（`actx.bail`）把某段 token span 换成 ReferenceInsert 才生成。
     *
     * 关键坑：`inputActions` 上没有 `state`，草稿与 draftRev 只能从注入的 useInput 读，
     * 而 useInput 是 **React 渲染后才更新**的 —— setDraft 之后同帧读到的还是旧 rev，
     * span 的 CAS 必然被拒（`setDraft 后读不到新的 draftRev` 就是这么来的）。
     * 所以这里 setDraft 之后**等一帧/两帧**再读 rev，然后才发事件。
     *
     * @param {string} mention - `@文件:行范围`（chip 只覆盖这一段）
     * @param {string} tail - chip 后面紧跟的文字（选中的原文）；DSH 的 @ 语法只能表达
     *   「文件:行」，表达不了行内片段，所以精确选区必须紧跟在 chip 之后一起写进草稿。
     * @returns {Promise<{ok:boolean, why:string}>} 永不 reject
     */
    function tryInsertReferenceChip(mention, actions, ctx, sessionId, inputSnapshot, props, tail) {
      return new Promise(function (resolve) {
        var settle = function (value) { resolve(value) }
        try {
          if (!actions) {
            settle({ ok: false, why: '没拿到 inputActions ｜ ' + describeRuntime(props, ctx, sessionId) })
            return
          }
          if (typeof actions.setDraft !== 'function') { settle({ ok: false, why: 'inputActions 没有 setDraft' }); return }
          if (!ctx || typeof ctx.get !== 'function') { settle({ ok: false, why: '插件 ctx 不可用' }); return }
          var sessions = ctx.get('sessions')
          if (!sessions) { settle({ ok: false, why: 'ctx 取不到 sessions 服务' }); return }
          if (typeof sessions.scope !== 'function') { settle({ ok: false, why: 'sessions 没有 scope()' }); return }
          if (!sessionId) { settle({ ok: false, why: '没拿到当前会话 id' }); return }
          var actx = sessions.scope(sessionId)
          if (!actx) { settle({ ok: false, why: 'scope 返回空' }); return }
          if (typeof actx.bail !== 'function') { settle({ ok: false, why: '会话 ctx 没有 bail()' }); return }
          var read = function () {
            try { return typeof inputSnapshot === 'function' ? inputSnapshot() : null } catch (error) { return null }
          }
          var snap = read()
          if (!snap || typeof snap.draft !== 'string') {
            settle({ ok: false, why: '读不到输入框草稿（useInput 没注入）' })
            return
          }
          var base = snap.draft
          var draft = base + (base && !/\s$/.test(base) ? ' ' : '') + mention + ' '
          var start = draft.length - mention.length - 1
          actions.setDraft(draft)
          // 等 React 把新状态喂回来，再读新 rev（同帧读必然是旧值）
          var tries = 0
          var waitRev = function () {
            var after = read()
            var rev = after && typeof after.draftRev === 'number' ? after.draftRev : 0
            var draftOk = Boolean(after) && after.draft === draft
            if ((!rev || !draftOk) && tries < 6) {
              tries += 1
              setTimeout(waitRev, 16)
              return
            }
            if (!rev || !draftOk) {
              try { actions.setDraft(base) } catch (error) { /* 忽略 */ }
              settle({ ok: false, why: '等不到新 draftRev（rev=' + rev + ' 草稿' + (draftOk ? '已更新' : '未更新') + '）' })
              return
            }
            var ok = false
            try {
              ok = actx.bail(actx, 'slash/input-insert-reference', {
                reference: {
                  source: 'reference',
                  ref: mention,
                  label: mention.replace(/^@/, ''),
                  appearance: 'file',
                  clipboardText: mention
                },
                span: { start: start, end: start + mention.length, draftRev: rev }
              }) === true
            } catch (error) {
              settle({ ok: false, why: '发事件抛错：' + describe(error) })
              return
            }
            if (!ok) {
              try { actions.setDraft(base) } catch (error) { /* 忽略 */ }
              settle({ ok: false, why: '事件没被接受（rev=' + rev + ' start=' + start + '）' })
              return
            }
            settle({ ok: true, why: '' })
          }
          setTimeout(waitRev, 16)
        } catch (error) {
          settle({ ok: false, why: '抛错：' + describe(error) })
        }
      })
    }

    /**
     * 取「注入属性」：Workbench 收到的是 `{ props, store }` 这层包装，
     * 真正的注入面（inputActions / useInput / sessionId）在 `props.props` 里。
     * 之前一直读 `props.inputActions` —— 读的是包装层，永远 undefined
     * （状态栏那句 `props=[props,...]` 就是这么暴露的）。两层都试，别写死。
     */
    function injected(props) {
      if (!props) return {}
      var inner = props.props
      if (inner && typeof inner === 'object') return inner
      return props
    }

    /**
     * 运行时探测：右栏 tab body 到底被注入了什么（chip 失败时写进状态栏，别再靠猜）。
     */
    function describeRuntime(props, ctx, sessionId) {
      var bits = []
      var face = injected(props)
      try {
        bits.push('props=[' + (props ? Object.keys(props).join(',') : '空') + ']')
        bits.push('注入=[' + (face && face !== props ? Object.keys(face).join(',') : '同上') + ']')
      } catch (error) { bits.push('props=?') }
      bits.push('sessionId=' + (sessionId ? String(sessionId).slice(0, 8) : '无'))
      try {
        var sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
        bits.push('sessions=' + (sessions ? (typeof sessions.scope === 'function' ? '有scope' : '无scope') : '无'))
        if (sessions && typeof sessions.scope === 'function' && sessionId) {
          var actx = sessions.scope(sessionId)
          bits.push('actx=' + (actx ? '有' : '无'))
          if (actx && typeof actx.get === 'function') {
            // 会话作用域上最可能有输入门面的两个名字
            bits.push('actx.conversation=' + (actx.get('conversation') ? '有' : '无'))
            bits.push('actx.input=' + (actx.get('input') ? '有' : '无'))
          }
        }
      } catch (error) { bits.push('探测抛错') }
      return bits.join(' ')
    }
    /**
     * 直接把输入框草稿写成 `@文件:行范围` 并**立刻**取回新的 draftRev。
     *
     * 为什么不走 useInput 桥接：那是异步的（React 渲染后才有新快照），
     * setDraft 之后立刻读到的还是旧 rev → span 的 CAS 必然失败（踩过）。
     * 正确做法是会话作用域上的 SessionInputShell.state（SnapshotStore）——
     * 它的 `getSnapshot()` 是**同步**的，setDraft 之后马上就能读到新 rev。
     *
     * 拿不到就返回 null，调用方退回 useInput 桥接值。
     */
    function liveInputState(ctx, sessionId) {
      try {
        if (!ctx || typeof ctx.get !== 'function' || !sessionId) return null
        var sessions = ctx.get('sessions')
        if (!sessions || typeof sessions.scope !== 'function') return null
        var actx = sessions.scope(sessionId)
        if (!actx || typeof actx.get !== 'function') return null
        // DSH 里输入门面挂在会话作用域的 conversation 服务上（见 ui-conversation/input/hub）
        var conversation = actx.get('conversation')
        if (conversation && conversation.input && typeof conversation.input.getSnapshot === 'function') {
          return conversation.input
        }
        if (conversation && conversation.input && conversation.input.state
          && typeof conversation.input.state.getSnapshot === 'function') {
          return conversation.input.state
        }
        return null
      } catch (error) {
        return null
      }
    }

    /**
     * 把输入框的 InputState 桥接进 store。
     *
     * `useInput` 是 React hook，只能在**渲染期**调用 —— 事件处理里调它属于违规。
     * 所以单独做一个只渲染 null 的桥组件：父级只在 `props.useInput` 存在时才挂它，
     * 组件内部无条件调用 hook（条件渲染子组件是合法的，条件调用 hook 才不合法）。
     */
    function InputBridge(props) {
      var snap = props.useInput(function (value) { return value })
      React.useEffect(function () { patch({ inputSnap: snap }) }, [snap])
      return null
    }
    function formatSelectionMention(rel, fromLine, toLine) {
      var path = String(rel || 'tex').replace(/\\/g, '/')
      var range = fromLine > 0 ? (fromLine === toLine ? ':' + fromLine : ':' + fromLine + '-' + toLine) : ''
      return '@' + path + range
    }

    function formatSelectionPayload(rel, fromLine, toLine, text) {
      var body = String(text || '').replace(/\s+$/, '')
      return formatSelectionMention(rel, fromLine, toLine) + '\n\n```latex\n' + body + '\n```\n\n'
    }

    /**
     * 送进对话框的形态：**一行** `@文件:行范围 「选中的那段文字」`。
     *   · 前半是 DSH 原生的文件引用写法（模型会自己去 read）；
     *   · 后半把**真正选中的那段**原样带上 —— 只选了一行里几个字时就只带那几个字，
     *     不能因为"整行引用"把用户的选区吞掉（用户明确抱怨过这点）。
     * 只占一行、不糊代码块；选中内容超过 120 字才截断。
     */
    function formatSelectionCompact(rel, fromLine, toLine, text) {
      var mention = formatSelectionMention(rel, fromLine, toLine)
      var picked = String(text || '').replace(/\s+/g, ' ').trim()
      if (picked.length > 120) picked = picked.slice(0, 120) + '…'
      return mention + (picked ? ' `' + picked.replace(/`/g, 'ˋ') + '`' : '') + '\n\n'
    }

    /**
     * 把文本送进 DSH 的对话框输入框。
     *
     * 三条路，从"官方"到"兜底"：
     *   1. 右栏 tab body 的注入属性 inputActions（不同版本方法名不同，逐个探）
     *   2. DOM：找到页面里可见的 contenteditable / textarea（排除面板自己），插到光标处
     *   3. 复制到剪贴板，让用户自己粘贴
     * 返回 { ok, how, report } —— report 用于失败时把探测到的情况写进状态栏。
     */
    function insertIntoChatInput(payload, actions) {
      var report = []
      // 只试"写入"类方法，不试 send/submit —— 自动发送不是我们要的行为
      var names = ['appendText', 'insertText', 'setText', 'setInput', 'setValue', 'setDraft', 'writeText', 'replaceText', 'append', 'insert']
      var keys = []
      try { keys = actions ? Object.keys(actions) : [] } catch (error) { keys = [] }
      report.push('inputActions:' + (actions ? (keys.length ? keys.join(',') : '空对象') : '无'))
      for (var i = 0; i < names.length; i++) {
        if (actions && typeof actions[names[i]] === 'function') {
          try {
            actions[names[i]](payload)
            return { ok: true, how: 'inputActions.' + names[i], report: report.join(' / ') }
          } catch (error) { report.push(names[i] + ' 抛错') }
        }
      }

      // DOM 兜底：页面里可见的富文本/文本域输入框（跳过面板自己的）
      if (typeof document !== 'undefined') {
        var ours = function (element) {
          return element && element.closest && element.closest('[data-moling="1"]')
        }
        var visible = function (element) {
          var rect = element.getBoundingClientRect()
          return rect.width > 80 && rect.height > 12
        }
        var areas = document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')
        for (var a = areas.length - 1; a >= 0; a--) {
          var area = areas[a]
          if (ours(area) || !visible(area)) continue
          try {
            area.focus()
            var selection = window.getSelection()
            var range = document.createRange()
            range.selectNodeContents(area)
            range.collapse(false)
            selection.removeAllRanges()
            selection.addRange(range)
            if (document.execCommand('insertText', false, payload)) {
              report.push('DOM:contenteditable')
              return { ok: true, how: 'DOM contenteditable', report: report.join(' / ') }
            }
          } catch (error) { /* 试下一个 */ }
        }
        report.push('contenteditable:没插进去')

        var fields = document.querySelectorAll('textarea')
        for (var t = fields.length - 1; t >= 0; t--) {
          var field = fields[t]
          if (ours(field) || !visible(field)) continue
          try {
            field.focus()
            var proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            var next = field.value + payload
            if (proto && proto.set) proto.set.call(field, next)
            else field.value = next
            field.dispatchEvent(new Event('input', { bubbles: true }))
            report.push('DOM:textarea')
            return { ok: true, how: 'DOM textarea', report: report.join(' / ') }
          } catch (error) { /* 试下一个 */ }
        }
        report.push('textarea:没插进去')
      }
      return { ok: false, how: '', report: report.join(' / ') }
    }

    /** 把当前项目目录登记成 DSH 工作区（左侧列表里出现）。 */
    function connectWorkspace() {
      var root = state.root
      if (!root) { patch({ syncNotice: '先打开一个项目目录' }); return Promise.resolve() }
      var ctx = state.ctx
      var service = ctx && typeof ctx.get === 'function' ? ctx.get('workspaces') : null
      if (!service || typeof service.create !== 'function') {
        patch({ syncNotice: '当前组合没有工作区服务，无法自动连接（请手动在左侧添加）' })
        return Promise.resolve()
      }
      patch({ syncNotice: '正在把「' + baseNameOf(root) + '」加进 DSH 工作区…' })
      return service.create({ path: root }).then(function (view) {
        patch({ syncNotice: '已连接：' + ((view && view.title) || baseNameOf(root)) })
        return loadWorkspaces()
      }).catch(function (failure) {
        patch({ syncNotice: '连接失败：' + describe(failure) })
      })
    }

    /**
     * 刷新 PDF 预览。
     *
     * 默认走「降分辨率图片」：只用 `meta` 拿到页数与 mtime，真正的像素由宿主用
     * pdftoppm 按所选 dpi 栅格化成一页一张 PNG，交给 <img> 加载（浏览器只做缩放，
     * 不做 PDF 解析与整页重绘）。下面这些开销因此全部消失：
     *   · 整份 PDF 转 base64（48MB 的 PDF 是 64MB 字符串）
     *   · PDFium 按设备像素渲染整页、滚动时重绘
     * 拿不到 poppler（`raster: false`）或第一页取图失败时，退回内置阅读器的 blob 预览。
     */
    function refreshPdf(root, rel, rev) {
      var key = root + '|' + rel + '|' + (rev || '')
      if (state.pdfFor === key && (state.pdfPages > 0 || state.pdfUrl)) return Promise.resolve()
      patch({ busy: 'pdf' })
      return api('pdf', { root: root, path: rel, meta: true }).then(function (data) {
        // 取图期间切了项目：这份 PDF 属于上一个项目，丢掉结果
        // （否则 closeProjectFiles 刚关干净，旧 PDF 又自己冒出来）
        if (normalizePath(root) !== normalizePath(state.root)) return undefined
        var raster = data.raster !== false && Number(data.pages) > 0
        stampFile(rel, data.mtime, data.bytes)   // 自己编译出来的：盖戳，免得又被轮询换一次
        patch({
          pdfRoot: root,
          pdfRel: rel,
          pdfRev: String(data.mtime || rev || ''),
          pdfPages: Number(data.pages) || 0,
          pdfPageSize: data.pageSize || null,
          pdfRaster: raster,
          pdfFor: key,
          busy: '',
          error: '',
          pane: 'pdf'
        })
        if (!raster) return loadPdfBlob()
        return undefined
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure) })
      })
    }

    /** 回退路径：一次取整份 PDF 的 base64 → blob，交给浏览器内置阅读器。 */
    function loadPdfBlob() {
      if (!state.pdfRoot || !state.pdfRel) return Promise.resolve()
      var root = state.pdfRoot
      var rel = state.pdfRel
      return api('pdf', { root: root, path: rel }).then(function (data) {
        if (!data.base64) return undefined
        // 取整份 PDF 期间切了项目：旧项目的 blob 不往回挂
        if (normalizePath(root) !== normalizePath(state.root)) return undefined
        var url = base64ToBlobUrl(data.base64, 'application/pdf')
        var previous = state.pdfUrl
        patch({ pdfUrl: url })
        if (previous && previous.indexOf('blob:') === 0) {
          try { URL.revokeObjectURL(previous) } catch (error) { /* 忽略 */ }
        }
        return undefined
      }).catch(function (failure) {
        patch({ error: describe(failure) })
      })
    }

    /** 单页图片地址：带 mtime 与 dpi，宿主那边可以长期缓存。 */
    function pdfPageUrl(page) {
      return API + '/pdf-page?root=' + encodeURIComponent(state.pdfRoot)
        + '&path=' + encodeURIComponent(state.pdfRel)
        + '&page=' + page + '&dpi=' + state.pdfDpi
        + (state.pdfRev ? '&v=' + encodeURIComponent(state.pdfRev) : '')
    }

    /** 任何一页取图失败就整体退回内置阅读器（比如 poppler 被删了）。 */
    function onPdfPageError() {
      if (!state.pdfRaster) return
      patch({ pdfRaster: false, error: '降分辨率预览不可用（取图失败），已退回浏览器内置 PDF 阅读器' })
      loadPdfBlob()
    }

    function cleanActive() {      var tab = activeTab()
      if (!tab) return Promise.resolve()
      patch({ busy: 'clean' })
      return api('clean', { root: tab.root, file: tab.rel }).then(function (data) {
        patch({ busy: '', error: '', notice: '已清理 ' + (data.deleted || []).length + ' 个辅助文件' })
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure) })
      })
    }

    /**
     * 在文件清单里挑「主 tex」：
     *   1) **最近在这个项目里打开过的 .tex**（用户上次看的那个就是他要继续的"主文件"，
     *      哪怕目录里躺着一个 main.tex —— 踩过的坑：main.tex 排第一时，用户删掉模板
     *      产物、重进目录又被 main.tex 抢走，看着像"删了没删掉"）；
     *   2) `main.tex`（不区分大小写；根目录优先、浅的优先、同深取字典序前）；
     *   3) 整个项目只有一个 .tex → 选它；
     *   4) 根目录（rel 不含 "/"）只有一个 .tex → 选它；
     *   5) 还有多个候选 → 选**体积最大**的（论文章节/片段通常远小于主文件）；
     *   6) 一个 .tex 都没有 → null（什么都不开）。
     * 返回相对路径（rel），不是 file 对象。
     */
    function pickMainTex(files, options) {
      var settings = options || {}
      var tex = (files || []).filter(function (file) { return /\.tex$/i.test(String(file.rel || '')) })
      if (!tex.length) return null
      var norm = function (file) { return String(file.rel || '').replace(/\\/g, '/') }
      var depth = function (file) { return norm(file).split('/').length }
      // 1) 最近打开过：同一项目里上次在看的那个文件，就是"主文件"（优先于 main.tex）
      var recents = Array.isArray(settings.recents) ? settings.recents : []
      var root = settings.root ? String(settings.root) : ''
      for (var r = 0; r < recents.length; r++) {
        var entry = recents[r]
        if (!entry || entry.kind !== 'file') continue
        if (root && entry.root && normalizePath(entry.root) !== normalizePath(root)) continue
        var wanted = String(entry.value || '').replace(/\\/g, '/').toLowerCase()
        if (!wanted) continue
        for (var i = 0; i < tex.length; i++) {
          if (norm(tex[i]).toLowerCase() === wanted) return tex[i].rel
        }
      }
      // 2) main.tex（根目录优先、浅的优先、同深取字典序前）
      var mains = tex.filter(function (file) {
        return norm(file).split('/').pop().toLowerCase() === 'main.tex'
      })
      if (mains.length) {
        mains.sort(function (a, b) {
          return depth(a) - depth(b) || norm(a).localeCompare(norm(b))
        })
        return mains[0].rel
      }
      if (tex.length === 1) return tex[0].rel
      // 4) 根目录只有一个 .tex（章节都在子目录里时，根目录那个就是入口）
      var top = tex.filter(function (file) { return depth(file) === 1 })
      if (top.length === 1) return top[0].rel
      // 5) 兜底：体积最大的（并列取字典序最小的，保证结果稳定）
      var sorted = tex.slice().sort(function (a, b) {
        return (Number(b.size) || 0) - (Number(a.size) || 0) || norm(a).localeCompare(norm(b))
      })
      return sorted[0].rel
    }

    /**
     * 当前标签页对应的 PDF（相对路径）。
     * 必须按**同名**找，不能盲用 store.pdfRel —— 后者是"上一次编译/预览的 PDF"，
     * 一个项目里多个 tex 时必然配错：正向定位报 SyncTeX「No tag for …」，
     * 反向定位跳到另一个文件的行号（而且 success:true，界面上看不出错）。
     * 顺序：① 文件清单里有同名 PDF → 用它；② 清单还没刷新（刚编译完）但上一次
     * 预览/编译的 PDF 恰好同名 → 用它；③ 都没有 → 空串（调用方给出明确提示）。
     */
    function pdfRelForTab(tab, files, fallback) {
      if (!tab) return ''
      var rel = String(tab.rel || '').replace(/\\/g, '/')
      if (!/\.(tex|ltx|latex)$/i.test(rel)) return ''
      var wanted = rel.replace(/\.(tex|ltx|latex)$/i, '.pdf')
      var list = Array.isArray(files) ? files : []
      for (var i = 0; i < list.length; i++) {
        var candidate = String((list[i] && list[i].rel) || '').replace(/\\/g, '/')
        if (candidate.toLowerCase() === wanted.toLowerCase()) return list[i].rel
      }
      if (fallback) {
        var last = String(fallback).replace(/\\/g, '/')
        if (last.toLowerCase() === wanted.toLowerCase()) return fallback
      }
      return ''
    }

    /**
     * SyncTeX 反向定位返回的 `file`（绝对路径，可能是 `E:/a/./b.tex` 这种）→ 项目内相对路径。
     * 返回空串表示"不在当前项目里"，调用方只提示、不乱跳。
     */
    function relFromSynctexFile(root, file, files) {
      var target = normalizePath(String(file || '').replace(/\/\.\//g, '/'))
      if (!target || !root) return ''
      var list = Array.isArray(files) ? files : []
      for (var i = 0; i < list.length; i++) {
        var rel = (list[i] && list[i].rel) || ''
        if (!rel) continue
        if (normalizePath(absolutePath(root, rel)) === target) return rel
      }
      var base = normalizePath(root)
      if (target.indexOf(base + '\\') === 0) return target.slice(base.length + 1).replace(/\\/g, '/')
      return ''
    }

    /**
     * 切到**另一个**项目文件夹时，把上一个项目里打开的东西一并关掉：
     *   · 编辑区：所有 tex 标签（与单个关标签一致，不做提示，也不替你保存）
     *   · 右栏：PDF 预览（含回退 blob 地址要回收）与编译日志
     *   · 挂在「某个文件」上的状态：提纲、右键菜单、SyncTeX 定位点与提示
     * 不动的：分栏宽度 / 换行 / 预览清晰度 / 编译方式这些全局设置。
     * 同一个项目里换文件不走这里（root 没变就不调）。
     */
    function closeProjectFiles() {
      var previous = state.pdfUrl
      if (previous && previous.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(previous) } catch (error) { /* 忽略 */ }
      }
      patch({
        tabs: [],
        activeId: null,
        busy: '',
        // 旧项目的文件树也一并放下：不然新 root都挂上了，抽屉里还是上一个项目的文件
        tree: null,
        files: [],
        total: 0,
        skipped: 0,
        truncated: false,
        pdfUrl: '',
        pdfRel: '',
        pdfRoot: '',
        pdfRev: '',
        pdfFor: '',
        pdfPages: 0,
        pdfPageSize: null,
        pdfFocusPage: 0,
        syncMark: null,
        syncBusy: '',
        syncNotice: '',
        log: null,
        outline: null,
        outlineOpen: false,
        outlineBusy: '',
        menu: null,
        compileMenu: false,
        notice: null
      })
      // 换项目了：旧项目的版本戳与提醒记录一并作废
      stamps = {}
      treeSignature = ''
      watchWarned = {}
      missingNoticed = {}
      if (autoCompileTimer) { clearTimeout(autoCompileTimer); autoCompileTimer = null }
      if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null }
    }

    /** 记一个文件当前的版本戳（读盘 / 保存 / 外部同步之后都盖一次）。
     *  只认 mtime：`read-file` 与 `tree` 的 size 口径万一不同（CRLF、编码、并发改），
     *  带 size 就会互相打架 → 每 2 秒重读一次，白折腾还可能打断阅读。 */
    function stampFile(rel, mtime) {
      if (rel) stamps[rel] = String(mtime || 0)
    }

    /** 「脏标签被外部改了」只提醒一次，别每 2 秒刷同一条。 */
    function warnDirty(tab, message) {
      var key = tab.id + '|' + (stamps[tab.rel] || '')
      if (watchWarned[key]) return
      watchWarned[key] = true
      patch({ notice: message, noticeOk: false })
    }

    /** 把磁盘上的新内容读进标签（只对没脏的标签动手）。 */
    function reloadTab(tab) {
      return api('read-file', { root: tab.root, path: tab.rel }).then(function (data) {
        if (state.root !== tab.root) return
        var live = findTabById(tab.id)
        if (!live || live.dirty) return   // 读回来这一瞬你开始打了，别盖
        stampFile(tab.rel, data.mtime, data.size)
        setTab(tab.id, { text: data.text, loading: false })
        patch({ notice: '已同步 ' + tab.rel + '（磁盘上有新版本）', noticeOk: true })
        scheduleAutoCompile()   // 「自编」开着：大模型改完就自动编一次
        if (state.outlineOpen && state.activeId === tab.id) loadOutline()
        // 标绿只是配菜：放在同步之后 + 自己兜住异常，绝不能反过来把同步拖垮
        try { queueFlash(tab.id, live.text, data.text) } catch (error) { /* 算不出改动行就算了 */ }
      }).catch(function () { /* 文件正被占用 / 读失败：下一轮再试 */ })
    }

    /**
     * 外部改动同步（核心）：磁盘一变，面板 2 秒内跟上。
     * 走 `tree` 而不是专门的 stat 端点 —— 文件树是面板一直在用的通道（一定能通），
     * 一次请求同时给出「每个文件的 mtime/size」和「目录里增删改了什么」，还省掉一个会静默死掉的依赖。
     *   · 打开着的 tex / bib …：版本戳变了就重新读进来；标签有未保存改动 → 只提醒不覆盖
     *   · 正在预览的 PDF：被（大模型）重新编译过就换图
     *   · 文件清单变了：文件树跟着换（新建 / 删除 / 重命名立刻可见）
     * 失败会亮红灯并在状态栏写原因，绝不再静默吞掉。
     */
    function syncExternalChanges() {
      var root = state.root
      if (!root) return Promise.resolve(false)
      if (enteringRoot) return Promise.resolve(false)   // 正在进项目，别拿旧快照去比新文件
      if (!state.tabs.length && !state.pdfRel && !state.tree) return Promise.resolve(false)
      // 上一轮还没回来：卡住超过 6 秒就放行（一次卡死的请求不该把轮询永久锁死）
      if (watchBusy && Date.now() - watchStartedAt < 6000) return Promise.resolve(false)
      watchBusy = true
      watchStartedAt = Date.now()
      var request
      try {
        request = api('tree', { root: root })
      } catch (failure) {
        watchBusy = false
        failSync(failure)
        return Promise.resolve(false)
      }
      return request.then(function (data) {
        watchBusy = false
        if (state.syncOk !== true) patch({ syncOk: true, syncError: '' })
        if (state.root !== root) return false          // 途中切了项目，这份结果作废
        try {
          return applySyncSnapshot(root, data)
        } catch (error) {
          try { console.error('[moling_latex] 同步处理出错', error) } catch (error2) { /* 忽略 */ }
          return false
        }
      }).catch(function (failure) {
        watchBusy = false
        failSync(failure)
        return false
      })
    }

    /** 同步失败要看得见（状态栏红灯 + 60 秒内一次红字），否则功能悄悄死掉没人知道。 */
    function failSync(failure) {
      var message = describe(failure)
      if (state.syncOk !== false || state.syncError !== message) patch({ syncOk: false, syncError: message })
      if (Date.now() - syncFailAt < 60000) return
      syncFailAt = Date.now()
      try { console.error('[moling_latex] 自动同步失败', failure) } catch (error) { /* 忽略 */ }
      patch({ notice: '自动同步失败：' + message, noticeOk: false })
    }

    /** 拿一份 tree 快照比对：开着的文件变没变、PDF 是否重编译过、文件清单是否增删。 */
    function applySyncSnapshot(root, data) {
      var files = (data && data.files) || []
      var byKey = {}
      var rels = []
      for (var i = 0; i < files.length; i++) {
        var rel = String(files[i].rel || '')
        if (!rel) continue
        var key = rel.toLowerCase()
        byKey[key] = files[i]
        rels.push(key)
      }
      var signature = rels.join('\n')
      var truncated = Boolean(data && data.truncated)
      var touched = 0
      // 读文件 / 换 PDF 图都是异步的：收进这里，让调用方能等它们落地（否则
      // 「同步完了」只是快照比完，编辑区还没换，自测和自编都会抢跑）。
      var pending = []

      // 1) 文件清单：增删 / 改名才换（只改内容不重画树，避免每 2 秒刷一次）
      if (state.tree && signature !== treeSignature) {
        if (treeSignature !== '') touched += 1
        treeSignature = signature
        patch({
          tree: (data && data.tree) || state.tree,
          files: files,
          total: (data && data.total) || files.length,
          skipped: (data && data.skipped) || 0,
          truncated: truncated
        })
      } else if (!treeSignature) {
        treeSignature = signature
      }

      // 2) 编辑区里开着的文件
      state.tabs.slice().forEach(function (tab) {
        var entry = byKey[String(tab.rel || '').toLowerCase()]
        if (!entry) {
          if (truncated) return
          // 只提示、**不关标签**：删文件是少见操作，误判一次就把用户（或自动打开的）
          // 主 tex 关掉，代价太大。想清掉就手动关。
          if (missingNoticed[tab.rel]) return
          missingNoticed[tab.rel] = true
          patch({ notice: tab.rel + ' 在磁盘上找不到了（标签保留，可手动关闭）', noticeOk: false })
          return
        }
        delete missingNoticed[tab.rel]   // 又出现了
        var stamp = String(entry.mtime)   // 只认 mtime：size 与 read-file 口径不同时不会互相打架
        var known = stamps[tab.rel]
        stamps[tab.rel] = stamp
        if (known === undefined) return              // 第一次见到：只记戳（内容刚读过）
        if (known === stamp) return                  // 没动过
        if (tab.dirty) {
          warnDirty(tab, tab.rel + ' 磁盘上已被修改，但这个标签有未保存的改动：先保存会覆盖外部版本')
          return
        }
        touched += 1
        pending.push(reloadTab(tab))
      })

      // 3) 正在预览的 PDF（大模型跑完 latex_compile 之后自动换新图）
      if (state.pdfRel) {
        var pdfEntry = byKey[String(state.pdfRel).toLowerCase()]
        if (pdfEntry) {
          var pdfStamp = String(pdfEntry.mtime)
          var knownPdf = stamps[state.pdfRel]
          stamps[state.pdfRel] = pdfStamp
          if (knownPdf !== undefined && knownPdf !== pdfStamp) {
            touched += 1
            pending.push(refreshPdf(root, state.pdfRel, pdfEntry.mtime))
          }
        }
      }
      // 等读写落地再报「这一轮同步完了」（reloadTab/refreshPdf 自己会吞失败，不会在这里炸）
      if (!pending.length) return Promise.resolve(touched > 0)
      return Promise.all(pending).then(function () { return touched > 0 }, function () { return touched > 0 })
    }

    /** 起轮询（boot 里调一次）：2 秒一轮。 */
    function startWatch() {
      if (watchTimer !== null || typeof setInterval !== 'function') return
      watchTimer = setInterval(function () { syncExternalChanges() }, 2000)
    }

    /* ------------------------------------------------------------------ *
     * 外部改动的「标绿 → 渐隐」提示：大模型改了哪几行，就在哪几行涂一层绿，
     * 停留几秒后自己退掉（background-color 带 transition，所以是渐隐不是硬切）。
     * 直接往 DOM 行元素上涂内联样式（CodeMirror 的 .cm-line / 回退高亮层的
     * [data-line]），**不动编辑器内核**——不用重建 cm6.js、刷新页面即生效。
     * ------------------------------------------------------------------ */

    var FLASH_GREEN = 'rgba(87, 180, 107, 0.34)'   // 半透明绿底，亮/暗主题都看得清
    var FLASH_HOLD_MS = 4000                        // 涂绿停留多久再隐去
    var flashState = { tabId: null, owner: null, ranges: [], until: 0, els: null, paint: null, timer: null }
    var pendingFlash = null   // {tabId, ranges}：reloadTab 置 → 编辑器同步 effect 消费
    /**
     * 外部同步时刚推进编辑器的那份文本。
     * 内核的 setDoc 是直接 dispatch，会照常走 onChange —— 不挡住的话，**第一次外部同步
     * 就把标签标成 dirty**，之后每次改动都被 reloadTab 的「有未保存改动」拦下，
     * 表现就是"同步突然不工作了"。撞上这份文本的 onChange 只更新文本、不标脏。
     */
    var suppressDirtyText = null
    /** 跳转（SyncTeX / 日志点行）之后的这 600ms 内不要 restoreViewport，
     *  否则外部同步刚好插一脚会把编辑器又拽回原来的滚动位置，看起来就是"跳转没生效"。 */
    var suppressRestoreUntil = 0

    /** 行号是否落在改动区间里（行号 1 起、闭区间）。 */
    function inRanges(lineNo, ranges) {
      for (var i = 0; i < ranges.length; i++) {
        if (lineNo >= ranges[i].from && lineNo <= ranges[i].to) return true
      }
      return false
    }

    /**
     * 比较两篇文本，算出「新文档里哪些行被改了」（1 起、闭区间，可多段）。
     * 做法：先掐掉公共前缀/后缀（大模型通常只动几行，掐完剩下很小一块），
     * 再对中间那块按行做多重集比对 —— 出现过的算没动，没出现过的就是改动行。
     * 这样「第 10 行和第 500 行各改一处」会得到两段，不会把中间 490 行全刷绿。
     */
    function diffLineRanges(oldText, newText) {
      if (oldText === newText) return []
      var a = String(oldText == null ? '' : oldText).split('\n')
      var b = String(newText == null ? '' : newText).split('\n')
      var head = 0
      var maxHead = Math.min(a.length, b.length)
      while (head < maxHead && a[head] === b[head]) head += 1
      var tail = 0
      while (tail < maxHead - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
      var aMid = a.slice(head, a.length - tail)
      var bMid = b.slice(head, b.length - tail)
      if (bMid.length === 0) {
        // 纯删除：新文档里没有对应行，标删除处紧跟的那一行（没有就标最后一行）
        var anchor = Math.min(head + 1, b.length)
        return anchor >= 1 ? [{ from: anchor, to: anchor }] : []
      }
      var left = new Map()
      for (var i = 0; i < aMid.length; i++) left.set(aMid[i], (left.get(aMid[i]) || 0) + 1)
      var ranges = []
      var start = -1
      var end = -1
      for (var k = 0; k < bMid.length; k++) {
        var count = left.get(bMid[k]) || 0
        var changed = count === 0
        if (count > 0) left.set(bMid[k], count - 1)
        var lineNo = head + k + 1
        if (changed) {
          if (start < 0) start = lineNo
          end = lineNo
        } else if (start >= 0) {
          ranges.push({ from: start, to: end })
          start = -1
        }
      }
      if (start >= 0) ranges.push({ from: start, to: end })
      // 兜底：中间块行数没变、只是顺序变了（多重集相同）→ 至少给一整块，别让调用方以为没动
      if (ranges.length === 0) ranges.push({ from: head + 1, to: Math.min(head + bMid.length, b.length) })
      return ranges
    }

    /** 外部同步进来时算好「改了哪几行」，交给编辑器的同步 effect 去涂。 */
    function queueFlash(tabId, oldText, newText) {
      var ranges = diffLineRanges(oldText, newText)
      pendingFlash = ranges.length ? { tabId: tabId, ranges: ranges } : null
    }

    /** 撤掉一个行元素的绿底（transition 让它渐隐，1 秒后再撤 transition）。 */
    function unflashNode(node) {
      try {
        node.style.backgroundColor = ''
        setTimeout(function () {
          try { node.style.transition = '' } catch (error) { /* 忽略 */ }
        }, 1000)
      } catch (error) { /* 元素已销毁，忽略 */ }
    }

    /** 把当前改动行涂到 container 里的行元素上（readLine 把元素翻译成行号）。 */
    function paintFlash(container, readLine) {
      if (!flashState.ranges.length || !container || !container.querySelectorAll) return
      if (Date.now() > flashState.until) { clearFlash(); return }
      var nodes
      try { nodes = container.querySelectorAll('.cm-line,[data-line]') } catch (error) { return }
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var lineNo = -1
        try { lineNo = readLine(node) } catch (error) { lineNo = -1 }
        var hit = lineNo > 0 && inRanges(lineNo, flashState.ranges)
        var on = flashState.els.has(node)
        if (hit && !on) {
          try {
            node.style.transition = 'background-color 900ms ease'
            node.style.backgroundColor = FLASH_GREEN
          } catch (error) { continue }
          flashState.els.add(node)
        } else if (!hit && on) {
          unflashNode(node)
          flashState.els.delete(node)
        }
      }
    }

    /** 开一轮标绿：涂 →停 FLASH_HOLD_MS → 渐隐。owner 用来判断该不该被清掉。 */
    function startFlash(tabId, ranges, owner, container, readLine) {
      clearFlash()
      if (!ranges || !ranges.length || !owner || !container) return
      flashState.tabId = tabId
      flashState.owner = owner
      flashState.ranges = ranges
      flashState.until = Date.now() + FLASH_HOLD_MS
      flashState.els = new Set()
      flashState.paint = function () { paintFlash(container, readLine) }
      flashState.paint()
      if (typeof setTimeout === 'function') flashState.timer = setTimeout(clearFlash, FLASH_HOLD_MS)
    }

    /** 收摊：撤掉所有绿底与定时器（幂等，随时可调）。 */
    function clearFlash() {
      if (flashState.timer) { clearTimeout(flashState.timer); flashState.timer = null }
      var els = flashState.els
      flashState.tabId = null
      flashState.owner = null
      flashState.ranges = []
      flashState.until = 0
      flashState.els = null
      flashState.paint = null
      if (!els) return
      els.forEach(function (node) { unflashNode(node) })
    }

    /** 行元素挪了位置 / 视口滚动出新行时补涂（窗口期内才有效）。 */
    function repaintFlash() {
      if (flashState.paint) flashState.paint()
    }

    /** 消费掉排队中的标绿（编辑器的文本同步 effect 里调）。 */
    function takeFlash(tabId) {
      if (!pendingFlash || pendingFlash.tabId !== tabId) return null
      var flash = pendingFlash
      pendingFlash = null
      return flash
    }

    /**
     * 记住当前视口：首行行号 + 行内像素偏移。
     * `setDoc` 是整篇替换，CM 会带着视口跑到别处（观感就是"页面滑走了"）——
     * 换文档前后各调一次 capture/restore，就能停在原来那几行上。
     */
    function captureViewport(view) {
      try {
        if (!view || !view.scrollDOM) return null
        var top = view.scrollDOM.scrollTop || 0
        var block = view.lineBlockAtHeight(top)
        return { line: view.state.doc.lineAt(block.from).number, delta: top - block.top }
      } catch (error) {
        return null
      }
    }

    /** 整篇替换之后把视口挪回原来那一行（内容变短就夹到最后一行）。 */
    function restoreViewport(view, keep) {
      if (!keep || !view) return
      try {
        var doc = view.state.doc
        var lineNo = Math.min(Math.max(keep.line, 1), doc.lines)
        var info = view.lineBlockAt(doc.line(lineNo).from)
        if (view.scrollDOM) view.scrollDOM.scrollTop = Math.max(0, info.top + keep.delta)
      } catch (error) { /* 拿不到布局就算了，宁可不动 */ }
    }

    /**
     * 把 `.cm-line` 元素翻译成行号（标绿用）。
     * 主路：元素中心点 → `posAtCoords` → 行号（最准，不依赖 DOM 顺序）。
     * 兜底：按 DOM 顺序推 —— 虚拟化下第 i 个 `.cm-line` 就是「视口首行 + i」。
     * （早先用 `view.posAtDOM` 当主路，在某些内核/布局状态下拿不到有效位置 → 一行都没涂上。）
     */
    function lineReaderFor(view) {
      var firstVisible = 0
      try { firstVisible = view.state.doc.lineAt(view.viewport.from).number } catch (error) { firstVisible = 0 }
      return function (node) {
        try {
          var rect = node.getBoundingClientRect()
          var pos = view.posAtCoords({ x: rect.left + 2, y: rect.top + rect.height / 2 })
          if (pos != null) return view.state.doc.lineAt(pos).number
        } catch (error) { /* 走兜底 */ }
        if (firstVisible > 0) {
          try {
            var nodes = view.contentDOM.querySelectorAll('.cm-line')
            for (var i = 0; i < nodes.length; i++) {
              if (nodes[i] === node) return firstVisible + i
            }
          } catch (error2) { /* 忽略 */ }
        }
        return -1
      }
    }

    /** 进工作台：选中某个根目录、拉文件树（抽屉不自动开，用户要时点「文件树」）。 */
    function enterRoot(root, options) {
      if (!root) return Promise.resolve()
      var settings = options || {}
      // 进项目期间暂停轮询：同步若拿旧快照比对，会把刚打开的主 tex 当成"外部删除"。
      enteringRoot = true
      // 换了项目文件夹（顶栏下拉 / 启动页最近 / 打开文件夹… 都走这里）：
      // 先把上一个项目打开的 tex 标签与 PDF/日志同步关掉，再挂新项目，
      // 免得新项目的树一加载完，编辑区还顶着旧项目、右栏还放着旧 PDF。
      if (normalizePath(root) !== normalizePath(state.root)) closeProjectFiles()
      // 抽屉默认不展开（用户 2026-11-14 要求：进项目别一上来就顶出文件树，要看再点「文件树」）
      patch({ root: root, view: 'workbench', treeOpen: settings.treeOpen === true, error: '' })
      var finish = function () { enteringRoot = false }
      // 同步抛错（数据通道起不来）也必须把闸门放下：否则 enteringRoot 永远 true，
      // 外部改动轮询从此静默失效（踩过：离线/通道异常时整块"自动同步不工作了"）。
      var chain
      try {
        chain = loadWorkspaces(root).then(function () { return loadTree(root) }).then(function () {
          // 自动打开主 tex：进了项目文件夹就把「你上次看的那个」顶到编辑区
          //（没有最近记录才退回 main.tex / 唯一 / 根目录唯一 / 体积最大）；
          // 明确带 autoOpen:false 的调用（打开某个具体文件 / 新建文档）除外。
          if (settings.autoOpen === false) return undefined
          if (state.root !== root) return undefined   // 途中又切了目录，别乱开
          var rel = pickMainTex(state.files, { root: root, recents: state.recents })
          if (!rel) {
            // 只有"一个 .tex 都没有"才会走到这里了（其余情况 pickMainTex 会给个最像主文件的）
            patch({ notice: '这个项目里没有 .tex，需要自己从「文件树」里选文件', noticeOk: true })
            return undefined
          }
          return openTab(root, rel).then(function () {
            // openTab 会顺手关抽屉；只有调用方明确要开（treeOpen:true）才开回来
            if (settings.treeOpen === true) patch({ treeOpen: true })
            // 打开失败（文件被占用等）openTab 会自己撤掉标签 → 补一次，别让自动打开"时灵时不灵"
            if (!findTab(root, rel)) return openTab(root, rel)
            return undefined
          })
        })
      } catch (failure) {
        finish()
        return Promise.reject(failure)
      }
      return chain.then(finish, function (failure) { finish(); throw failure })
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
          return enterRoot(data.root, { treeOpen: false, autoOpen: false }).then(function () {
            return openTab(data.root, data.file.rel)
          })
        })
        .catch(function (failure) { patch({ busy: '', error: describe(failure) }) })
    }

    /**
     * 在（最近的）工作区里新建一个 ctexart 骨架文档并打开。
     * @param {string} [targetRoot] 指定目录（模板库弹窗里选的存放位置）；
     *   注意这里直接当 onClick 用时第一个参数是事件对象，所以要判字符串。
     */
    function newDocument(targetRoot) {
      var root = typeof targetRoot === 'string' && targetRoot ? targetRoot : state.root
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
          return enterRoot(root, { treeOpen: false, autoOpen: false }).then(function () { return openTab(root, name) })
        })
      }).catch(function (failure) {
        patch({ busy: '', error: describe(failure) })
      })
    }

    /**
     * 模板筛选（纯函数）：分类精确匹配 + 搜索词在 名称/描述/分类/引擎 里模糊包含。
     * 和桌面版 filterTemplates / searchTemplates 的口径一致，但合并成一个函数 —— 启动页要两个条件同时生效。
     */
    function filterTemplates(list, query, category) {
      var needle = String(query || '').trim().toLowerCase()
      return (list || []).filter(function (item) {
        if (category && item.category !== category) return false
        if (!needle) return true
        var hay = (item.name + ' ' + item.description + ' ' + item.category + ' ' + item.engine).toLowerCase()
        return hay.indexOf(needle) > -1
      })
    }

    /**
     * 用模板新建项目：把模板（主 tex + cls/sty/图片）落地到 root，然后进工作台打开主文件。
     * 目标里已有 main.tex 时宿主会自动换到 `<root>/<模板id>[-n]/`，不覆盖已有项目。
     * @param {object} template 模板元数据（id/name/engine…）；`{ blank: true }` 表示空白 ctexart 骨架
     * @param {string} [targetRoot] 落地目录（弹窗里用户选的）；缺省回退到当前项目 / 最近目录
     */
    function newFromTemplate(template, targetRoot) {
      if (!template) return Promise.resolve()
      var blank = template.blank === true || !template.id
      var root = targetRoot || state.root
      if (!root) {
        var recentDir = (state.recents || []).filter(function (entry) { return entry.kind === 'dir' })[0]
        root = recentDir ? recentDir.value : ''
      }
      if (!root) {
        patch({ error: '先选一个存放位置（「选择文件夹…」），再把模板落地进去' })
        return Promise.resolve()
      }
      // 空白骨架复用 newDocument 那套（在本目录里建不重名的 untitled[-n].tex）
      if (blank) return newDocument(root)
      patch({ busy: 'template', templateBusy: template.id, error: '' })
      return api('use-template', { root: root, template: template.id }).then(function (data) {
        var target = data.root || root
        var main = data.main || 'main.tex'
        patch({
          busy: '',
          templateBusy: '',
          // 引擎跟着模板走（xelatex / pdflatex），省得用户手点一次
          engine: template.engine || state.engine,
          recents: pushRecent({
            kind: 'file', value: main, root: target, abs: absolutePath(target, main), title: template.name || main
          })
        })
        persist()
        return enterRoot(target, { treeOpen: false, autoOpen: false }).then(function () { return openTab(target, main) })
      }).catch(function (failure) {
        patch({ busy: '', templateBusy: '', error: describe(failure) })
      })
    }

    /** 打开/关闭模板库弹窗（启动页只留入口，模板不罗列在启动页）。 */
    function openTemplates() {
      patch({ templatesOpen: true, templateStep: 'list', templatePick: null, error: '' })
      if (!(state.templates || []).length) loadTemplates()
    }

    function closeTemplates() {
      patch({ templatesOpen: false, templateStep: 'list', templatePick: null, templateTarget: '' })
    }

    /** 弹窗第一步点一张卡 → 进第二步「新建文件」，让用户选存放位置。 */
    function pickTemplate(template) {
      if (state.templateBusy) return
      patch({ templateStep: 'target', templatePick: template, templateTarget: state.root || '' })
    }

    /** 第二步「选择文件夹…」：走 DSH 的原生目录选择器（同「打开文件夹」）。 */
    function pickTemplateTarget() {
      var ctx = state.ctx
      var uiWorkspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
      if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
        patch({ error: '当前组合没有目录选择服务（缺少 @deepseek-ai/dsh-host-directory-picker）' })
        return Promise.resolve()
      }
      return uiWorkspace.pickDirectory().then(function (picked) {
        if (!picked) return undefined
        // 先把目录登记进白名单（acceptRoot 只认已登记目录），再让用户点「创建」
        return api('open-root', { root: picked })
          .catch(function () { return null })
          .then(function () { patch({ templateTarget: picked, error: '' }) })
      }).catch(function (failure) {
        patch({ error: describe(failure) })
      })
    }

    /** 第二步「创建」：落地到用户选的目录，成功就关弹窗进工作台。 */
    function createFromTemplate() {
      var template = state.templatePick
      if (!template) return Promise.resolve()
      var target = String(state.templateTarget || '').trim()
      if (!target) {
        patch({ error: '先「选择文件夹…」挑一个存放位置' })
        return Promise.resolve()
      }
      patch({ error: '' })
      return Promise.resolve(newFromTemplate(template, target)).then(function () {
        if (!state.error) closeTemplates()
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

      // 恢复本地设置这段单独兜住：localStorage 里有脏数据也不该把面板搞成空白
      try {
        var saved = restored()
        if (saved) {
          patch({
            mode: saved.mode || state.mode,
            engine: saved.engine || state.engine,
            pane: saved.pane || state.pane,
            filter: saved.filter || '',
            expanded: saved.expanded || {},
            split: clamp(Number(saved.split) || state.split, 0.2, 0.8),
            // 只恢复用户手动拖过的像素宽；0 = 自适应（旧版存的是比例，忽略即可）
            treeW: Number.isFinite(Number(saved.treeW)) && Number(saved.treeW) > 0
              ? clamp(Number(saved.treeW), 150, 1200)
              : 0,
            wrap: saved.wrap !== false,
            autoCompile: saved.autoCompile === true,
            saveMode: saved.saveMode === 'auto' ? 'auto' : 'manual',
            pdfDpi: DPI_CHOICES.some(function (choice) { return choice.value === Number(saved.pdfDpi) })
              ? Number(saved.pdfDpi)
              : state.pdfDpi,
            pdfZoom: (function () {
              var zoom = Number(saved.pdfZoom)
              return Number.isFinite(zoom) ? clamp(zoom, 0.5, 3) : 1
            })(),
            recents: Array.isArray(saved.recents) ? saved.recents : []
          })
        }
      } catch (failure) {
        try { console.error('[moling_latex] 恢复本地设置失败', failure) } catch (error) { /* 忽略 */ }
      }
      patch({ view: 'welcome' })

      startWatch()   // 外部改动轮询：大模型改了 tex → 编辑区 2 秒内自动刷新
      loadStatus().catch(function (failure) { patch({ error: describe(failure), online: 'error' }) })
      loadWorkspaces().catch(function (failure) { patch({ error: describe(failure), online: 'error' }) })
      loadTemplates()
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
      idle: 'var(--dsw-alias-state-idle-primary, #8a8a8a)',
      /* 语法高亮调色板：**直接搬自桌面版墨灵TeX**（src/components/Editor.vue 的
         highlightStyle，One Dark 系）。用户明确要求「直接从墨灵tex.exe 搬运套用，
         别自己瞎编辑」，所以这里不再自编「命令蓝/环境金/键青绿/数学浅蓝」。
         为什么写死 hex：color-mix / 主题 token 混色在内联 style 里可能整条被丢弃
         （踩过，表现为"高亮没了"），编辑器深色底本来就该用固定配色。 */
      hlKeyword: '#c678dd',   // 命令、\begin{}/\end{}（含环境名）
      hlString: '#98c379',    // 数学区间
      hlNumber: '#d19a66',    // 数字
      hlProp: '#e06c75',      // 可选参数 [htbp]
      hlEscape: '#56b6c2',    // 转义 \\ \{ \%
      hlFunc: '#61afef'
    }
    /** 编译方式：下拉里用短标签（只有 1/4 宽度），title 里用全称。 */
    var COMPILE_MODES = [
      ['full', '完整编译', '完整'],
      ['quick', '快速编译', '快速'],
      ['clean', '从头编译', '从头']
    ]

    var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace'

    var S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: C.text, fontSize: 12.5 },
      bar: { display: 'flex', alignItems: 'center', gap: 5, padding: '6px 8px', borderBottom: '1px solid ' + C.line, flexShrink: 0 },
      spacer: { flex: 1 },
      btn: { border: '1px solid ' + C.line, background: 'transparent', color: C.text, borderRadius: 6, padding: '2px 8px', fontSize: 11.5, cursor: 'pointer', lineHeight: '18px', boxSizing: 'border-box', height: 24 },
      btnOn: { borderColor: C.accent, color: C.accent },
      // 主按钮不实心填色：主题 accent 在深色主题下可能是浅色，
      // 「浅底 + 白字」会看不清。改用中性底 + accent 边框 + 主题文字色。
      btnPrimary: { border: '1px solid ' + C.accent, background: C.layer2, color: C.text, borderRadius: 6, padding: '2px 10px', fontSize: 11.5, cursor: 'pointer', lineHeight: '18px', fontWeight: 500 },
      dimmed: { opacity: 0.45, cursor: 'default' },
      // 顶栏按钮组：同一底色圆角矩形里放一组按钮（文件树+文件大纲 / 换行+保存+新建）。
      // btnGroup 只管几何（高 24、圆角、内边距），颜色由下面两个变体给：
      // 每组颜色都分两层，全部走行内样式（不依赖 <style>/class，少一个不生效的环节）：
      //   1) backgroundColor：rgba 兜底 —— 任何引擎都认，保证"一定有颜色"；
      //   2) backgroundImage：同色线性渐变，用 color-mix 把主题 token 淡染上去
      //      —— 认识 color-mix 的浏览器才覆盖增强，不认识 / token 取不到就整条
      //      声明作废，留在第 1 层的底色上。
      // 顶栏统一高度：所有圆角矩形外高 24px，boxSizing:border-box + height:24；
      // 圆角统一 6px（btn/select/splitWrap/组/胶囊 都是 6，分体按钮内角 5 = 6 − 边框 1）。
      btnGroup: {
        display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2,
        borderRadius: 6, flexShrink: 0,
        boxSizing: 'border-box', height: 24
      },
      // 文件树｜文件大纲：蓝色（token = brand-primary）
      btnGroupBlue: {
        backgroundColor: 'rgba(77,139,248,0.15)',
        backgroundImage: 'linear-gradient(color-mix(in srgb, ' + C.accent + ' 22%, transparent), color-mix(in srgb, ' + C.accent + ' 22%, transparent))',
        border: '1px solid rgba(77,139,248,0.65)'
      },
      // 换行｜保存｜新建：橙黄色（token = state-warn-primary）
      btnGroupAmber: {
        backgroundColor: 'rgba(240,160,60,0.15)',
        backgroundImage: 'linear-gradient(color-mix(in srgb, ' + C.warn + ' 22%, transparent), color-mix(in srgb, ' + C.warn + ' 22%, transparent))',
        border: '1px solid rgba(240,160,60,0.65)'
      },
      // 组内按钮：外高 24 - 组内边距 4 - 组边框 2 = 18
      // outline:none —— 否则点过的开关按钮会一直留着浏览器的焦点框（看着像"开着"的白圆角框）；
      // 键盘可达性由 :focus-visible 的外描边另行兜（见 toggleBtnStyle 的说明）
      btnFlat: {
        border: '1px solid transparent', background: 'transparent', color: C.text,
        borderRadius: 6, padding: '0 8px', fontSize: 11.5, cursor: 'pointer', lineHeight: '16px',
        boxSizing: 'border-box', height: 18, outline: 'none', WebkitTapHighlightColor: 'transparent'
      },
      // 组内两个按钮之间的竖分隔线（文件树 | 文件大纲、换行 | 保存 | 新建）
      btnSep: { width: 1, height: 14, background: C.line, flexShrink: 0, opacity: 0.9 },
      // 编译分体按钮：左 3/4「编译」（点击即编译），右 1/4 小三角（点开选方式）。
      // 容器 position:relative 让下拉菜单贴在它下面，宽度跟按钮一致。
      splitWrap: {
        position: 'relative', display: 'inline-flex', alignItems: 'stretch',
        // 宽度贴着四字标签走：左 3/4 装「快速编译」等四字（nowrap 不许换行），
        // 右 1/4 放小三角。86px 时左区 ≈ 64px，四字 + 余量正好一行。
        width: 86, height: 24, border: '1px solid ' + C.accent, boxSizing: 'border-box',
        borderRadius: 6, overflow: 'visible', background: C.layer2
      },
      splitMain: {
        width: '75%', border: 0, borderRadius: '5px 0 0 5px', background: 'transparent',
        color: C.text, fontSize: 11.5, cursor: 'pointer', fontWeight: 500,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip'
      },
      splitCaret: {
        width: '25%', border: 0, borderLeft: '1px solid ' + C.line, borderRadius: '0 5px 5px 0',
        background: 'transparent', color: C.text, fontSize: 10, cursor: 'pointer', lineHeight: '18px',
        whiteSpace: 'nowrap'
      },
      splitCaretOn: { background: C.layer1 },
      // 「保存」分体按钮（在橙色按钮组里，所以比编译那个矮：外高 18）。
      // 整块自己带一圈边框：左「手动保存」+ 右「▾」共用一个框，三角不会看着飘在框外。
      saveSplitWrap: {
        position: 'relative', display: 'inline-flex', alignItems: 'stretch',
        height: 18, borderRadius: 6, border: '1px solid ' + C.line, boxSizing: 'border-box',
        overflow: 'visible'
      },
      saveCaret: {
        border: 0, borderLeft: '1px solid ' + C.line, background: 'transparent', color: C.text,
        fontSize: 10, cursor: 'pointer', padding: '0 4px', lineHeight: '15px', borderRadius: '0 5px 5px 0',
        whiteSpace: 'nowrap'
      },
      // 下拉与按钮**等宽**（left/right 都为 0，别再给 minWidth —— 否则会比按钮宽，边缘对不齐）
      saveMenu: {
        position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, padding: '3px 0',
        background: C.layer2, border: '1px solid ' + C.line, borderRadius: 8, zIndex: 50,
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)', fontSize: 11.5
      },
      // 下拉与按钮等宽、左右边对齐（left/right 都为 0）
      splitMenu: {
        position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 3, padding: '3px 0',
        background: C.layer2, border: '1px solid ' + C.line, borderRadius: 8, zIndex: 50,
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)', fontSize: 11.5
      },
      splitMenuItem: { padding: '5px 8px', cursor: 'pointer', color: C.text, whiteSpace: 'nowrap' },
      splitMenuItemOn: { color: C.accent },
      // 编辑器右键菜单
      // 编辑器右键菜单
      menu: {        position: 'fixed', zIndex: 60, minWidth: 200, padding: '4px 0',
        background: C.layer2, border: '1px solid ' + C.line, borderRadius: 8,
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)', fontSize: 12
      },
      menuItem: { padding: '5px 12px', cursor: 'pointer', color: C.text, whiteSpace: 'nowrap' },
      menuSep: { height: 1, margin: '4px 0', background: C.line },
      // 顶栏的「连接状态」小胶囊（外高同样 24px、圆角同样 6px，与其它圆角矩形对齐）
      linkPill: {
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px',
        borderRadius: 6, border: '1px solid ' + C.line, background: C.layer1,
        fontSize: 10.5, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
        boxSizing: 'border-box'
      },
      linkDot: { width: 6, height: 6, borderRadius: '50%', flex: 'none' },
      // 「提纲」浮层：贴编辑区左下角
      outlinePanel: {
        position: 'absolute', left: 8, bottom: 8, width: 260, maxWidth: '72%', maxHeight: '48%',
        display: 'flex', flexDirection: 'column', zIndex: 20,
        background: C.layer2, border: '1px solid ' + C.line, borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)', overflow: 'hidden'
      },
      outlineHead: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
        borderBottom: '1px solid ' + C.line, fontSize: 11.5, flexShrink: 0
      },
      outlineList: { overflow: 'auto', padding: '4px 0 6px', minHeight: 0, fontSize: 11.5 },
      outlineItem: {
        display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 8px',
        cursor: 'pointer', color: C.text
      },
      outlineTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      outlineNum: { flex: 'none', color: C.sub, fontFamily: MONO, fontSize: 10 },
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
      // 左右两条顶栏（左侧文件标签条 / 右侧 pdf·日志工具栏）外高统一 28px：
      // 之前 tabsBar 算出来 27px、rightHead 因内容 24px 按钮 + 上下 padding 算出来 31px，差 4px。
      tabsBar: {
        display: 'flex', alignItems: 'flex-end', gap: 1, borderBottom: '1px solid ' + C.line,
        overflowX: 'auto', padding: '2px 4px 0', flexShrink: 0,
        boxSizing: 'border-box', height: 28
      },
      tab: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', fontSize: 11.5, cursor: 'pointer', borderTop: '2px solid transparent', color: C.sub, whiteSpace: 'nowrap' },
      tabOn: { color: C.text, borderTop: '2px solid ' + C.accent, background: C.layer1 },
      tabClose: { opacity: 0.55, fontSize: 12, lineHeight: '12px' },
      editorWrap: { flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' },
      // 高亮层：与 textarea 同字体同字号同行高同换行，滚动由 textarea 驱动。
      // paddingRight 会在渲染时加上「textarea 滚动条宽度」——否则两层内容宽度差一个滚动条，
      // 换行点不一致 → 看到的字形与光标实际字符错位（删错字的元凶）。
      hlWrap: {
        position: 'absolute', inset: 0, margin: 0, overflow: 'hidden', pointerEvents: 'none',
        padding: '6px 8px 6px 0', fontFamily: MONO, fontSize: 12, lineHeight: LINE_H + 'px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word',
        fontVariantLigatures: 'none', color: C.text, tabSize: 2,
        // 内容再多也不影响外面的布局/绘制，滚动与打字时省一大截重排
        contain: 'strict'
      },
      textareaOverlay: {
        position: 'absolute', inset: 0, width: '100%', height: '100%', boxSizing: 'border-box',
        resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: 'transparent',
        caretColor: C.text, fontFamily: MONO, fontSize: 12, lineHeight: LINE_H + 'px',
        padding: '6px 8px 6px ' + GUTTER + 'px', tabSize: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        overflowWrap: 'break-word', fontVariantLigatures: 'none', overflow: 'auto',
        // 永远预留滚动条槽：内容多寡都不改内容宽度，高亮层才能用固定补偿对齐（错位的根治）
        scrollbarGutter: 'stable'
      },
      rightHead: {
        display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px',
        borderBottom: '1px solid ' + C.line, flexShrink: 0,
        boxSizing: 'border-box', height: 28
      },
      paneTab: { padding: '1px 7px', fontSize: 11.5, cursor: 'pointer', borderRadius: 6, color: C.sub },
      paneTabOn: { color: C.text, background: C.layer1 },
      pane: { flex: 1, overflow: 'auto', padding: '6px 8px', minHeight: 0 },
      // 降分辨率预览：一页一张 <img>，滚动容器自己滚（不是 PDF 阅读器）
      pdfScroll: { flex: 1, overflow: 'auto', padding: '8px 10px', minHeight: 0, background: C.layer1, contain: 'paint' },
      // aspect-ratio 只在图片加载前占位（加载后按图片固有比例走，横页也不会被压扁）
      pdfPage: {
        display: 'block', width: '100%', height: 'auto', margin: '0',
        background: '#fff', borderRadius: 2, aspectRatio: '1 / 1.414',
        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.22)', cursor: 'crosshair'
      },
      // 单页容器：缩放改它的宽度，定位环按百分比绝对定位在它上面。
      // 注意不能加 maxWidth:'100%' —— 它会把 width:(100*zoom)% 卡死在窗口宽，
      // 于是 100% 之后再怎么放大都只是百分比在涨、页面纹丝不动（已踩过）。
      pdfPageBox: { position: 'relative', margin: '0 auto 10px' },
      // SyncTeX 定位环
      syncRing: {
        position: 'absolute', width: 16, height: 16, marginLeft: -8, marginTop: -8,
        border: '2px solid var(--dsw-alias-state-warn-primary, #d99a2b)', borderRadius: '50%',
        boxShadow: '0 0 0 3px rgba(217, 154, 43, 0.25)', pointerEvents: 'none'
      },
      pre: { margin: 0, fontFamily: MONO, fontSize: 11, lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.sub },
      issue: { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', color: C.err, cursor: 'pointer', font: 'inherit', fontFamily: MONO, fontSize: 11, padding: '1px 0' },
      warnIssue: { color: C.warn },
      hint: { color: C.sub, fontSize: 11.5 },
      // 内核未加载时的提示条（回退编辑器上方）
      kernelNotice: {
        flexShrink: 0, padding: '4px 9px', fontSize: 11, color: C.warn,
        borderBottom: '1px solid ' + C.line, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      },
      // 兜底页：面板内部异常时显示（见 PaneBoundary）
      crash: { flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px', fontSize: 12.5, color: C.text },
      crashText: { fontFamily: MONO, fontSize: 11.5, lineHeight: '17px', color: C.err, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      // 启动页
      welcome: { flex: 1, overflow: 'auto', padding: '14px 16px 24px', minHeight: 0 },
      welcomeTitle: { fontSize: 15, fontWeight: 600, marginBottom: 2 },
      welcomeSub: { color: C.sub, fontSize: 11.5, marginBottom: 14, lineHeight: '17px' },
      welcomeActions: { display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' },      section: { marginBottom: 16 },
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
      status: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 8px', fontSize: 10.5, color: C.sub, borderTop: '1px solid ' + C.line, whiteSpace: 'nowrap', overflow: 'hidden', flexShrink: 0, position: 'relative' },
      // 状态栏里居中的结果条：绝对定位，不参与 flex 排布（左右两侧的东西照旧靠边）
      statusNotice: {
        position: 'absolute', left: '50%', top: 0, bottom: 0, transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', maxWidth: '58%', overflow: 'hidden',
        textOverflow: 'ellipsis', pointerEvents: 'none', fontWeight: 500
      },
      dot: { width: 7, height: 7, borderRadius: 999, display: 'inline-block', flexShrink: 0 },
      // 文件树：浮在编辑区上的卡片 —— 与「提纲」浮层同一套样式（圆角/描边/阴影/表头/行距）
      // 尺寸自适应：高度由行数决定（treeAutoSize），宽度由最长文件名决定；
      // 只有拖动右边框后 store.treeW 才有值，双击边框回到自适应。
      overlay: { position: 'absolute', inset: 0, display: 'flex', zIndex: 30 },
      drawer: {
        position: 'absolute', left: 8, top: 8, minWidth: 150,
        background: C.layer2, border: '1px solid ' + C.line, borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)', overflow: 'hidden',
        display: 'flex', flexDirection: 'column'
      },
      hsplit: {
        position: 'absolute', top: 0, bottom: 0, right: -3, width: 6,
        cursor: 'col-resize', zIndex: 4, background: 'transparent'
      },
      drawerHead: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
        borderBottom: '1px solid ' + C.line, fontSize: 11.5, flexShrink: 0
      },
      drawerList: { flex: 1, overflow: 'auto', padding: '4px 0 6px', minHeight: 0, fontSize: 11.5 },
      backdrop: { flex: 1, background: 'rgba(0,0,0,0.18)' },
      row: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
        cursor: 'pointer', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', color: C.text
      },
      rowOn: { background: C.layer1, color: C.accent }
    }

    /* ------------------------------------------------------------------ *
     * LaTeX 语法高亮
     * 带状态的 LaTeX 词法：命令、环境名、引用/标签键、数学（$…$ 与数学环境）、
     * 注释、括号、数字；章节命令整行加粗。纯函数、无依赖；超长文件退化为纯文本。
     * ------------------------------------------------------------------ */

    /* 面板侧分词配色：**与桌面版墨灵TeX 的 highlightStyle 对齐**（见 C.hl* 注释）。
       命令紫、环境名（`\begin{}` 里的名字）紫、引用键青绿、数学绿、数字橙、
       注释灰斜体、括号灰、可选参数红。 */
    var TOKEN = {
      command: { color: C.hlKeyword, fontWeight: 500 },  // \section \item …（紫）
      env: { color: C.hlKeyword },                        // \begin{equation} 里的 environment 名（紫）
      key: { color: C.hlEscape },                         // \cite{} / \ref{} / \label{} 的键（青）
      math: { color: C.hlString },                        // 数学区间（绿）
      number: { color: C.hlNumber },                      // 数字（橙）
      prop: { color: C.hlProp },                          // 可选参数 [htbp]（红）
      comment: { color: C.sub, fontStyle: 'italic' },     // 注释（灰、斜体）
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
            // 可选参数 [..] 按桌面版的 propertyName 上色（红）
            if (line.charAt(index) === '[') {
              var bracketEnd = line.indexOf(']', index)
              if (bracketEnd > index) {
                push(line.slice(index, bracketEnd + 1), TOKEN.prop)
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
        var children = [h('span', { key: 'ln', className: 'ml-hl-num' }, i + 1)]
        for (var j = 0; j < segments.length; j++) {
          children.push(h('span', { key: j, style: segments[j].style }, segments[j].text))
        }
        record[i] = {
          text: row,
          stateKey: stateKey,
          stateOut: { math: state.math ? Object.assign({}, state.math) : null },
          element: h('div', {
            key: i,
            className: bold ? 'ml-hl-line ml-hl-bold' : 'ml-hl-line',
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

    /**
     * PDF 预览区。
     * 首选「一页一张降分辨率 PNG」：宿主 poppler 按所选 dpi 栅格化，客户端只是 <img>
     * 等比缩放，不解析 PDF、不整页重绘，滚动也只解码可见的那几页（loading=lazy）。
     * 回退：poppler 不可用或取图失败 → 整份 PDF 的 blob 交给浏览器内置阅读器。
     *
     * 交互：
     *   · Ctrl + 滚轮 = 缩放（0.5×–3×），普通滚轮照常滚动；
     *   · 单击某页 = 反向定位（PDF 坐标 → 源码行，走 SyncTeX）；
     *   · store.syncMark 画出定位环（正向定位：源码行 → PDF），store.pdfFocusPage 滚到该页。
     */
    function PdfPane(props) {
      var store = props.store
      var scrollRef = React.useRef(null)
      var pageRefs = React.useRef({})
      // 以鼠标为锚点缩放：wheel 时记下指针位置与当时的滚动量，渲染完再补滚动量，
      // 让指针指着的那个点在放大前后停在同一个屏幕位置（否则缩放总锚在页面顶部）。
      var zoomAnchorRef = React.useRef(null)

      // 正向定位后滚到目标页
      React.useEffect(function () {
        var page = store.pdfFocusPage
        if (!page) return
        var element = pageRefs.current[page]
        if (element && typeof element.scrollIntoView === 'function') {
          element.scrollIntoView({ block: 'start' })
        }
        patch({ pdfFocusPage: 0 })
      }, [store.pdfFocusPage, store.pdfPages])

      /**
       * Ctrl + 滚轮缩放。
       * 必须用原生 addEventListener 并显式 `passive:false`：React 的 onWheel 是 passive 监听，
       * preventDefault() 不生效 → 浏览器会自己去缩放页面，PDF 反而不动。
       *
       * 注意：本组件下面有三处提前 return（没 PDF / 非栅格 / 还没生成页），
       * 所有 hook 必须放在这些 return **之前** —— 否则「没 PDF → 有 PDF」时
       * hook 数量从 3 变 4，React 直接抛 #310（Rendered more hooks…）整块崩掉。
       */
      React.useEffect(function () {
        var element = scrollRef.current
        if (!element) return undefined
        var onWheel = function (event) {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          var current = state.pdfZoom || 1
          var next = clamp(current * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 0.5, 3)
          next = Math.round(next * 100) / 100
          if (next !== current) {
            // 记锚点：指针在视口里的位置 + 此刻滚动量 + 缩放比（内容宽度按 zoom 线性缩放）
            var rect = element.getBoundingClientRect()
            zoomAnchorRef.current = {
              ratio: next / current,
              px: event.clientX - rect.left,
              py: event.clientY - rect.top,
              sl: element.scrollLeft,
              st: element.scrollTop
            }
          }
          patch({ pdfZoom: next })
          persist()
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return function () { element.removeEventListener('wheel', onWheel) }
      }, [store.pdfRel, store.pdfPages, store.pdfRaster])

      // 缩放渲染完后按锚点补滚动量（useEffect 在提交后跑，此时页面宽度已是新值）
      React.useEffect(function () {
        var anchor = zoomAnchorRef.current
        if (!anchor) return
        zoomAnchorRef.current = null
        var element = scrollRef.current
        if (!element) return
        var ratio = anchor.ratio
        if (!ratio || ratio === 1) return
        var left = (anchor.sl + anchor.px) * ratio - anchor.px
        var top = (anchor.st + anchor.py) * ratio - anchor.py
        // 没溢出的方向（scrollWidth == clientWidth）滚动量恒为 0，别写成负数
        element.scrollLeft = element.scrollWidth > element.clientWidth ? Math.max(0, left) : 0
        element.scrollTop = element.scrollHeight > element.clientHeight ? Math.max(0, top) : 0
      }, [store.pdfZoom])

      if (!store.pdfRel) return h('div', { style: Object.assign({}, S.hint, { padding: 8 }) }, '编译成功后在这里预览 PDF。')

      if (!store.pdfRaster) {
        return store.pdfUrl
          ? h('iframe', {
              src: store.pdfUrl,
              title: 'PDF 预览',
              style: {
                width: '100%', height: '100%', border: 'none', background: '#fff',
                pointerEvents: store.dragging ? 'none' : 'auto'
              }
            })
          : h('div', { style: Object.assign({}, S.hint, { padding: 8 }) }, '正在用浏览器内置阅读器打开 PDF…')
      }

      if (!store.pdfPages) return h('div', { style: Object.assign({}, S.hint, { padding: 8 }) }, '正在生成本地预览…')

      var zoom = store.pdfZoom || 1
      var mark = store.syncMark

      /** 点在页面上的位置 → PDF 点（1/72 英寸），交给 SyncTeX 反查源码行。 */
      var onPageClick = function (page, event) {
        var image = event.currentTarget
        var rect = image.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        var naturalWidth = image.naturalWidth || rect.width
        var naturalHeight = image.naturalHeight || rect.height
        var xPx = (event.clientX - rect.left) / rect.width * naturalWidth
        var yPx = (event.clientY - rect.top) / rect.height * naturalHeight
        var scale = 72 / (store.pdfDpi || 96)
        if (props.onPick) props.onPick(page, xPx * scale, yPx * scale)
      }

      var pages = []
      for (var page = 1; page <= store.pdfPages; page++) {
        var pageMark = mark && mark.page === page ? mark : null
        // 单页容器：缩放改它的宽度，定位环按百分比绝对定位在它上面。
        // ref 必须用 IIFE 捕获当前页码 —— 用闭包里的 var page 会让所有回调都写到最后一页，
        // 于是「源码 → PDF」滚不到目标页（这就是先前 tex→pdf 不跳的元凶）。
        pages.push(h('div', {
          key: page,
          style: Object.assign({}, S.pdfPageBox, { width: (100 * zoom).toFixed(2) + '%' }),
          ref: function (index) {
            return function (node) {
              if (node) pageRefs.current[index] = node
              else delete pageRefs.current[index]
            }
          }(page)
        },
          h('img', {
            src: pdfPageUrl(page),
            alt: '第 ' + page + ' 页',
            title: '第 ' + page + ' / ' + store.pdfPages + ' 页 · 点击可定位到源码',
            loading: page === 1 ? 'eager' : 'lazy',
            decoding: 'async',
            draggable: false,
            style: S.pdfPage,
            onClick: function (index) {
              return function (event) { onPageClick(index, event) }
            }(page),
            onError: onPdfPageError
          }),
          pageMark
            ? h('div', {
                style: Object.assign({}, S.syncRing, {
                  left: syncPercent(pageMark.x, store.pdfPageSize && store.pdfPageSize.width),
                  top: syncPercent(pageMark.y, store.pdfPageSize && store.pdfPageSize.height)
                })
              })
            : null))
      }

      return h('div', {
        style: S.pdfScroll,
        className: 'ml-pdf-scroll',
        ref: scrollRef,
        title: 'Ctrl + 滚轮缩放；单击页面可定位到源码'
      }, pages, h('div', { style: { textAlign: 'right', fontSize: 10.5, color: C.sub, padding: '2px 2px 8px' } },
        Math.round(zoom * 100) + '%'))
    }

    /**
     * 编辑器右键菜单项。action 交给编辑器桥（editorBridge.run），'locate' 由面板自己处理。
     * 面板把浏览器原生右键菜单接管了，所以撤销/剪切/复制/粘贴/全选要自己补回来。
     */
    var CONTEXT_ITEMS = [
      { key: 'undo', label: '撤销', hint: 'Ctrl+Z', action: 'undo' },
      { key: 'redo', label: '重做', hint: 'Ctrl+Y', action: 'redo' },
      { key: 'sep1', separator: true },
      { key: 'cut', label: '剪切', hint: 'Ctrl+X', action: 'cut' },
      { key: 'copy', label: '复制', hint: 'Ctrl+C', action: 'copy' },
      { key: 'paste', label: '粘贴', hint: 'Ctrl+V', action: 'paste' },
      { key: 'selectAll', label: '全选', hint: 'Ctrl+A', action: 'selectAll' },
      { key: 'sep2', separator: true },
      // 只发一行 `@文件:行范围`：模型自己会去 read，不糊一大段源码。
      // （以前还带「引用 + 全文」那个形态，用户确认不要了 —— 输入框里一大片代码太丑。）
      { key: 'send', label: '发送选中内容到对话框', action: 'send' },
      { key: 'sep3', separator: true },
      { key: 'locate', label: '定位到 PDF 位置', action: 'locate' }
    ]

    /** 编译方式的显示名（完整编译 / 快速编译 / 从头编译）。 */    function compileModeLabel(mode) {
      for (var i = 0; i < COMPILE_MODES.length; i++) {
        if (COMPILE_MODES[i][0] === mode) return COMPILE_MODES[i][1]
      }
      return mode
    }

    /** 右键菜单定位：别让菜单跑出窗口。 */
    function menuPosition(menu) {
      var width = 220
      var height = 44
      // innerWidth 在 SSR/测试环境里是 undefined → 直接做减法会变 NaN，样式就废了
      var maxX = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth - width - 8 : 800
      var maxY = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight - height - 8 : 600
      var x = Number.isFinite(Number(menu.x)) ? Number(menu.x) : 4
      var y = Number.isFinite(Number(menu.y)) ? Number(menu.y) : 4
      return {
        left: Math.max(4, Math.min(x, maxX)),
        top: Math.max(4, Math.min(y, maxY))
      }
    }

    /**
     * PDF 点坐标 → 页面里的百分比。
     * 页面图按 dpi 栅格化，但我们只需要「点在整页里的相对位置」，
     * 所以用 PDF 点 / 页面点尺寸即可（不需要图片像素宽）。拿不到尺寸就退回 A4 宽高。
     */
    function syncPercent(value, totalPt) {
      var total = Number(totalPt)
      if (!Number.isFinite(total) || total <= 0) total = 595.276
      if (value == null || !Number.isFinite(Number(value))) return '50%'
      return Math.min(100, Math.max(0, Number(value) / total * 100)).toFixed(3) + '%'
    }

    /**
     * 「一键适应窗口」的比例：整页（宽 + 高）都放进可视区。
     * 页容器宽度是相对值（100% 就是贴满面板宽，任何窗口宽度下都成立），
     * 所以适应只会往下缩 —— 高度放不下时按高度算，放得下就是 1。
     * 结果夹在 0.5–3，与 Ctrl+滚轮 / －＋ 按钮同一档范围。
     */
    function fitZoomFor(contentW, contentH, pageSize) {
      if (!(contentW > 0) || !(contentH > 0)) return 1
      var size = pageSize || {}
      var width = Number(size.width) > 0 ? Number(size.width) : 595.276
      var height = Number(size.height) > 0 ? Number(size.height) : 841.89
      var fit = Math.min(1, contentH / (contentW * (height / width)))
      return Math.round(clamp(fit, 0.5, 3) * 100) / 100
    }


    /** 定位失败时的说明：宿主半侧没重启（缺 synctex 端点）是最常见的一种。 */
    function syncFailureText(failure) {
      var message = describe(failure)
      if (/未知端点|404/i.test(message)) {
        return '宿主半侧还没有 synctex 端点：关闭 DSH 重新打开一次即可（不是刷新页面）'
      }
      return '定位失败：' + message
    }

    /* ------------------------------------------------------------------ *
     * 编辑器样式（用 class 而不是每行内联 style）
     * 1400 行的文件若每行都写内联 style，就是 2800+ 个 style 属性要解析与重算；
     * 换成固定 class 后打字/滚动时浏览器的样式重算明显便宜。
     * ------------------------------------------------------------------ */

    var EDITOR_CSS = [
      '.ml-hl-line{padding-left:' + GUTTER + 'px;text-indent:-48px}',
      '.ml-hl-bold{font-weight:600}',
      '.ml-hl-num{display:inline-block;width:48px;box-sizing:border-box;padding-right:8px;' +
        'text-align:right;text-indent:0;color:var(--dsw-alias-label-secondary,#9aa0a6);user-select:none}',
      '.ml-editor textarea::selection{background:rgba(120,170,255,.35)}'
    ].join('')

    /* ------------------------------------------------------------------ *
     * 启动页（参照墨灵 TeX 桌面版欢迎页）：
     *   大标题 + 副标题 / 「启动」动作行（右对齐快捷键）/ 「最近」行
     *   （类型标签 + 名称 + 右对齐路径）/ 模板式卡片 / 右栏提示
     * ------------------------------------------------------------------ */

    /* 墨灵 logo（与桌面版 src/assets/logo.svg 同一图形）：浏览器侧是经典脚本，
       不能 import 图片，所以这里用内联 SVG 元素重画一份（深浅主题通用：logo 自带深底）。 */
    function BrandMark() {
      return h('svg', {
        className: 'ml-brand-mark',
        viewBox: '0 0 512 512',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false'
      },
        h('defs', null,
          h('linearGradient', { id: 'ml-brand-grad', x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#38bdf8' }),
            h('stop', { offset: '100%', stopColor: '#818cf8' }))),
        h('rect', { width: 512, height: 512, rx: 112, fill: '#0f172a' }),
        h('rect', { x: 36, y: 36, width: 440, height: 440, rx: 88, fill: 'none', stroke: 'url(#ml-brand-grad)', strokeWidth: 10, opacity: 0.85 }),
        h('path', { d: 'M120 360 V152 L256 292 L392 152 V360', fill: 'none', stroke: '#f1f5f9', strokeWidth: 42, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('rect', { x: 120, y: 388, width: 272, height: 22, rx: 11, fill: 'url(#ml-brand-grad)' })
      )
    }

    var WELCOME_CSS = [
      '.ml-wrap{display:flex;flex-wrap:wrap;gap:22px 30px;align-items:flex-start}',
      '.ml-main{flex:1 1 340px;min-width:0}',
      '.ml-side{flex:0 1 240px;min-width:0}',
      // 标题区：logo（内联 SVG）+ 大标题 / 副标题
      '.ml-brand{display:flex;align-items:center;gap:12px;margin:2px 0 26px}',
      '.ml-brand-mark{flex:none;width:44px;height:44px;border-radius:11px;display:block}',
      '.ml-brand-text{min-width:0}',
      '.ml-brand-text .ml-h1{margin:0 0 4px}',
      '.ml-brand-text .ml-sub{margin-bottom:0}',
      '.ml-h1{font-size:25px;font-weight:600;letter-spacing:-.2px;margin:2px 0 4px}',
      '.ml-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin-bottom:26px}',
      '.ml-sec{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.6px;margin:20px 0 6px}',
      // 「最近」里的分组小标题：工作区 / 文件各一组
      '.ml-subsec{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.4px;margin:8px 0 1px;padding-left:9px;opacity:.9}',
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

    /* 模板库弹窗的样式（挂在 Body 层，与启动页不同挂载点 → 单独一份，别塞进 WELCOME_CSS）。 */
    var TEMPLATE_CSS = [
      // 弹窗外壳：居中卡片
      '.ml-modal-mask{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38)}',
      // 固定高度（不随模板数量/步骤变），列表内容在内部滚动 —— 用户要求「窗口固定住」
      '.ml-modal{width:min(760px,94%);height:min(620px,88%);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,#2a2a2a);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.5);overflow:hidden;color:var(--dsw-alias-label-primary)}',
      '.ml-modal-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.ml-modal-title{flex:1;font-size:13px;font-weight:600}',
      '.ml-modal-x{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;width:22px;height:22px;line-height:18px;font-size:15px;cursor:pointer;outline:none}',
      '.ml-modal-x:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}',
      '.ml-modal-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:10px 12px}',
      // 第二步内容短，恢复整体滚动、内容从顶部排（别在 620px 高的壳里垂直居中，看着空）
      '.ml-modal-body-target{overflow:auto;display:block}',
      '.ml-modal-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ml-modal-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 10px;font-size:11.5px;line-height:16px;cursor:pointer;outline:none;box-sizing:border-box}',
      '.ml-modal-btn:hover{border-color:var(--dsw-alias-border-l2)}',
      '.ml-modal-btn-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.ml-modal-btn:disabled{opacity:.45;cursor:default}',
      // 左导航 + 右内容
      '.ml-tpl-layout{display:flex;gap:12px;align-items:stretch;flex:1;min-height:0}',
      '.ml-tpl-nav{flex:none;width:98px;display:flex;flex-direction:column;gap:2px;overflow:auto}',
      '.ml-tpl-navitem{display:flex;align-items:center;gap:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:5px 8px;font-size:11.5px;text-align:left;cursor:pointer;outline:none;white-space:nowrap;overflow:hidden}',
      '.ml-tpl-navitem:hover{color:var(--dsw-alias-label-primary)}',
      '.ml-tpl-nav-on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-brand-primary)}',
      '.ml-tpl-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}',
      // 搜索框 + 分类胶囊 + 卡片网格
      '.ml-tpl-bar{display:flex;gap:6px;align-items:center;margin:0 0 7px;flex:none}',
      '.ml-tpl-search{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;font-size:12px;outline:none;box-sizing:border-box}',
      '.ml-tpl-search:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ml-tpl-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      // grid-auto-rows:max-content 必须写：默认 auto 行在「网格自身有高度约束」时会把行压到
      // 均分容器高（63px），卡片里的 flex 子项跟着被压 → 模板名只剩 8px 被裁掉半截。
      '.ml-tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));grid-auto-rows:max-content;gap:8px;flex:1;min-height:0;overflow:auto;align-content:start;padding-right:2px}',
      '.ml-tpl-card>*{flex:none}',
      '.ml-tpl-footcard{flex:none;margin-top:10px}',
      '.ml-tpl-card{display:flex;flex-direction:column;gap:3px;padding:9px 10px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;cursor:pointer;position:relative;overflow:hidden;min-width:0;background:var(--dsw-alias-bg-layer-1)}',
      '.ml-tpl-card:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
      '.ml-tpl-card[data-busy="1"]{opacity:.55;cursor:progress}',
      '.ml-tpl-card[data-on="1"]{border-color:var(--dsw-alias-brand-primary)}',
      '.ml-tpl-accent{position:absolute;left:0;top:0;bottom:0;width:3px;background:currentColor;opacity:.85}',
      '.ml-tpl-name{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:5px;line-height:18px;flex:none}',
      '.ml-tpl-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);padding-left:5px}',
      '.ml-tpl-desc{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary);padding-left:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.ml-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 9px;line-height:18px}',
      // 第二步「新建文件」：模板摘要 + 存放位置
      '.ml-tpl-pick{display:flex;gap:12px;align-items:flex-start}',
      '.ml-tpl-preview{flex:none;width:120px;height:150px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);position:relative;overflow:hidden}',
      '.ml-tpl-preview-bar{position:absolute;left:12px;right:12px;top:16px;height:6px;border-radius:3px;background:currentColor;opacity:.85}',
      '.ml-tpl-preview-line{position:absolute;left:12px;right:12px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l1)}',
      '.ml-tpl-fields{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}',
      '.ml-tpl-field{display:flex;flex-direction:column;gap:4px}',
      '.ml-tpl-field-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ml-tpl-pathrow{display:flex;gap:6px;align-items:center}',
      '.ml-tpl-path{flex:1;min-width:0;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;background:var(--dsw-alias-bg-layer-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ml-tpl-path-empty{color:var(--dsw-alias-label-secondary);font-family:inherit}',
      '.ml-tpl-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}'
    ].join('')

    /* ------------------------------------------------------------------ *
     * 模板库弹窗（二级窗口）：启动页只留入口，模板清单在这里挑。
     *   第一步 'list'：左分类导航 + 搜索 + 卡片网格
     *   第二步 'target'：新建文件 —— 显示模板摘要 + 选存放目录 + 创建
     * ------------------------------------------------------------------ */

    function TemplateDialog(props) {
      var store = props.store

      // Esc 关闭：第二步先退回列表，第一步才真关。
      // hook 必须写在所有提前 return 之前（AGENTS.md 坑 12），所以先挂 effect 再判开合。
      React.useEffect(function () {
        if (!state.templatesOpen) return undefined
        var onKey = function (event) {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (state.templateStep === 'target') patch({ templateStep: 'list', templatePick: null })
          else closeTemplates()
        }
        document.addEventListener('keydown', onKey, true)
        return function () { document.removeEventListener('keydown', onKey, true) }
      }, [store.templatesOpen])

      if (!store.templatesOpen) return null

      var templates = store.templates || []
      var categories = store.templateCategories || []
      var query = String(store.templateQuery || '')
      var activeCat = store.templateCategory || ''
      var shown = filterTemplates(templates, query, activeCat)
      var navItems = [{ key: '', label: '全部模板', count: templates.length }].concat(categories.map(function (name) {
        return {
          key: name,
          label: name,
          count: templates.filter(function (item) { return item.category === name }).length
        }
      }))
      var busy = Boolean(store.templateBusy)
      var step = store.templateStep === 'target' && store.templatePick ? 'target' : 'list'
      var pick = store.templatePick

      var head = h('div', { className: 'ml-modal-head' },
        h('span', { className: 'ml-modal-title' }, step === 'target' ? '新建文件' : '模板库'),
        h('button', { className: 'ml-modal-x', title: '关闭（Esc）', onClick: closeTemplates }, '×')
      )

      var body = null
      var foot = null

      if (step === 'target') {
        var target = String(store.templateTarget || '')
        body = h('div', { className: 'ml-tpl-pick' },
          h('div', { className: 'ml-tpl-preview', style: { color: (pick && pick.accent) || C.accent } },
            h('div', { className: 'ml-tpl-preview-bar' }),
            [44, 62, 80, 98, 116, 134].map(function (top, index) {
              return h('div', {
                key: 'l' + index,
                className: 'ml-tpl-preview-line',
                style: { top: top, right: index % 3 === 2 ? 46 : 12 }
              })
            })
          ),
          h('div', { className: 'ml-tpl-fields' },
            h('div', { className: 'ml-tpl-field' },
              h('div', { className: 'ml-tpl-field-label' }, '模板'),
              h('div', { style: { fontSize: 13, fontWeight: 500 } }, (pick && pick.name) || '空白文档'),
              h('div', { className: 'ml-tpl-hint' }, pick && pick.blank
                ? 'ctexart 骨架：标题 · 作者 · 日期 · 一节正文'
                : [pick && pick.category, pick && pick.engine, pick && pick.files ? pick.files + ' 个文件' : '']
                  .filter(Boolean).join(' · '))),
            h('div', { className: 'ml-tpl-field' },
              h('div', { className: 'ml-tpl-field-label' }, '存放位置'),
              h('div', { className: 'ml-tpl-pathrow' },
                h('div', {
                  className: 'ml-tpl-path' + (target ? '' : ' ml-tpl-path-empty'),
                  title: target || ''
                }, target || '还没有选择文件夹'),
                h('button', {
                  className: 'ml-modal-btn',
                  disabled: busy,
                  onClick: function () { pickTemplateTarget() }
                }, '选择文件夹…'))),
            h('div', { className: 'ml-tpl-hint' }, pick && pick.blank
              ? '会在该目录里新建一个不重名的 untitled.tex。'
              : '主文件统一叫 main.tex。目录里已经有东西时，会落到该目录下的 <模板id> 子文件夹，绝不把模板文件散进你已有的项目。'))
        )
        foot = [
          h('span', { key: 'hint', style: { flex: 1 } }, '选一个文件夹，然后点「创建」'),
          h('button', {
            key: 'back',
            className: 'ml-modal-btn',
            disabled: busy,
            onClick: function () { patch({ templateStep: 'list', templatePick: null }) }
          }, '返回'),
          h('button', {
            key: 'ok',
            className: 'ml-modal-btn ml-modal-btn-on',
            disabled: busy || !target,
            onClick: function () { createFromTemplate() }
          }, busy ? '正在创建…' : '创建')
        ]
      } else {
        body = h('div', { className: 'ml-tpl-layout' },
          h('div', { className: 'ml-tpl-nav' }, navItems.map(function (item) {
            var on = item.key === activeCat
            return h('button', {
              key: 'nav-' + (item.key || 'all'),
              className: 'ml-tpl-navitem' + (on ? ' ml-tpl-nav-on' : ''),
              onClick: function () { patch({ templateCategory: item.key }) }
            },
              h('span', null, item.label),
              h('span', { style: { flex: 1 } }),
              h('span', { style: { opacity: 0.65 } }, item.count))
          })),
          h('div', { className: 'ml-tpl-main' },
            h('div', { className: 'ml-tpl-bar' },
              h('input', {
                className: 'ml-tpl-search',
                type: 'search',
                placeholder: '搜索模板名称或描述…',
                value: store.templateQuery || '',
                autoFocus: true,
                onChange: function (event) { patch({ templateQuery: event.target.value }) }
              }),
              h('span', { className: 'ml-tpl-count' }, shown.length + ' / ' + templates.length)),
            templates.length === 0
              ? h('div', { className: 'ml-empty' }, '没有读到内置模板（宿主 lib/templates 缺失）。')
              : (shown.length === 0
                ? h('div', { className: 'ml-empty' }, '没有匹配的模板。清掉搜索词或换一个分类看看。')
                : h('div', { className: 'ml-tpl-grid' }, shown.map(function (item) {
                  return h('div', {
                    key: item.id,
                    className: 'ml-tpl-card',
                    'data-busy': '0',
                    title: item.name + '（' + item.engine + '，' + item.files + ' 个文件 / ' + Math.max(1, Math.round(item.bytes / 1024)) + ' KB）\n' + item.description,
                    onClick: function () { pickTemplate(item) }
                  },
                    h('span', { className: 'ml-tpl-accent', style: { color: item.accent || C.accent } }),
                    h('div', { className: 'ml-tpl-name' }, item.name),
                    h('div', { className: 'ml-tpl-meta' }, item.category + ' · ' + item.engine),
                    h('div', { className: 'ml-tpl-desc' }, item.description))
                }))),
            h('div', { className: 'ml-card ml-tpl-footcard', onClick: function () { pickTemplate({ blank: true, name: '空白文档' }) } },
              h('span', { className: 'ml-glyph', style: { fontSize: 16 } }, '▤'),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'ml-card-title' }, '新建中文文档'),
                h('div', { className: 'ml-card-desc' }, 'ctexart 骨架：标题 · 作者 · 日期 · 一节正文')),
              h('span', { className: 'ml-path' }, '→'))
          )
        )
        foot = [h('span', { key: 'hint', style: { flex: 1 } }, '点击模板后，选择模板存放的文件夹')]
      }

      return h('div', { style: { position: 'absolute', inset: 0 }, 'data-moling': '1' },
        h('style', null, TEMPLATE_CSS),
        h('div', {
          className: 'ml-modal-mask',
          onClick: function (event) { if (event.target === event.currentTarget) closeTemplates() }
        },
          h('div', { className: 'ml-modal' }, head, h('div', { className: 'ml-modal-body' + (step === 'target' ? ' ml-modal-body-target' : '') }, body), h('div', { className: 'ml-modal-foot' }, foot))
        )
      )
    }

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

      var all = store.recents || []
      // 分类预览：工作区与文件各成一组（组内仍按时间倒序），互不混排。
      var recentDirs = all.filter(function (entry) { return entry.kind === 'dir' }).slice(0, 5)
      var recentFiles = all.filter(function (entry) { return entry.kind !== 'dir' }).slice(0, 5)
      function recentRows(list) {
        return list.map(function (entry) {
          var isDir = entry.kind === 'dir'
          return h('div', {
            key: entry.kind + ':' + (entry.root || '') + ':' + entry.value,
            className: 'ml-row',
            title: isDir ? entry.value : (entry.root ? entry.root + '\\' : '') + entry.value,
            onClick: function () { isDir ? openRootFolder(entry.value) : openRecentFile(entry) }
          },
            h('span', { className: 'ml-glyph' }, isDir ? '▦' : '▤'),
            h('span', { className: 'ml-label' }, entry.title || basename(entry.value)),
            h('span', { className: 'ml-path' }, isDir ? entry.value : (entry.root || ''))
          )
        })
      }
      var recentBlocks = []
      if (recentDirs.length) {
        recentBlocks.push(
          h('div', { className: 'ml-subsec', key: 'sub-dir' }, '工作区 · ' + recentDirs.length),
          h('div', { key: 'rows-dir' }, recentRows(recentDirs))
        )
      }
      if (recentFiles.length) {
        recentBlocks.push(
          h('div', { className: 'ml-subsec', key: 'sub-file' }, '文件 · ' + recentFiles.length),
          h('div', { key: 'rows-file' }, recentRows(recentFiles))
        )
      }

      /* 模板库入口：启动页**只放一张卡**，模板清单在二级弹窗里挑（列表不铺在启动页）。
         清单由宿主 templates 端点给（只元数据，1.1 MB 的素材不进城），
         弹窗里点一张卡 → 选存放位置 → use-template 端点把文件拷进去 → 进工作台打开 main.tex。 */
      var templateSection = [
        h('div', { className: 'ml-sec', key: 'tpl-sec' }, '模板'),
        h('div', { className: 'ml-card', key: 'tpl-entry', onClick: openTemplates },
          h('span', { className: 'ml-glyph', style: { fontSize: 16 } }, '▤'),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'ml-card-title' }, '浏览模板库'),
            h('div', { className: 'ml-card-desc' }, '中文论文 · 英文论文 · 简历 · 幻灯片 · 实验报告等内置模板')),
          h('span', { className: 'ml-path' }, '→')),
        // 保留原来的「空白 ctexart 骨架」入口：模板之外还要一条最快的新建路径
        h('div', { className: 'ml-card', key: 'tpl-blank', onClick: newDocument },
          h('span', { className: 'ml-glyph', style: { fontSize: 16 } }, '▤'),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'ml-card-title' }, '新建中文文档'),
            h('div', { className: 'ml-card-desc' }, 'ctexart 骨架：标题 · 作者 · 日期 · 一节正文')),
          h('span', { className: 'ml-path' }, '→'))
      ]

      // data-moling：面板根节点的标记（「发送选中内容」的 DOM 兜底靠它跳过面板自己的输入框）。
      return h('div', { style: Object.assign({}, S.welcome, { colorScheme: store.scheme }), 'data-moling': '1' },
        h('style', null, WELCOME_CSS),
        h('div', { className: 'ml-wrap' },
          h('div', { className: 'ml-main' },
            h('div', { className: 'ml-brand' },
              h(BrandMark, null),
              h('div', { className: 'ml-brand-text' },
                h('div', { className: 'ml-h1' }, '墨灵 LaTeX'),
                h('div', { className: 'ml-sub' }, '编辑 · 编译 · 预览 — 本地一体化 LaTeX 工作流'))),

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
            recentBlocks.length
              ? recentBlocks
              : h('div', { className: 'ml-empty' }, '还没有打开记录。点「打开文件夹…」选一个 LaTeX 项目目录，之后会出现在这里。'),

            templateSection
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
     * 编辑器
     *
     * 主路径 = CodeMirror 6（内核在 lib/vendor/cm6.js，宿主用 /moling/api/asset 发出来）。
     *   它只渲染视口内的行（虚拟化），1400 行的文件打字/滚动都不卡；
     *   光标由编辑器自己画，不存在「透明 textarea 叠高亮层」那种两层错位。
     * 回退 = 内核脚本加载失败时用老实现（透明 textarea + 高亮层），功能一样，大文件慢。
     * ------------------------------------------------------------------ */

    /** 内核资源版本：换了 cm6.js 就加一，避免浏览器命中旧缓存。 */
    var KERNEL_VERSION = '5'
    var kernelCache = { promise: null, failed: false }

    /** 内核资源地址（宿主 asset 端点发的文件；v 只用于打掉旧缓存）。 */
    function kernelAssetUrl() {
      return API + '/asset?name=cm6.js&v=' + KERNEL_VERSION
    }

    function loadEditorKernel() {
      if (kernelCache.promise) return kernelCache.promise
      kernelCache.promise = new Promise(function (resolve, reject) {
        if (typeof window !== 'undefined' && window.__molingCM) { resolve(window.__molingCM); return }
        var script = document.createElement('script')
        script.src = kernelAssetUrl()
        script.async = true
        script.onload = function () {
          if (window.__molingCM) resolve(window.__molingCM)
          else reject(new Error('编辑器内核加载后没有注册 __molingCM'))
        }
        script.onerror = function () { reject(new Error('编辑器内核加载失败（/moling/api/asset?name=cm6.js）')) }
        document.head.appendChild(script)
      })
      kernelCache.promise.catch(function () { kernelCache.failed = true })
      return kernelCache.promise
    }

    /** 日志里点错误行 → 交给当前编辑器跳转（CM 或回退 textarea 都注册到这里）。 */
    var editorBridge = { jumpTo: null, run: null, selection: null }

    function useEditorKernel() {
      var pair = React.useState(function () {
        return typeof window !== 'undefined' && window.__molingCM ? 'ready' : 'loading'
      })
      var state = pair[0]
      var setState = pair[1]
      React.useEffect(function () {
        if (state !== 'loading') return undefined
        var alive = true
        loadEditorKernel().then(function () {
          if (alive) setState('ready')
        }).catch(function (failure) {
          try { console.error('[moling_latex] 编辑器内核不可用，回退到 textarea：', failure) } catch (error) { /* 忽略 */ }
          if (alive) setState('failed')
        })
        return function () { alive = false }
      }, [state])
      return state
    }

    /* ------------------------------------------------------------------ *
     * LaTeX 自动补全
     *
     * 纯函数：输入 { text, pos }，输出 { from, options } 或 null。
     * 内核（entry.js 的 completionExtension）把它挂进 CodeMirror 的 languageData，
     * basicSetup 里本来就装着 autocompletion，所以不需要再装一次扩展。
     *
     * 覆盖五种触发：
     *   ① `\begin{` / `\end{` → 环境名（`\begin` 顺手补 `\end{...}` 并把光标放中间）
     *   ② `\ref{` `\eqref{` … → 当前文档里的 `\label{...}`
     *   ③ `\cite{` … → 当前文档里的 `\bibitem{...}`（支持逗号分隔的多引用）
     *   ④ `\usepackage{` / `\documentclass{` → 常用宏包 / 文档类
     *   ⑤ `\` 开头 → 常用命令（带模板的项用 snippet，Tab 跳占位符）
     * ------------------------------------------------------------------ */

    /** 命令表：[标签, 说明, 插入模板（空 = 直接插入标签）]。 */
    var LATEX_COMMANDS = [
      ['\\documentclass', '文档类', '\\documentclass[${1:UTF8}]{${2:ctexart}}'],
      ['\\usepackage', '宏包', '\\usepackage{${1:amsmath}}'],
      ['\\title', '标题', '\\title{${1}}'],
      ['\\author', '作者', '\\author{${1}}'],
      ['\\date', '日期', '\\date{${1:\\today}}'],
      ['\\maketitle', '生成标题', ''],
      ['\\tableofcontents', '目录', ''],
      ['\\part', '章（部）', '\\part{${1}}'],
      ['\\chapter', '章', '\\chapter{${1}}'],
      ['\\section', '节', '\\section{${1}}'],
      ['\\subsection', '小节', '\\subsection{${1}}'],
      ['\\subsubsection', '小小节', '\\subsubsection{${1}}'],
      ['\\paragraph', '段标题', '\\paragraph{${1}}'],
      ['\\label', '标签', '\\label{${1}}'],
      ['\\ref', '引用标签', '\\ref{${1}}'],
      ['\\eqref', '引用公式', '\\eqref{${1}}'],
      ['\\pageref', '引用页码', '\\pageref{${1}}'],
      ['\\autoref', '智能引用', '\\autoref{${1}}'],
      ['\\cite', '文献引用', '\\cite{${1}}'],
      ['\\citep', '文献引用（括号）', '\\citep{${1}}'],
      ['\\citet', '文献引用（文本）', '\\citet{${1}}'],
      ['\\bibliography', '参考文献库', '\\bibliography{${1:refs}}'],
      ['\\bibliographystyle', '文献样式', '\\bibliographystyle{${1:plain}}'],
      ['\\textbf', '加粗', '\\textbf{${1}}'],
      ['\\textit', '斜体', '\\textit{${1}}'],
      ['\\texttt', '等宽', '\\texttt{${1}}'],
      ['\\underline', '下划线', '\\underline{${1}}'],
      ['\\emph', '强调', '\\emph{${1}}'],
      ['\\textcolor', '文字颜色', '\\textcolor{${1:red}}{${2}}'],
      ['\\footnote', '脚注', '\\footnote{${1}}'],
      ['\\url', '链接', '\\url{${1}}'],
      ['\\href', '带文字链接', '\\href{${1:url}}{${2:文字}}'],
      ['\\frac', '分式', '\\frac{${1:分子}}{${2:分母}}'],
      ['\\dfrac', '行间分式', '\\dfrac{${1:分子}}{${2:分母}}'],
      ['\\sqrt', '根号', '\\sqrt{${1}}'],
      ['\\sum', '求和', '\\sum_{${1}}^{${2}}'],
      ['\\prod', '连乘', '\\prod_{${1}}^{${2}}'],
      ['\\int', '积分', '\\int_{${1}}^{${2}}'],
      ['\\iint', '二重积分', ''],
      ['\\oint', '环路积分', ''],
      ['\\lim', '极限', '\\lim_{${1}}'],
      ['\\log', '对数', ''],
      ['\\ln', '自然对数', ''],
      ['\\exp', '指数', ''],
      ['\\sin', '正弦', ''],
      ['\\cos', '余弦', ''],
      ['\\tan', '正切', ''],
      ['\\left', '左定界符', '\\left(${1}\\right)'],
      ['\\right', '右定界符', ''],
      ['\\cdot', '点乘', ''],
      ['\\times', '叉乘', ''],
      ['\\div', '除号', ''],
      ['\\pm', '正负', ''],
      ['\\mp', '负正', ''],
      ['\\leq', '小于等于', ''],
      ['\\geq', '大于等于', ''],
      ['\\neq', '不等于', ''],
      ['\\approx', '约等于', ''],
      ['\\equiv', '恒等', ''],
      ['\\in', '属于', ''],
      ['\\notin', '不属于', ''],
      ['\\subset', '子集', ''],
      ['\\cup', '并集', ''],
      ['\\cap', '交集', ''],
      ['\\forall', '任意', ''],
      ['\\exists', '存在', ''],
      ['\\partial', '偏导', ''],
      ['\\nabla', '梯度算子', ''],
      ['\\infty', '无穷', ''],
      ['\\alpha', 'α', ''],
      ['\\beta', 'β', ''],
      ['\\gamma', 'γ', ''],
      ['\\delta', 'δ', ''],
      ['\\epsilon', 'ε', ''],
      ['\\lambda', 'λ', ''],
      ['\\mu', 'μ', ''],
      ['\\pi', 'π', ''],
      ['\\sigma', 'σ', ''],
      ['\\theta', 'θ', ''],
      ['\\omega', 'ω', ''],
      ['\\Delta', 'Δ', ''],
      ['\\Omega', 'Ω', ''],
      ['\\Sigma', 'Σ', ''],
      ['\\Theta', 'Θ', ''],
      ['\\item', '列表项', '\\item ${1}'],
      ['\\caption', '图表标题', '\\caption{${1}}'],
      ['\\centering', '居中', ''],
      ['\\includegraphics', '插图', '\\includegraphics[width=${1:0.8}\\linewidth]{${2:figure.pdf}}'],
      ['\\toprule', '表格顶线', ''],
      ['\\midrule', '表格中线', ''],
      ['\\bottomrule', '表格底线', ''],
      ['\\hline', '横线', ''],
      ['\\newpage', '新页', ''],
      ['\\clearpage', '清空浮动体换页', ''],
      ['\\vspace', '竖向间距', '\\vspace{${1:1em}}'],
      ['\\hspace', '横向间距', '\\hspace{${1:1em}}'],
      ['\\smallskip', '小间距', ''],
      ['\\medskip', '中间距', ''],
      ['\\bigskip', '大间距', ''],
      ['\\noindent', '不缩进', ''],
      ['\\par', '分段', ''],
      ['\\quad', '一个全角空格', ''],
      ['\\qquad', '两个全角空格', ''],
      ['\\today', '今天日期', ''],
      ['\\LaTeX', 'LaTeX 标志', ''],
      ['\\TeX', 'TeX 标志', ''],
      ['\\verb', '行内原样', '\\verb|${1}|']
    ]

    /** 环境名表：[名字, 说明]。 */
    var LATEX_ENVIRONMENTS = [
      ['document', '文档体'],
      ['abstract', '摘要'],
      ['itemize', '无序列表'],
      ['enumerate', '有序列表'],
      ['description', '描述列表'],
      ['figure', '图'],
      ['figure*', '图（跨栏）'],
      ['table', '表'],
      ['table*', '表（跨栏）'],
      ['tabular', '表格'],
      ['tabularx', '自适应宽表格'],
      ['longtable', '跨页表格'],
      ['equation', '行间公式'],
      ['equation*', '行间公式（无编号）'],
      ['align', '多行对齐公式'],
      ['align*', '多行对齐公式（无编号）'],
      ['gather', '多行居中公式'],
      ['gather*', '多行居中公式（无编号）'],
      ['multline', '多行折行公式'],
      ['cases', '分段函数'],
      ['matrix', '矩阵'],
      ['pmatrix', '圆括号矩阵'],
      ['bmatrix', '方括号矩阵'],
      ['vmatrix', '行列式'],
      ['theorem', '定理'],
      ['lemma', '引理'],
      ['definition', '定义'],
      ['corollary', '推论'],
      ['proof', '证明'],
      ['remark', '注'],
      ['example', '例'],
      ['center', '居中'],
      ['flushleft', '左对齐'],
      ['flushright', '右对齐'],
      ['quote', '引用块'],
      ['quotation', '引用块（首行缩进）'],
      ['verse', '诗句'],
      ['minipage', '分栏盒'],
      ['verbatim', '原样输出'],
      ['lstlisting', '代码块'],
      ['tikzpicture', 'TikZ 图'],
      ['algorithm', '算法'],
      ['algorithmic', '算法步骤'],
      ['columns', 'Beamer 分栏'],
      ['column', 'Beamer 单栏'],
      ['frame', 'Beamer 幻灯片'],
      ['block', 'Beamer 区块'],
      ['thebibliography', '参考文献'],
      ['appendix', '附录'],
      ['subfigure', '子图'],
      ['multicols', '多栏排版']
    ]

    /** 宏包 / 文档类候选。 */
    var LATEX_PACKAGES = [
      'ctex', 'xeCJK', 'fontspec', 'unicode-math', 'amsmath', 'amssymb', 'amsthm', 'mathtools', 'bm',
      'graphicx', 'geometry', 'xcolor', 'hyperref', 'booktabs', 'multirow', 'makecell', 'array',
      'longtable', 'tabularx', 'enumitem', 'listings', 'caption', 'subcaption', 'float', 'algorithm',
      'algorithmic', 'algorithm2e', 'tikz', 'pgfplots', 'siunitx', 'natbib', 'biblatex', 'cleveref',
      'microtype', 'setspace', 'titlesec', 'fancyhdr', 'parskip', 'indentfirst', 'threeparttable',
      'rotating', 'pdflscape', 'textcomp', 'gensymb', 'placeins', 'afterpage', 'tocloft', 'multicol',
      'wrapfig', 'subfig', 'adjustbox', 'etoolbox', 'article', 'report', 'book', 'ctexart', 'ctexrep',
      'ctexbook', 'beamer', 'IEEEtran', 'cas-dc', 'cas-sc', 'cumcmthesis'
    ]

    /** 从全文里扫某个命令的花括号参数（去重、保序）。 */
    function scanCommandArgs(text, command) {
      var pattern = new RegExp('\\\\' + command + '\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}', 'g')
      var seen = Object.create(null)
      var out = []
      var match = pattern.exec(text)
      while (match) {
        var value = String(match[1] || '').trim()
        if (value && !seen[value]) { seen[value] = true; out.push(value) }
        match = pattern.exec(text)
      }
      return out
    }

    function labelOptions(text) {
      return scanCommandArgs(text, 'label').map(function (name) {
        return { label: name, type: 'variable', detail: '标签' }
      })
    }

    function bibOptions(text) {
      return scanCommandArgs(text, 'bibitem').map(function (name) {
        return { label: name, type: 'constant', detail: '文献' }
      })
    }

    /** `\begin{fig` → 环境名；插入时顺手补 `\end{...}`（光标落在中间那行）。 */
    function environmentCompletions(text, pos, typed, isEnd) {
      var from = pos - typed.length
      var closed = text.charAt(pos) === '}'
      var options = LATEX_ENVIRONMENTS
        .filter(function (item) { return !typed || item[0].indexOf(typed) === 0 })
        .map(function (item) {
          var name = item[0]
          var option = { label: name, type: 'class', detail: item[1] }
          if (!isEnd) {
            // 已经打了 `}` 就一起吃掉，避免多出一个花括号
            option.snippet = (closed ? name + '}' : name + '}\n\t${0}\n\\end{' + name + '}')
            if (closed) option.apply = undefined
            option.from = from
            option.to = closed ? pos + 1 : pos
          }
          return option
        })
      if (!options.length) return null
      return { from: from, to: closed && !isEnd ? pos + 1 : pos, options: options }
    }

    /**
     * 补全主函数：纯数据进、纯数据出，方便自测。
     * @param {{text:string, pos:number}} input
     * @returns {null | {from:number, to?:number, options:Array}}
     */
    function completeLatex(input) {
      var text = String((input && input.text) || '')
      var pos = Math.max(0, Math.min(text.length, Number(input && input.pos) || 0))
      var lineStart = text.lastIndexOf('\n', pos - 1) + 1
      var before = text.slice(lineStart, pos)
      var match = null

      // ① 环境名
      match = /\\begin\s*\{([a-zA-Z*]*)$/.exec(before)
      if (match) return environmentCompletions(text, pos, match[1], false)
      match = /\\end\s*\{([a-zA-Z*]*)$/.exec(before)
      if (match) return environmentCompletions(text, pos, match[1], true)

      // ② 标签引用
      match = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref)\s*\{([^{}]*)$/.exec(before)
      if (match) {
        var labels = labelOptions(text)
        if (!labels.length) return null
        return { from: pos - match[1].length, options: labels }
      }

      // ③ 文献引用（支持 a,b,c 这种逗号列表，只补最后一段）
      match = /\\(?:cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)$/.exec(before)
      if (match) {
        var keys = bibOptions(text)
        if (!keys.length) return null
        var tail = match[1].split(',').pop() || ''
        return { from: pos - tail.length, options: keys }
      }

      // ④ 宏包 / 文档类
      match = /\\(?:usepackage|documentclass)\s*(?:\[[^\]]*\]\s*)?\{([a-zA-Z0-9-]*)$/.exec(before)
      if (match) {
        var typed = match[1]
        var packages = LATEX_PACKAGES
          .filter(function (name) { return !typed || name.indexOf(typed) === 0 })
          .map(function (name) { return { label: name, type: 'namespace', detail: '宏包 / 文档类' } })
        return packages.length ? { from: pos - typed.length, options: packages } : null
      }

      // ⑤ 命令
      match = /\\[a-zA-Z]*$/.exec(before)
      if (match) {
        var prefix = match[0]
        var commands = LATEX_COMMANDS
          .filter(function (item) { return item[0].indexOf(prefix) === 0 })
          .map(function (item) {
            var option = { label: item[0], type: 'keyword', detail: item[1] }
            if (item[2]) option.snippet = item[2]
            return option
          })
        return commands.length ? { from: pos - prefix.length, options: commands } : null
      }

      return null
    }

    /** CodeMirror 6 编辑器。 */
    function CodeMirrorEditor(props) {
      var tab = props.tab
      var store = props.store
      var hostRef = React.useRef(null)
      var viewRef = React.useRef(null)
      var emittedRef = React.useRef(null)
      // { text, lines }：分词结果的缓存（按文本内容比对，命中就不重算）
      var segmentsRef = React.useRef({ text: null, lines: [] })
      var kernel = typeof window !== 'undefined' ? window.__molingCM : null

      // 换 tab 就重建实例：状态干净，大文件创建也只要几十毫秒
      React.useEffect(function () {
        var host = hostRef.current
        if (!host || !kernel) return undefined
        var view = kernel.create(host, {
          doc: tab.text,
          wrap: store.wrap,
          autofocus: true,
          onChange: function (text) {
            emittedRef.current = text
            // 外部同步（setDoc）也会走到这里：撞上刚推下去的同一份文本 → 只更新、不标脏
            if (suppressDirtyText !== null && text === suppressDirtyText) {
              suppressDirtyText = null
              setTab(tab.id, { text: text })
              return
            }
            setTab(tab.id, { text: text, dirty: true })
          },
          onSave: function () { saveTab(tab.id) },
          onCompile: function () { compileActive() },
          onContextMenu: function (line, event) { if (props.onMenu) props.onMenu(line, event) },
          // 视口滚出新行 / 行位置挪了 → 把窗口期内的「标绿」补涂到新出现的行上
          onViewport: function () { repaintFlash() },
          // 面板自己的分词 → 内核用行内 style 上色（不依赖 CodeMirror 的高亮样式类，
          // 那些类在 DSH 页面里会被别的 CodeMirror 实例覆盖，线上表现就是"一个字都不上色"）
          getSegments: function (text) {
            var cache = segmentsRef.current
            if (cache.text !== text) {
              // 内核要的是「每行一个 segment 数组」，highlightDocument 返回的是
              // {segments, bold} 包装对象 —— 早先直接把包装对象递过去，内核按数组迭代
              // 时 lines[i].length 是 undefined 就被整行跳过，结果一条行内样式都没涂，
              // 线上表现就是「只有 stex 那层兜底色，\begin{} 的环境名 / \label 的键全是白字」。
              var doc = highlightDocument(text)
              var rows = []
              for (var i = 0; i < doc.length; i++) rows.push(doc[i].segments)
              cache = { text: text, lines: rows }
              segmentsRef.current = cache
            }
            return cache.lines
          },
          // LaTeX 自动补全：内核把 CodeMirror 的补全上下文交过来，这里只做纯文本推断
          onComplete: function (context) {
            try {
              return completeLatex({ text: context.state.doc.toString(), pos: context.pos })
            } catch (err) {
              return null
            }
          }
        })
        viewRef.current = view
        editorBridge.jumpTo = function (line) { kernel.gotoLine(view, line) }
        editorBridge.run = function (name) { kernel.runCommand(view, name) }
        editorBridge.selection = function () { return kernel.getSelection(view) }
        return function () {
          editorBridge.jumpTo = null
          editorBridge.run = null
          editorBridge.selection = null
          viewRef.current = null
          if (flashState.owner === view) clearFlash()   // 换标签了，别把绿底留给下一个
          kernel.destroy(view)
        }
      }, [tab.id, kernel])

      // 换行开关
      React.useEffect(function () {
        if (viewRef.current && kernel) kernel.setWrap(viewRef.current, store.wrap)
      }, [store.wrap])

      // 外部改文本（例如重新从磁盘读）：同步进去；自己刚打出来的内容不用回灌
      React.useEffect(function () {
        var view = viewRef.current
        if (!view || !kernel) return
        if (tab.text !== emittedRef.current) {
          suppressDirtyText = tab.text      // 这次 onChange 不算用户输入（否则标签被自己标脏）
          // setDoc 是整篇替换 → 视口会跳。先记下停在哪一行，换完再挪回去。
          // 刚做过跳转（SyncTeX/日志点行）的 600ms 内不还原，免得跟跳转抢滚动位置。
          var keep = Date.now() < suppressRestoreUntil ? null : captureViewport(view)
          kernel.setDoc(view, tab.text)
          if (keep) {
            restoreViewport(view, keep)
            // 布局要等一帧才稳（高度/换行重排），下一帧再补一次，观感上就不会"滑走"
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(function () { restoreViewport(viewRef.current || view, keep) })
            }
          }
        }
        // 大模型改进来的那几行：涂绿提示（停几秒自己隐去）
        var flash = takeFlash(tab.id)
        if (flash) startFlash(flash.tabId, flash.ranges, view, view.contentDOM, lineReaderFor(view))
      }, [tab.text])

      // 跳转/定位之后把目标行闪一下：不闪的话"到底跳没跳"肉眼很难判断
      React.useEffect(function () {
        var view = viewRef.current
        if (!view || !kernel || !store.flashLine) return
        startFlash('goto', [{ from: store.flashLine, to: store.flashLine }],
          view, view.contentDOM, lineReaderFor(view))
      }, [store.flashAt])

      return h('div', { ref: hostRef, className: 'ml-cm', style: { position: 'absolute', inset: 0, overflow: 'hidden' } })
    }

    /**
     * 回退编辑器：透明 textarea 叠在高亮层上。
     * 关键是两层内容宽度必须完全相等（textarea 用 scrollbar-gutter 永久预留滚动条槽，
     * 高亮层按探测到的滚动条宽度补 padding-right），否则换行点不同 → 光标与字形错位。
     */
    function LegacyEditor(props) {
      var tab = props.tab
      var store = props.store
      var textareaRef = React.useRef(null)
      var preRef = React.useRef(null)
      var gutterWidth = scrollbarWidthPx()
      var tabText = tab ? tab.text : ''

      var highlighted = React.useMemo(function () {
        if (!tabText) return []
        if (tabText.length > HL_MAX_CHARS) {
          return tabText.split('\n').map(function (row, i) {
            return h('div', { key: i, className: 'ml-hl-line', 'data-line': i + 1 },
              h('span', { key: 'ln', className: 'ml-hl-num' }, i + 1), row)
          })
        }
        // 缓存键只认 tab id：带上文本长度会让每次按键都换 key → 整篇重排
        return buildHighlight(tabText, tab ? tab.id : '')
      }, [tabText])

      var syncScroll = function () {
        var element = textareaRef.current
        var pre = preRef.current
        if (!element || !pre) return
        pre.scrollTop = element.scrollTop
        pre.scrollLeft = element.scrollLeft
      }

      React.useEffect(function () { syncScroll() })

      // 回退编辑器：外部同步进来的改动行涂绿（没有虚拟化，渲染完直接补涂/回涂）
      React.useEffect(function () {
        if (!tab) return
        var container = preRef.current
        if (!container) return            // 还没挂上，等下一次
        var flash = takeFlash(tab.id)
        if (flash) {
          startFlash(flash.tabId, flash.ranges, container, container, function (node) {
            return Number(node.getAttribute('data-line')) || 0
          })
        } else {
          repaintFlash()                  // 文本重排后行元素是新的，把窗口期内的绿底补回去
        }
      }, [tabText])

      // 跳转/定位：把目标行闪一下（回退编辑器没有虚拟化，直接按 data-line 找）
      React.useEffect(function () {
        var container = preRef.current
        if (!container || !store.flashLine) return
        startFlash('goto', [{ from: store.flashLine, to: store.flashLine }], container, container, function (node) {
          return Number(node.getAttribute('data-line')) || 0
        })
      }, [store.flashAt])

      React.useEffect(function () {
        if (!tab) return undefined
        editorBridge.jumpTo = function (line) {
          var element = textareaRef.current
          if (!element || !line) return
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
        // 回退编辑器的右键「基础功能」：直接作用在 textarea 上
        editorBridge.run = function (name) {
          var element = textareaRef.current
          if (!element) return
          element.focus()
          if (name === 'selectAll') { element.select(); return }
          if (name === 'paste') {
            var clip = window.navigator && window.navigator.clipboard
            if (clip && typeof clip.readText === 'function') {
              clip.readText().then(function (text) {
                if (text) element.setRangeText(text, element.selectionStart, element.selectionEnd, 'end')
                if (tab) setTab(tab.id, { text: element.value, dirty: true })
              }).catch(function () { /* 没权限就算了 */ })
              return
            }
          }
          try { document.execCommand(name) } catch (error) { /* 忽略 */ }
          if (tab) setTab(tab.id, { text: element.value, dirty: true })
        }
        // 选区（含行号），供「发送选中内容到对话框」用
        editorBridge.selection = function () {
          var element = textareaRef.current
          if (!element) return { text: '', fromLine: 0, toLine: 0 }
          var value = element.value
          var start = element.selectionStart
          var end = element.selectionEnd
          return {
            text: value.slice(start, end),
            fromLine: value.slice(0, start).split('\n').length,
            toLine: value.slice(0, end).split('\n').length
          }
        }
        return function () {
          editorBridge.jumpTo = null
          editorBridge.run = null
          editorBridge.selection = null
        }
      }, [tab && tab.id, tabText])

      var onEditorChange = function (event) {
        if (!tab) return
        setTab(tab.id, { text: event.target.value, dirty: true })
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

      /** 右键：回退编辑器也要能弹「定位到 PDF」菜单（光标所在行）。 */
      var onContextMenu = function (event) {
        if (!tab || !props.onMenu) return
        event.preventDefault()
        var element = event.currentTarget
        var upto = tab.text.slice(0, element.selectionStart)
        props.onMenu(upto.split('\n').length, event)
      }

      // 注意：外层 .ml-editor 已经是 position:relative 的定位容器，
      // 这里必须绝对铺满，不能再套一层 flex:1（父级不是 flex 容器 → 高度塌成 0 → 整个编辑区空白）
      return h('div', { style: { position: 'absolute', inset: 0 }, className: 'ml-legacy' },
        h('style', null, EDITOR_CSS),
        // 高亮层（含行号）：右侧多留一个滚动条宽度，保证与 textarea 内容宽度一致
        h('div', {
          style: Object.assign({}, S.hlWrap, {
            paddingRight: 8 + gutterWidth,
            whiteSpace: store.wrap ? 'pre-wrap' : 'pre',
            wordBreak: store.wrap ? 'break-word' : 'normal',
            overflowWrap: store.wrap ? 'break-word' : 'normal'
          }),
          ref: preRef,
          'aria-hidden': 'true'
        }, highlighted),
        h('textarea', {
          ref: textareaRef,
          style: Object.assign({}, S.textareaOverlay, {
            whiteSpace: store.wrap ? 'pre-wrap' : 'pre',
            wordBreak: store.wrap ? 'break-word' : 'normal',
            overflowWrap: store.wrap ? 'break-word' : 'normal'
          }),
          value: tab ? tab.text : '',
          spellCheck: false,
          wrap: store.wrap ? 'soft' : 'off',
          onChange: onEditorChange,
          onScroll: syncScroll,
          onKeyDown: onKeyDown,
          onContextMenu: onContextMenu
        }))
    }

    /** 编辑器区域：有内核走 CodeMirror，没有就退回老实现。 */
    function EditorArea(props) {
      var kernelState = useEditorKernel()
      var tab = props.tab
      if (!tab) {
        return h('div', { style: Object.assign({}, S.hint, { padding: 10, whiteSpace: 'pre-wrap' }) },
          '点「文件树」打开文件列表，选一个 .tex 开始编辑。\nF5 编译 · Ctrl+S 保存 · 可同时开多个标签。')
      }
      if (kernelState === 'ready') return h(CodeMirrorEditor, { tab: tab, store: props.store, onMenu: props.onMenu })
      if (kernelState === 'failed') {
        // 回退模式：说明为什么没上 CodeMirror，否则用户只会觉得"编辑器怪怪的"
        return h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' } },
          h('div', { style: S.kernelNotice }, '编辑器内核（CodeMirror）未加载，正在用回退编辑器。关闭并重开 DSH 后生效。'),
          h('div', { style: { flex: 1, minHeight: 0, position: 'relative' } },
            h(LegacyEditor, { tab: tab, store: props.store, onMenu: props.onMenu })))
      }
      return h(LegacyEditor, { tab: tab, store: props.store, onMenu: props.onMenu })
    }

    /* ------------------------------------------------------------------ *
     * 工作台：左 tex / 右 pdf，文件树是浮层
     * ------------------------------------------------------------------ */

    /**
     * 面板内部的错误兜底。
     * 渲染或副作用里抛异常时，React 会卸载整棵子树 —— 表现就是「插件界面没了」，
     * 右栏只剩一个空标签页，控制台之外的线索全无。这里接住并画出来。
     */
    class PaneBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failure: null }
        this.reset = this.reset.bind(this)
      }
      static getDerivedStateFromError(failure) { return { failure: failure } }
      componentDidCatch(failure, info) {
        try { console.error('[moling_latex] 面板异常', failure, info) } catch (error) { /* 忽略 */ }
      }
      reset() {
        this.setState({ failure: null })
        patch({ view: 'welcome' })
      }
      render() {
        var failure = this.state.failure
        if (failure) {
          var message = String((failure && failure.message) || failure)
          return h('div', { style: S.crash },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '面板出错了（已兜住，没让整块变空白）'),
            h('div', { style: S.crashText }, message),
            h('button', { style: Object.assign({}, S.btnPrimary, { marginTop: 10 }), onClick: this.reset }, '回首页'))
        }
        return this.props.children
      }
    }

    /**
     * 「屏幕上那个会话」——DSH 的 sidebarRight 服务给出的 mounted 快照。
     * 右栏给每个会话都挂一份 Body（非当前的只是 hidden 不卸载），
     * 所以光看 tabInfo.visible 在浮动面板下可能多份同时为真；服务层的 mounted 才是权威。
     * 用订阅 + state 把它带进渲染，切会话时 effect 才会重跑（快照变了 = 该换人了）。
     */
    function useMountedSession() {
      var pair = React.useState('')
      var value = pair[0]
      var setValue = pair[1]
      React.useEffect(function () {
        var off = null
        var timer = null
        var tries = 0
        var read = function (observed) {
          var next = ''
          try {
            var snap = typeof observed.getSnapshot === 'function' ? observed.getSnapshot() : null
            next = typeof snap === 'string' ? snap : ''
          } catch (error) { next = '' }
          setValue(function (prev) { return prev === next ? prev : next })
        }
        // 服务可能比面板晚一步就绪（插件加载顺序不保证）→ 没拿到就再试几次，
        // 不能只试一次：只试一次的话 mounted 永远是空，浮动面板下两个会话会同时算"可见"。
        var attach = function () {
          var service = null
          try {
            service = state.ctx && typeof state.ctx.get === 'function' ? state.ctx.get('sidebarRight') : null
          } catch (error) { service = null }
          var observed = service && service.mounted
          if (!observed || typeof observed.subscribe !== 'function') {
            if (tries++ < 20 && typeof setTimeout === 'function') timer = setTimeout(attach, 50)
            return
          }
          read(observed)
          var stop = observed.subscribe(function () { read(observed) })
          off = typeof stop === 'function' ? stop : null
        }
        attach()
        return function () {
          if (timer) { clearTimeout(timer); timer = null }
          if (off) { try { off() } catch (error) { /* 忽略 */ } }
        }
      }, [])
      return value
    }

    function Body(props) {
      var store = useStore()
      var face = injected(props)
      // 这个 Body 属于哪个会话、现在是不是它显示着（右栏按会话各挂一份 Body）
      var sessionId = face && (face.sessionId || face.session || (face.session && face.session.id))
      sessionId = typeof sessionId === 'string' ? sessionId : ''
      var mounted = useMountedSession()
      var visible = true
      try {
        var info = props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
        if (info && info.tab && info.tab.visible === false) visible = false
      } catch (error) { visible = true }
      // 服务层明确说是别的会话 → 这份只是后台挂着的，不许动全局 store
      if (mounted && sessionId && mounted !== sessionId) visible = false
      React.useEffect(function () {
        if (!sessionId) return
        // 只有正在显示的那份才允许动全局 store —— 隐藏着的 Body 也挂着，
        // 让它也切会话的话，两个会话会互相把对方的状态顶掉。
        if (!visible) return
        boot(state.ctx)
        if (switchSession(sessionId)) {
          // 换了会话：旧项目的东西不能留在界面上
          pendingFlash = null
        }
        startWatch()   // 双保险：面板真的挂上了就一定起轮询（boot 只跑一次，这里幂等）
      }, [sessionId, visible])
      return h(PaneBoundary, null,
        // useInput 是 hook，只能在渲染期调 → 交给桥组件，事件里读 store.inputSnap
        face && typeof face.useInput === 'function' ? h(InputBridge, { useInput: face.useInput }) : null,
        store.view === 'welcome'
          ? h(Welcome, { store: store })
          : h(Workbench, { props: props, store: store }),
        // 模板库二级弹窗挂在这一层：启动页与工作台都能弹
        h(TemplateDialog, { store: store }))
    }

    /**
     * 顶栏「开关按钮」的样式：开/关两种状态都**显式写全 border 与 color**。
     * 原来只写 `S.btnOn` 的 `borderColor`，关掉时靠 React 把这条 longhand 移除；
     * 而 `S.btnFlat` 里是 `border` 简写 —— 简写/长写混用，React 会警告
     * "Removing a style property during rerender (borderColor) when a conflicting property is set (border)"，
     * 实际表现就是点一下开关，那圈"开着"的框不消失。显式两态 → 不依赖移除。
     */
    function toggleBtnStyle(on) {
      return Object.assign({}, S.btnFlat, on
        ? { border: '1px solid ' + C.accent, color: C.accent }
        : { border: '1px solid transparent', color: C.text })
    }

    function Workbench(props) {
      // 不再自己订阅：父级 Body 已订阅，这里只收 store，避免一次 patch 两次渲染
      var store = props.store
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

      /** 文件树抽屉右边框拖动：拖动后记像素宽（0 才是自适应，双击边框可回退）。 */
      var startTreeDrag = function (event) {
        var left = leftRef.current
        if (!left) return
        var rect = left.getBoundingClientRect()
        beginDrag(event, function (moveEvent) {
          var room = Math.max(TREE_MIN_W, rect.width - 16)
          var width = moveEvent.clientX - rect.left - 8
          patch({ treeW: Math.round(clamp(width, TREE_MIN_W, Math.min(TREE_MAX_W, room))) })
        }, persist)
      }

      var tab = activeTab()

      /** 日志里点错误行：交给当前编辑器（CM 或回退 textarea）跳转。 */
      var jumpTo = function (line) {
        if (!line) return
        // 跳过去之后短时间里别再 restoreViewport（外部同步插一脚会把位置拽回去）
        suppressRestoreUntil = Date.now() + 600
        // 跳转要看得见：收起盖在编辑区上的浮层（文件树/提纲/右键菜单），并让目标行闪一下。
        // 之前"跳了但看不出来"的最大原因就是树抽屉正好盖住编辑区。
        var next = { flashLine: line, flashAt: Date.now() }
        if (state.treeOpen) next.treeOpen = false
        if (state.outlineOpen) next.outlineOpen = false
        if (state.menu) next.menu = null
        patch(next)
        if (editorBridge.jumpTo) editorBridge.jumpTo(line)
      }

      /** 编辑器右键：记下行号与鼠标位置，弹出「定位到 PDF 位置」。 */
      var openMenu = function (line, event) {
        // 右键这一刻就把选中内容抓下来：菜单弹出后如果编辑器丢了选区
        //（重渲染、点空白、内核重排…），「发送选中内容」还有备份可用，不至于变成"失效"。
        var selection = null
        try {
          if (editorBridge.selection) selection = editorBridge.selection()
        } catch (error) { selection = null }
        patch({ menu: { x: event.clientX, y: event.clientY, line: line, selection: selection } })
      }

      var connection = connectionOf(store.root, store.workspaces)

      /** 发一行 `@文件:行范围 「选中的文字」`：引用在前，选中内容原样带上。 */
      var sendSelection = function () {
        try {
          var live = editorBridge.selection ? editorBridge.selection() : null
          var captured = store.menu && store.menu.selection
          // 优先当前选区；当前选区已经空了就用「右键那一刻」抓的备份
          var selection = (live && live.text && live.text.trim()) ? live
            : (captured && captured.text && captured.text.trim() ? captured : live)
          if (!selection || !(Number(selection.fromLine) > 0)) { patch({ syncNotice: '先把光标放到要引用的行' }); return }
          if (connection.state === 'none' || connection.state === 'conflict') {
            patch({ syncNotice: '项目不在 DSH 工作区里：先点右上「' + connection.text + '」连接，再发送' })
            return
          }
          var target = activeTab()
          var rel = target ? target.rel : 'tex'
          var range = selection.fromLine === selection.toLine
            ? ('第 ' + selection.fromLine + ' 行')
            : ('第 ' + selection.fromLine + '–' + selection.toLine + ' 行')
          var actions = injected(props).inputActions || null
          var mention = formatSelectionMention(rel, selection.fromLine, selection.toLine)
          var payload = formatSelectionCompact(rel, selection.fromLine, selection.toLine, selection.text)
          // 先试真 chip；不行再退回纯文本（异步：要等 React 把新草稿喂回来才能拿到新 rev）
          tryInsertReferenceChip(mention, actions, state.ctx, state.sessionId, function () {
            return store.inputSnap || null
          }, props).then(function (chip) {
            var result = chip && chip.ok
              ? { ok: true, how: 'chip 方框', report: '' }
              : insertIntoChatInput(payload, actions)
            if (result.ok) {
              patch({
                syncNotice: '已送入引用（' + rel + ' ' + range + ' · ' + result.how + '）'
                  + (chip && chip.ok ? '' : '｜chip 未成：' + ((chip && chip.why) || '未知'))
              })
              return
            }
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(payload)
            } catch (error) { /* 忽略 */ }
            patch({ syncNotice: '没找到输入框通道，已复制到剪贴板，粘贴到对话即可 ｜ 探测：' + result.report })
          }).catch(function (failure) {
            patch({ syncNotice: '发送选中内容失败：' + describe(failure) })
          })
        } catch (failure) {
          // 任何意外都要出声，不能点了没反应
          patch({ syncNotice: '发送选中内容失败：' + describe(failure) })
        }
      }

      // 点别处/Esc 关掉右键菜单
      React.useEffect(function () {
        if (!store.menu) return undefined
        var onDown = function () { patch({ menu: null }) }
        var onKey = function (event) { if (event.key === 'Escape') patch({ menu: null }) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [store.menu])

      // 编译方式下拉开着时，点别处/Esc 收起
      React.useEffect(function () {
        if (!store.compileMenu) return undefined
        var onDown = function () { patch({ compileMenu: false }) }
        var onKey = function (event) { if (event.key === 'Escape') patch({ compileMenu: false }) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [store.compileMenu])

      // 保存方式下拉：点别处 / Esc 关掉
      React.useEffect(function () {
        if (!store.saveMenu) return undefined
        var onDown = function () { patch({ saveMenu: false }) }
        var onKey = function (event) { if (event.key === 'Escape') patch({ saveMenu: false }) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [store.saveMenu])

      /** 编辑器右键：源码行 → PDF 页 + 坐标（双击不再触发，见右键菜单）。 */
      var forwardSync = function (line) {
        var target = activeTab()
        if (!target) { patch({ syncNotice: '先打开一个 tex 再定位' }); return }
        if (!line) return
        // 必须用「当前 tex 的同名 PDF」：一个项目里多个 tex 时，盲用上一次预览的
        // PDF 必然配错对，SyncTeX 会回 No tag / 跳到别的文件（踩过）。
        var pdf = pdfRelForTab(target, state.files, state.pdfRel)
        if (!pdf) {
          patch({ syncNotice: '当前 tex 还没编译出同名 PDF：先编译一次再定位' })
          return
        }
        patch({ syncBusy: 'forward', error: '', syncNotice: '正向定位：第 ' + line + ' 行 …' })
        api('synctex', {
          direction: 'forward', root: target.root, file: target.rel,
          pdf: pdf, line: line
        }).then(function (data) {
          if (!data || !data.success) {
            patch({ syncBusy: '', syncNotice: '正向定位失败：' + ((data && data.error) || '未知原因') })
            return
          }
          patch({
            syncBusy: '',
            pane: 'pdf',
            syncMark: { page: data.page, x: data.x, y: data.y },
            pdfFocusPage: data.page,
            syncNotice: '第 ' + line + ' 行 → 第 ' + data.page + ' 页'
          })
        }).catch(function (failure) {
          patch({ syncBusy: '', syncNotice: syncFailureText(failure) })
        })
      }

      /** 反向定位：点 PDF 某处 → 跳到对应源码行。 */
      var backwardSync = function (page, x, y) {
        var target = activeTab()
        // 不再静默返回：点了没反应最难查
        if (!target) { patch({ syncBusy: '', syncNotice: '先在左边打开一个 tex，再点 PDF 定位' }); return }
        var pdf = pdfRelForTab(target, state.files, state.pdfRel)
        if (!pdf) {
          patch({ syncBusy: '', syncNotice: '当前 tex 还没编译出同名 PDF：先编译一次，再点 PDF 定位' })
          return
        }
        patch({ syncBusy: 'backward', error: '', syncMark: { page: page, x: x, y: y } })
        api('synctex', {
          direction: 'backward', root: target.root, file: target.rel,
          pdf: pdf, page: page, x: x, y: y
        }).then(function (data) {
          if (!data || !data.success) {
            patch({ syncBusy: '', syncNotice: '反向定位失败：' + ((data && data.error) || '未知原因') })
            return
          }
          // SyncTeX 回的 file 可能是**同项目里的另一个 tex**（\input 进来的章节等）。
          // 以前只拿 line 去跳当前文件 → 跳到错位置还显示成功。现在按 file 切标签。
          var landed = relFromSynctexFile(target.root, data.file, state.files)
          if (landed && landed !== target.rel && /\.(tex|ltx|latex)$/i.test(landed)) {
            var line = data.line
            return openTab(target.root, landed).then(function () {
              var ready = Boolean(editorBridge.jumpTo)
              if (ready) jumpTo(line)
              patch({
                syncBusy: '',
                syncNotice: ready
                  ? ('PDF 第 ' + page + ' 页 → ' + landed + ' 第 ' + line + ' 行')
                  : ('定位到 ' + landed + ' 第 ' + line + ' 行，但编辑器还没就绪（再点一次）')
              })
            })
          }
          var ready = Boolean(editorBridge.jumpTo)
          if (ready) jumpTo(data.line)
          patch({
            syncBusy: '',
            syncNotice: ready
              ? ('PDF 第 ' + page + ' 页 → 源码第 ' + data.line + ' 行')
              : ('定位到源码第 ' + data.line + ' 行，但编辑器还没就绪（再点一次）')
          })
        }).catch(function (failure) {
          patch({ syncBusy: '', syncNotice: syncFailureText(failure) })
        })
      }

      // 提纲浮层开着时，换文件要跟着换内容
      React.useEffect(function () {
        if (store.outlineOpen && store.activeId) loadOutline()
      }, [store.activeId])

      // 切回窗口时刷新工作区列表（用户可能在左侧新建/删除了工作区）
      React.useEffect(function () {
        if (!store.root) return undefined
        var onFocus = function () {
          loadWorkspaces()
          syncExternalChanges()   // 窗口隐藏期间漏掉的改动，回来立刻补一次
        }
        window.addEventListener('focus', onFocus)
        return function () { window.removeEventListener('focus', onFocus) }
      }, [store.root])

      var toggleDir = function (path) {
        var expanded = Object.assign({}, store.expanded)
        expanded[path] = expanded[path] === false
        patch({ expanded: expanded })
        persist()
      }

      var filtered = store.filter.trim()
        ? store.files.filter(function (file) { return file.rel.toLowerCase().indexOf(store.filter.trim().toLowerCase()) >= 0 })
        : null

      // 抽屉自适应尺寸：行数定高、最长文件名定宽；再按左栏实际可用高度夹一次
      var treeBox = treeAutoSize({
        tree: store.tree,
        expanded: store.expanded,
        files: store.files,
        filter: store.filter
      })
      var leftRect = leftRef.current ? leftRef.current.getBoundingClientRect() : null
      var leftRoom = leftRect && leftRect.height > 0 ? leftRect.height - 16 : 0
      if (leftRoom > 0 && treeBox.height > leftRoom) treeBox.height = Math.round(leftRoom)

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
                  : '点顶栏「工作区…」切一个项目，或回「首页」用「打开文件夹…」（Ctrl+K）')

      return h('div', { style: Object.assign({}, S.root, { colorScheme: store.scheme }), 'data-moling': '1' },
        // 顶栏
        h('div', { style: S.bar },
          h('button', {
            style: S.btn,
            title: '返回启动页（最近打开的项目）',
            onClick: function () { patch({ view: 'welcome', treeOpen: false }) }
          }, '首页'),
          h('select', {
            // 顶栏下拉也统一到 24px 外高（S.select 本身还给右栏头部用，不改它）
            style: Object.assign({}, S.select, { boxSizing: 'border-box', height: 24, padding: '0 6px' }),
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
          // 分组一：树 + 提纲（都是编辑区左侧的浮层，开一个关另一个）
          h('span', { style: Object.assign({}, S.btnGroup, S.btnGroupBlue), 'data-btn-group': 'view' },
            h('button', {
              style: toggleBtnStyle(store.treeOpen),
              title: '文件树（浮在编辑区上）',
              onClick: function () {
                var next = !store.treeOpen
                // 文件树和提纲都浮在编辑区左侧，同时开会打架 → 开一个关另一个
                patch(next ? { treeOpen: true, outlineOpen: false } : { treeOpen: false })
                if (next && !store.tree && store.root) loadTree(store.root)
              }
            }, '文件树'),
            h('span', { style: S.btnSep, 'data-btn-sep': '1' }),
            h('button', {
              style: toggleBtnStyle(store.outlineOpen),
              disabled: !tab,
              title: '显示当前 tex 的标题提纲（左下角浮出）',
              onClick: function () {
                var next = !store.outlineOpen
                patch(next ? { outlineOpen: true, treeOpen: false } : { outlineOpen: false })
                if (next) loadOutline()
              }
            }, '文件大纲')),
          // 分组二：换行 / 保存 / 新建（编辑相关的小动作；日志/PDF 切换在底部状态栏最右）
          h('span', { style: Object.assign({}, S.btnGroup, S.btnGroupAmber), 'data-btn-group': 'edit' },
            h('button', {
              style: toggleBtnStyle(store.wrap),
              title: '软换行开关',
              onClick: function () { patch({ wrap: !store.wrap }); persist() }
            }, '换行'),
            h('span', { style: S.btnSep, 'data-btn-sep': '1' }),
            // 保存：分体按钮 —— 左边点一下立刻存（Ctrl+S 同效），右边小三角切「手动 / 自动」。
            // 三角与文字共用同一圈边框（边框挂在 saveSplitWrap 上，里面的按钮不再自带边框）。
            h('span', {
              style: Object.assign({}, S.saveSplitWrap, store.saveMode === 'auto' ? { borderColor: C.accent } : null)
            },
              h('button', {
                style: Object.assign({}, S.btnFlat, {
                  border: 0,
                  borderRadius: '5px 0 0 5px'
                }, store.saveMode === 'auto' ? { color: C.accent } : null),
                title: '保存当前 tex（Ctrl+S）。右边小三角切换 手动保存 / 自动保存',
                onClick: function () { if (tab) saveTab(tab.id) }
              }, store.saveMode === 'auto' ? '自动保存' : '手动保存'),
              h('button', {
                style: Object.assign({}, S.saveCaret, store.saveMenu ? S.splitCaretOn : null),
                title: '切换保存方式：手动保存 / 自动保存',
                onClick: function (event) {
                  event.stopPropagation()
                  patch({ saveMenu: !store.saveMenu, compileMenu: false })
                }
              }, '▾'),
              store.saveMenu
                ? h('div', {
                    style: S.saveMenu,
                    onMouseDown: function (event) { event.stopPropagation() }
                  }, SAVE_MODES.map(function (pair) {
                    return h('div', {
                      key: pair[0],
                      style: Object.assign({}, S.splitMenuItem, store.saveMode === pair[0] ? S.splitMenuItemOn : null),
                      onClick: function () {
                        var next = pair[0]
                        patch({ saveMode: next, saveMenu: false })
                        persist()
                        // 刚切到自动 + 当前有未保存改动 → 立刻存一次，别等下一次编辑
                        var live = activeTab()
                        if (next === 'auto' && live && live.dirty) saveTab(live.id)
                      }
                    }, (store.saveMode === pair[0] ? '✓ ' : '') + pair[1])
                  }))
                : null),
            h('span', { style: S.btnSep, 'data-btn-sep': '1' }),
            h('button', {
              style: Object.assign({}, S.btnFlat, store.busy === 'new' ? S.dimmed : null),
              disabled: store.busy === 'new',
              title: '在当前项目里新建一个 .tex（ctexart 骨架），Ctrl+N',
              onClick: function () { newDocument() }
            }, '新建'),
            h('span', { style: S.btnSep, 'data-btn-sep': '1' }),
            // 「自编」：自动编译开关（保存 / 外部同步之后自动编一次）
            h('button', {
              style: toggleBtnStyle(store.autoCompile),
              title: store.autoCompile
                ? '自动编译已开：保存或大模型改完文件后自动编一次（点一下关掉）'
                : '自动编译已关：点一下开启，保存 / 外部改动后自动编一次',
              onClick: function () {
                var next = store.autoCompile !== true
                if (!next && autoCompileTimer) { clearTimeout(autoCompileTimer); autoCompileTimer = null }
                patch({
                  autoCompile: next,
                  notice: next ? '自动编译已开启：保存或外部改动后自动编一次' : '自动编译已关闭',
                  noticeOk: true
                })
                persist()
              }
            }, '自编')),
          h('span', { style: S.spacer }),
          // 连接状态：项目是否已在左侧 DSH 工作区里打开（点一下连接/刷新）
          h('span', {
            style: Object.assign({}, S.linkPill, {
              color: connection.state === 'linked' ? C.ok : (connection.state === 'conflict' ? C.warn : C.sub),
              borderColor: connection.state === 'linked' ? C.ok : (connection.state === 'conflict' ? C.warn : C.line)
            }),
            title: connection.detail || '',
            onClick: function () {
              syncExternalChanges()   // 手动补一次同步（轮询万一没跑起来也能靠这一下）
              if (connection.state === 'linked') loadWorkspaces()
              else connectWorkspace()
            }
          },
            h('span', {
              style: Object.assign({}, S.linkDot, {
                background: connection.state === 'linked' ? C.ok : (connection.state === 'conflict' ? C.warn : C.idle)
              })
            }),
            connection.text),
          // 编译：一整块分体按钮 —— 左边 3/4 是「编译」（点一下就用当前方式编译），
          // 右边 1/4 是小三角，点开才列出三种方式（只切换方式，不触发编译）。
          h('span', { style: S.splitWrap },
            h('button', {
              style: Object.assign({}, S.splitMain, (!tab || store.busy === 'compile') ? S.dimmed : null),
              disabled: !tab || store.busy === 'compile',
              title: '点一下按「' + compileModeLabel(store.mode) + '」编译（F5 同效）；右边小三角改方式',
              onClick: compileActive
            }, store.busy === 'compile' ? '编译中…' : compileModeLabel(store.mode)),
            h('button', {
              style: Object.assign({}, S.splitCaret, store.compileMenu ? S.splitCaretOn : null),
              title: '选择编译方式',
              onClick: function (event) {
                event.stopPropagation()
                patch({ compileMenu: !store.compileMenu, saveMenu: false })
              }
            }, '▾'),
            store.compileMenu
              ? h('div', {
                  style: S.splitMenu,
                  onMouseDown: function (event) { event.stopPropagation() }
                }, COMPILE_MODES.map(function (pair) {
                  return h('div', {
                    key: pair[0],
                    style: Object.assign({}, S.splitMenuItem, store.mode === pair[0] ? S.splitMenuItemOn : null),
                    title: pair[1],
                    onClick: function () {
                      patch({ mode: pair[0], compileMenu: false })
                      persist()
                    }
                  }, (store.mode === pair[0] ? '✓ ' : '') + pair[1])
                }))
              : null)
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
            h('div', { style: S.editorWrap, className: 'ml-editor' },
              h(EditorArea, { tab: tab, store: store, onMenu: openMenu })),

            // 「提纲」浮层：从编辑区左下角浮出，点标题跳到对应源码行
            store.outlineOpen
              ? h('div', { style: S.outlinePanel },
                  h('div', { style: S.outlineHead },
                    h('span', { style: { fontWeight: 500 } }, '文件大纲'),
                    store.outline && store.outline.sections
                      ? h('span', { style: { color: C.sub, fontSize: 10.5 } }, store.outline.sections.length + ' 节')
                      : null,
                    h('span', { style: S.spacer }),
                    h('span', {
                      style: S.tabClose,
                      title: '关闭',
                      onClick: function () { patch({ outlineOpen: false }) }
                    }, '×')),
                  h('div', { style: S.outlineList },
                    store.outlineBusy === 'outline'
                      ? h('div', { style: Object.assign({}, S.hint, { padding: 8 }) }, '解析中…')
                      : (store.outline && store.outline.sections && store.outline.sections.length
                        ? store.outline.sections.map(function (item, index) {
                            return h('div', {
                              key: index,
                              style: Object.assign({}, S.outlineItem, { paddingLeft: 8 + (Math.max(1, item.level) - 1) * 10 }),
                              title: '\\' + item.command + ' · 第 ' + item.line + ' 行',
                              onClick: function () { jumpTo(item.line) }
                            },
                              h('span', { style: S.outlineTitle }, item.title || '(无标题)'),
                              h('span', { style: S.outlineNum }, item.line))
                          })
                        : h('div', { style: Object.assign({}, S.hint, { padding: 8 }) },
                            store.outline ? '这个文件里没有 \\section 之类的章节命令' : '点「文件大纲」读取')))
                )
              : null,

            // 悬浮文件树（右边框可拖动；尺寸自适应，拖过之后记像素宽）
            store.treeOpen
              ? h('div', { style: S.overlay },
                  h('div', {
                    style: Object.assign({}, S.drawer, {
                      width: (store.treeW > 0 ? store.treeW : treeBox.width) + 'px',
                      height: treeBox.height + 'px',
                      // 空目录/读取中时别缩成一条缝，至少留两行位置给提示文字
                      minHeight: (TREE_HEAD_H + TREE_LIST_PAD + TREE_ROW_H * 2) + 'px',
                      // 文件多到装不下时才让列表内部滚动，抽屉本身不超出编辑区
                      maxWidth: 'calc(100% - 16px)',
                      maxHeight: 'calc(100% - 16px)'
                    })
                  },
                    h('div', { style: S.drawerHead },
                      h('span', { style: { fontWeight: 500 } }, '文件'),
                      store.files.length
                        ? h('span', { style: { color: C.sub, fontSize: 10.5 } }, store.files.length + ' 个')
                        : null,
                      h('input', {
                        style: Object.assign({}, S.input, {
                          flex: 1, minWidth: 0, width: 'auto', padding: '1px 6px', fontSize: 11
                        }),
                        placeholder: '过滤…',
                        value: store.filter,
                        autoFocus: true,
                        onChange: function (event) { patch({ filter: event.target.value }) }
                      }),
                      h('span', {
                        style: S.tabClose,
                        title: '关闭',
                        onClick: function () { patch({ treeOpen: false }) }
                      }, '×')
                    ),
                    h('div', { style: S.drawerList }, treeContent),
                    store.truncated ? h('div', { style: Object.assign({}, S.hint, { padding: '0 8px 6px' }) }, '文件过多，已截断') : null,
                    h('div', {
                      style: S.hsplit,
                      onMouseDown: startTreeDrag,
                      onDoubleClick: function () { patch({ treeW: 0 }); persist() },
                      title: '拖动调整宽度（双击恢复自适应）'
                    })
                  ),
                  h('div', { style: S.backdrop, onClick: function () { patch({ treeOpen: false }) } })
                )
              : null
          ),

          // 可拖动的左右分隔条
          h('div', { style: S.vsplit, onMouseDown: startSplitDrag, title: '拖动调整 tex / pdf 宽度' }),

          h('div', { style: Object.assign({}, S.right, { width: (store.split * 100).toFixed(1) + '%' }) },
            h('div', { style: S.rightHead },
              h('span', { style: S.spacer }),
              h('select', { style: S.select, value: store.engine, title: '引擎', onChange: function (event) { patch({ engine: event.target.value }); persist() } },
                ['auto', 'xelatex', 'pdflatex', 'lualatex', 'latexmk'].map(function (name) {
                  return h('option', { key: name, value: name }, name)
                })),
              h('button', { style: S.btn, disabled: !tab, onClick: cleanActive, title: '删除 .aux/.log 等辅助文件' }, '清理'),
              // 缩放按钮：Ctrl+滚轮之外再给一条可靠路径（有些环境把 Ctrl+滚轮吃掉做页面缩放）
              h('button', {
                style: S.btn,
                title: '缩小预览（Ctrl + 滚轮也可以）',
                onClick: function () { patch({ pdfZoom: clamp((store.pdfZoom || 1) / 1.2, 0.5, 3) }); persist() }
              }, '－'),
              h('button', {
                style: Object.assign({}, S.btn, { minWidth: 40 }),
                title: '点一下回到 100%',
                onClick: function () { patch({ pdfZoom: 1 }); persist() }
              }, Math.round((store.pdfZoom || 1) * 100) + '%'),
              h('button', {
                style: S.btn,
                title: '放大预览（Ctrl + 滚轮也可以）',
                onClick: function () { patch({ pdfZoom: clamp((store.pdfZoom || 1) * 1.2, 0.5, 3) }); persist() }
              }, '＋'),
              // 一键适应：量预览区可视宽高 → 整页（宽+高）刚好放进窗口，任何窗口大小都适用
              h('button', {
                style: Object.assign({}, S.btn, (!tab || store.pane !== 'pdf' || !store.pdfRel) ? S.dimmed : null),
                disabled: !tab || store.pane !== 'pdf' || !store.pdfRel,
                title: '整页适应当前窗口（按预览区可视宽高自动算比例）',
                onClick: function () {
                  var zoom = 1
                  try {
                    var scroll = document.querySelector('.ml-pdf-scroll')
                    if (scroll) {
                      var style = window.getComputedStyle(scroll)
                      var contentW = scroll.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
                      var contentH = scroll.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)
                      zoom = fitZoomFor(contentW, contentH, store.pdfPageSize)
                    }
                  } catch (error) { zoom = 1 }
                  patch({ pdfZoom: zoom })
                  persist()
                }
              }, '适应'),
              h('select', {
                style: Object.assign({}, S.select, { maxWidth: 66 }),
                value: String(store.pdfDpi),
                title: '预览清晰度：低 72dpi / 中 96dpi / 高 144dpi（越低越省，纯看版式用「低」）',
                onChange: function (event) { patch({ pdfDpi: Number(event.target.value) }); persist() }
              }, DPI_CHOICES.map(function (choice) {
                return h('option', { key: choice.value, value: String(choice.value) }, choice.label)
              })),
              store.pdfRel ? h('a', {
                href: '#',
                title: '把整份 PDF 在新标签打开（会临时取一次完整文件）',
                style: { color: C.accent, fontSize: 11, textDecoration: 'none' },
                onClick: function (event) {
                  event.preventDefault()
                  var win = window.open('', '_blank')
                  loadPdfBlob().then(function () {
                    if (state.pdfUrl && win) win.location.href = state.pdfUrl
                    else if (win) win.close()
                  })
                }
              }, '新标签') : null
            ),
            store.pane === 'log'
              ? h('div', { style: S.pane }, h(LogPane, { log: store.log, onJump: jumpTo }))
              : h('div', { style: Object.assign({}, S.pane, { padding: 0, background: C.layer1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }) },
                  h(PdfPane, { store: store, onPick: backwardSync })),
            // 编译结果挪到底部状态栏（居中 + 绿/红），这里只保留详细错误
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
          // 自动同步指示灯：绿 = 通道通、红 = 失败（悬停看原因）、灰 = 还没跑起来
          h('span', {
            title: store.syncOk === false
              ? '自动同步失败：' + (store.syncError || '未知原因')
              : (store.syncOk === true ? '自动同步正常：每 2 秒把磁盘上的改动拉进编辑区' : '自动同步还没跑起来'),
            style: { color: store.syncOk === true ? C.ok : (store.syncOk === false ? C.err : C.sub) }
          }, '同步' + (store.syncOk === true ? '●' : (store.syncOk === false ? '✗' : '…'))),
          store.status && store.status.found
            ? h('span', { title: store.status.binDir }, 'TeX')
            : h('span', { style: { color: C.warn } }, '无 TeX'),
          tab ? h('span', { style: { fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis' } }, tab.rel) : null,
          h('span', { style: S.spacer }),
          // 日志 / PDF 切换：状态栏最右边
          h('span', {
            style: Object.assign({}, S.paneTab, store.pane === 'log' ? S.paneTabOn : null),
            title: '看编译日志',
            onClick: function () { patch({ pane: 'log' }); persist() }
          }, '日志' + (store.log && store.log.errors && store.log.errors.length ? ' (' + store.log.errors.length + ')' : '')),
          h('span', {
            style: Object.assign({}, S.paneTab, store.pane === 'pdf' ? S.paneTabOn : null),
            title: '看 PDF 预览',
            onClick: function () { patch({ pane: 'pdf' }); persist() }
          }, 'PDF'),
          visible ? null : h('span', { style: { opacity: 0.7 } }, '后台'),
          // 居中的结果条（绝对定位，不挤占左右两侧）：编译成功绿、失败红；
          // 没有编译结果时退而显示 SyncTeX 定位信息（灰色）
          (store.notice || store.syncNotice)
            ? h('span', {
                style: Object.assign({}, S.statusNotice, {
                  color: store.notice ? (store.noticeOk ? C.ok : C.err) : C.sub
                }),
                title: store.notice || store.syncNotice
              }, store.notice || store.syncNotice)
            : null
        ),

        // 编辑器右键菜单：基础编辑功能 + 源码行 → PDF 位置
        store.menu
          ? h('div', {
              style: Object.assign({}, S.menu, menuPosition(store.menu)),
              onMouseDown: function (event) { event.stopPropagation() }
            },
              CONTEXT_ITEMS.map(function (item) {
                if (item.separator) {
                  return h('div', { key: item.key, style: S.menuSep })
                }
                return h('div', {
                  key: item.key,
                  style: S.menuItem,
                  title: item.hint || '',
                  onClick: function () {
                    var line = store.menu.line
                    patch({ menu: null })
                    if (item.action === 'locate') { forwardSync(line); return }
                    if (item.action === 'send') { sendSelection(); return }
                    if (editorBridge.run) editorBridge.run(item.action)
                  }
                }, item.action === 'locate'
                  ? (item.label + '（第 ' + store.menu.line + ' 行）')
                  : (item.label + (item.hint ? '    ' + item.hint : '')))
              }))
          : null
      )
    }

    /* ------------------------------------------------------------------ *
     * 注册：右侧栏标签类型 + 正文
     * ------------------------------------------------------------------ */

    // sessions 必须显式声明：不写进 inject 的话 ctx.get('sessions') 拿不到服务，
    // 也就发不出 slash/input-insert-reference（chip 那一步会静默失败）。
    var inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions']

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
    // 会话隔离：切会话 + 当前会话 id + 分片表（自测直接演「A 进项目 → 切 B → 切回 A」）
    exports.__switchSession = switchSession
    exports.__currentSession = function () { return currentSession }
    exports.__sessionShards = function () { return sessionShards }
    exports.__SESSION_FIELDS = SESSION_FIELDS
    // 供离线自测直接验证词法与路径拼接（不依赖浏览器）
    exports.__tokenize = highlightDocument
    exports.__buildHighlight = buildHighlight
    exports.__absolutePath = absolutePath
    exports.__recentAbsolute = recentAbsolute
    exports.__pickMainTex = pickMainTex
    // 文件树抽屉自适应尺寸（高度看行数、宽度看最长文件名）
    exports.__treeAutoSize = treeAutoSize
    exports.__treeTextWidth = treeTextWidth
    // SyncTeX：按当前 tex 选同名 PDF（不盲用上一次预览的 PDF）+ 反向定位按 file 切标签
    exports.__pdfRelForTab = pdfRelForTab
    exports.__relFromSynctexFile = relFromSynctexFile
    // PDF 预览：单页图片地址与清晰度档位（自测里验证 URL 拼装与档位一致性）
    exports.__pdfPageUrl = pdfPageUrl
    exports.__DPI_CHOICES = DPI_CHOICES
    // 编辑器：内核地址、回退编辑器与区域组件（自测直接渲染它们，不需要真 DOM）
    exports.__kernelAssetUrl = kernelAssetUrl
    exports.__LegacyEditor = LegacyEditor
    exports.__EditorArea = EditorArea
    exports.__editorBridge = editorBridge
    exports.__syncPercent = syncPercent
    exports.__fitZoomFor = fitZoomFor
    exports.__COMPILE_MODES = COMPILE_MODES
    exports.__parseOutlineText = parseOutlineText
    exports.__connectionOf = connectionOf
    exports.__formatSelectionPayload = formatSelectionPayload
    exports.__formatSelectionCompact = formatSelectionCompact
    exports.__formatSelectionMention = formatSelectionMention
    exports.__normalizePath = normalizePath
    // 模板库：清单拉取与「按模板落地」（自测用假 fetch 打桩验证）
    exports.__loadTemplates = loadTemplates
    exports.__newFromTemplate = newFromTemplate
    exports.__filterTemplates = filterTemplates
    // 模板库二级弹窗：入口 / 关闭 / 选模板 / 选存放目录 / 创建
    exports.__openTemplates = openTemplates
    exports.__closeTemplates = closeTemplates
    exports.__pickTemplate = pickTemplate
    exports.__pickTemplateTarget = pickTemplateTarget
    exports.__createFromTemplate = createFromTemplate
    // LaTeX 自动补全：纯函数补全源（自测直接喂文本 + 光标位）
    exports.__completeLatex = completeLatex
    exports.__scanCommandArgs = scanCommandArgs
    exports.__LATEX_COMMANDS = LATEX_COMMANDS
    exports.__LATEX_ENVIRONMENTS = LATEX_ENVIRONMENTS
    exports.__LATEX_PACKAGES = LATEX_PACKAGES
    // 切项目文件夹：同步关闭上一个项目打开的 tex 标签与 PDF/日志（自测直接调）
    exports.__closeProjectFiles = closeProjectFiles
    exports.__enterRoot = enterRoot
    // 外部改动同步：轮询本体与版本戳（自测里用假 fetch 打桩验证）
    exports.__syncExternalChanges = syncExternalChanges
    // 自测诊断：同步为什么被跳过（进项目闸门 / 上一轮没回来）
    exports.__syncProbe = function () {
      return { enteringRoot: enteringRoot, watchBusy: watchBusy, started: watchStartedAt, busyMs: watchBusy ? Date.now() - watchStartedAt : 0 }
    }
    exports.__stampOf = function (rel) { return stamps[rel] }
    exports.__treeSignature = function () { return treeSignature }
    // 「改动行标绿」：diff 是纯函数，自测直接验区间算法；flash 用假 DOM 验涂/摘
    exports.__diffLineRanges = diffLineRanges
    exports.__queueFlash = queueFlash
    exports.__takeFlash = takeFlash
    exports.__startFlash = startFlash
    exports.__clearFlash = clearFlash
    exports.__FLASH_GREEN = FLASH_GREEN
    // 同步观感：整篇替换前后保住视口位置；以及「DOM 行 → 行号」的换算
    exports.__captureViewport = captureViewport
    exports.__restoreViewport = restoreViewport
    exports.__lineReaderFor = lineReaderFor
    // 自测用：确认面板有错误兜底（渲染/副作用抛异常时画出来，而不是整块空白）
    exports.__hasBoundary = typeof PaneBoundary === 'function'
    return module.exports
  }
})

/* ===== 编辑器内核（CodeMirror 6 构建产物，勿手改；重建见 lib/vendor/BUILD.md） ===== */
;(()=>{var ye=(n,e,t)=>()=>{if(t)throw t[0];try{return n&&(e=n(n=0)),e}catch(i){throw t=[i],i}};var pd=(n,e)=>()=>{try{return e||n((e={exports:{}}).exports,e),e.exports}catch(t){throw e=0,t}};function md(n){if(n<768)return!1;for(let e=0,t=yr.length;;){let i=e+t>>1;if(n<yr[i])t=i;else if(n>=xa[i])e=i+1;else return!0;if(e==t)return!1}}function ga(n){return n>=127462&&n<=127487}function wa(n,e,t=!0,i=!0){return(t?ka:gd)(n,e,i)}function ka(n,e,t){if(e==n.length)return e;e&&va(n.charCodeAt(e))&&Sa(n.charCodeAt(e-1))&&e--;let i=gr(n,e);for(e+=ba(i);e<n.length;){let s=gr(n,e);if(i==ya||s==ya||t&&md(s))e+=ba(s),i=s;else if(ga(s)){let r=0,o=e-2;for(;o>=0&&ga(gr(n,o));)r++,o-=2;if(r%2==0)break;e+=2}else break}return e}function gd(n,e,t){for(;e>1;){let i=ka(n,e-2,t);if(i<e)return i;e--}return 0}function gr(n,e){let t=n.charCodeAt(e);if(!Sa(t)||e+1==n.length)return t;let i=n.charCodeAt(e+1);return va(i)?(t-55296<<10)+(i-56320)+65536:t}function va(n){return n>=56320&&n<57344}function Sa(n){return n>=55296&&n<56320}function ba(n){return n<65536?1:2}var yr,xa,ya,Ca=ye(()=>{yr=[],xa=[];(()=>{let n="lc,34,7n,7,7b,19,,,,2,,2,,,20,b,1c,l,g,,2t,7,2,6,2,2,,4,z,,u,r,2j,b,1m,9,9,,o,4,,9,,3,,5,17,3,1n,9,16,o,,x,1i,3,,i,,7,a,2,t,3,1k,,,7,2,2,2,3,9,,a,2,q,,2,3,1k,,,5,4,2,2,3,3,,u,2,3,,b,3,1k,,,8,,3,,3,k,2,m,6,,3,1k,,,7,2,2,2,3,7,3,a,2,u,,1n,5,3,3,,4,9,,14,5,1j,,,7,,3,,4,7,2,b,2,t,3,1k,,,7,,3,,4,7,2,b,2,f,,c,4,1j,2,,7,,3,,4,9,,a,2,t,3,1y,,4,6,,,,8,i,2,1p,,,8,c,8,2q,,,a,b,7,21,2,r,,,,,,4,2,1d,k,,2,5,b,,10,9,,2u,b,,6,n,4,4,3,g,4,d,,,3,6,,f,,jj,3,qa,4,s,3,t,2,u,2,1s,w,9,,19,3,,,39,2,y,,3a,c,4,c,63,5,1l,a,,,,,2,o,2,,1c,1a,2,c,k,5,1b,h,12,9,c,3,u,d,1k,e,1c,k,48,3,,l,4,,6,,2,3,5i,1s,ek,,5f,x,2da,3,3x,,2o,w,fe,6,2x,2,n9w,4,,a,w,2,28,2,7k,,3,,4,,n,5,4,,2b,2,1e,i,q,i,d,,12,8,p,d,18,4,1b,e,10,,1v,e,c,,8,2,1a,,1f,,,3,2,2,5,2,,,15,5,5,2,6k,8,,2,fn4,,kh,g,g,g,a6,2,gt,,6a,,45,5,1ae,3,,2,5,4,14,3,4,,4l,2,fx,4,1t,5,8t,2,25,6,1y,b,1d,4,3e,3,1h,f,15,,2,2,a,4,19,b,7,,1p,3,10,e,g,2,18,,c,3,1c,e,8,4,,2,2k,c,6,,2,,4d,c,l,4,1j,2,,7,2,2,2,3,9,,a,2,2,7,3,5,1v,9,,,2,,,4,,5,,,e,2,2a,i,n,,29,k,6j,7,2,9,r,2,2a,h,2y,d,2t,3,2,a,74,f,6t,6,,2,2,4,,,,2,3x,7,2,7,3,,s,a,14,7,,4,8,,9,b,1a,g,5i,8,5j,8,,8,2a,m,,e,3e,6,3,,,2,,7,,,1u,5,,2,,5,9n,4,9,2,,,1c,7,3,5,n,,44l,,6,f,8ug,i,1xc,5,1n,7,t4,,,1j,7,4,29,,b,2,f57,2,3mp,1a,2,n,f2,5,3,6,8,8,2,7,u,4,44,3,1iz,1j,4,1e,8,,e,,m,5,,f,11s,7,,h,2,7,,2,,5,2s,,4g,7,af,,1p,4,e4,4,72,2,6r,,2,,7,2,5,,d6,7,31,7,240,5".split(",").map(e=>e?parseInt(e,36):1);for(let e=0,t=0;e<n.length;e++)(e%2?xa:yr).push(t=t+n[e])})();ya=8205});function yd(n){let e=-1;for(let t of n)e+=t.length+1;return e}function In(n,e,t=0,i=1e9){for(let s=0,r=0,o=!0;r<n.length&&s<=i;r++){let l=n[r],a=s+l.length;a>=t&&(a>i&&(l=l.slice(0,i-s)),s<t&&(l=l.slice(t-s)),o?(e[e.length-1]+=l,o=!1):e.push(l)),s=a+1}return e}function Aa(n,e,t){return In(n,[""],e,t)}function oi(n,e,t){return e=Math.max(0,Math.min(n.length,e)),[e,Math.max(e,Math.min(n.length,t))]}function ee(n,e,t=!0,i=!0){return wa(n,e,t,i)}function bd(n){return n>=56320&&n<57344}function xd(n){return n>=55296&&n<56320}function ae(n,e){let t=n.charCodeAt(e);if(!xd(t)||e+1==n.length)return t;let i=n.charCodeAt(e+1);return bd(i)?(t-55296<<10)+(i-56320)+65536:t}function Vi(n){return n<=65535?String.fromCharCode(n):(n-=65536,String.fromCharCode((n>>10)+55296,(n&1023)+56320))}function Oe(n){return n<65536?1:2}function ue(n,e,t,i=!1){if(e==0&&t<=0)return;let s=n.length-2;s>=0&&t<=0&&t==n[s+1]?n[s]+=e:s>=0&&e==0&&n[s]==0?n[s+1]+=t:i?(n[s]+=e,n[s+1]+=t):n.push(e,t)}function yt(n,e,t){if(t.length==0)return;let i=e.length-2>>1;if(i<n.length)n[n.length-1]=n[n.length-1].append(t);else{for(;n.length<i;)n.push(N.empty);n.push(t)}}function kr(n,e,t){let i=n.inserted;for(let s=0,r=0,o=0;o<n.sections.length;){let l=n.sections[o++],a=n.sections[o++];if(a<0)s+=l,r+=l;else{let h=s,c=r,f=N.empty;for(;h+=l,c+=a,a&&i&&(f=f.append(i[o-2>>1])),!(t||o==n.sections.length||n.sections[o+1]<0);)l=n.sections[o++],a=n.sections[o++];e(s,h,r,c,f),s=h,r=c}}}function vr(n,e,t,i=!1){let s=[],r=i?[]:null,o=new Ft(n),l=new Ft(e);for(let a=-1;;){if(o.done&&l.len||l.done&&o.len)throw new Error("Mismatched change set lengths");if(o.ins==-1&&l.ins==-1){let h=Math.min(o.len,l.len);ue(s,h,-1),o.forward(h),l.forward(h)}else if(l.ins>=0&&(o.ins<0||a==o.i||o.off==0&&(l.len<o.len||l.len==o.len&&!t))){let h=l.len;for(ue(s,l.ins,-1);h;){let c=Math.min(o.len,h);o.ins>=0&&a<o.i&&o.len<=c&&(ue(s,0,o.ins),r&&yt(r,s,o.text),a=o.i),o.forward(c),h-=c}l.next()}else if(o.ins>=0){let h=0,c=o.len;for(;c;)if(l.ins==-1){let f=Math.min(c,l.len);h+=f,c-=f,l.forward(f)}else if(l.ins==0&&l.len<c)c-=l.len,l.next();else break;ue(s,h,a<o.i?o.ins:0),r&&a<o.i&&yt(r,s,o.text),a=o.i,o.forward(o.len-c)}else{if(o.done&&l.done)return r?be.createSet(s,r):ht.create(s);throw new Error("Mismatched change set lengths")}}}function Ba(n,e,t=!1){let i=[],s=t?[]:null,r=new Ft(n),o=new Ft(e);for(let l=!1;;){if(r.done&&o.done)return s?be.createSet(i,s):ht.create(i);if(r.ins==0)ue(i,r.len,0,l),r.next();else if(o.len==0&&!o.done)ue(i,0,o.ins,l),s&&yt(s,i,o.text),o.next();else{if(r.done||o.done)throw new Error("Mismatched change set lengths");{let a=Math.min(r.len2,o.len),h=i.length;if(r.ins==-1){let c=o.ins==-1?-1:o.off?0:o.ins;ue(i,a,c,l),s&&c&&yt(s,i,o.text)}else o.ins==-1?(ue(i,r.off?0:r.len,a,l),s&&yt(s,i,r.textBit(a))):(ue(i,r.off?0:r.len,o.off?0:o.ins,l),s&&!o.off&&yt(s,i,o.text));l=(r.ins>a||o.ins>=0&&o.len>a)&&(l||i.length>h),r.forward2(a),o.forward(a)}}}}function La(n,e){for(let t of n.ranges)if(t.to>e)throw new RangeError("Selection points outside of document")}function Rr(n,e){return n==e||n.length==e.length&&n.every((t,i)=>t===e[i])}function Ma(n,e,t){if(n.length!=e.length)return!1;for(let i=0;i<n.length;i++)if(!t(n[i],e[i]))return!1;return!0}function Sr(n,e){let t=!1;for(let i of e)Ni(n,i)&1&&(t=!0);return t}function wd(n,e,t){let i=t.map(a=>n[a.id]),s=t.map(a=>a.type),r=i.filter(a=>!(a&1)),o=n[e.id]>>1;function l(a){let h=[];for(let c=0;c<i.length;c++){let f=Vn(a,i[c]);if(s[c]==2)for(let u of f)h.push(u);else h.push(f)}return e.combine(h)}return{create(a){for(let h of i)Ni(a,h);return a.values[o]=l(a),1},update(a,h){if(!Sr(a,r))return 0;let c=l(a);return e.compare(c,a.values[o])?0:(a.values[o]=c,1)},reconfigure(a,h){let c=Sr(a,i),f=h.config.facets[e.id],u=h.facet(e);if(f&&!c&&Rr(t,f))return a.values[o]=u,0;let d=l(a);return e.compare(d,u)?(a.values[o]=u,0):(a.values[o]=d,1)}}}function Ii(n){return e=>new Hn(e,n)}function kd(n,e,t){let i=[[],[],[],[],[]],s=new Map;function r(o,l){let a=s.get(o);if(a!=null){if(a<=l)return;let h=i[a].indexOf(o);h>-1&&i[a].splice(h,1),o instanceof Fi&&t.delete(o.compartment)}if(s.set(o,l),Array.isArray(o))for(let h of o)r(h,l);else if(o instanceof Fi){if(t.has(o.compartment))throw new RangeError("Duplicate use of compartment in extensions");let h=e.get(o.compartment)||o.inner;t.set(o.compartment,h),r(h,l)}else if(o instanceof Hn)r(o.inner,o.prec);else if(o instanceof Q)i[l].push(o),o.provides&&r(o.provides,l);else if(o instanceof si)i[l].push(o),o.facet.extensions&&r(o.facet.extensions,Pt.default);else{let h=o.extension;if(!h)throw new Error(`Unrecognized extension value in extension set (${o}).`);if(h==o)throw new Error(`Unrecognized extension value in extension set (${o}). This sometimes happens because multiple instances of @codemirror/state are loaded, breaking instanceof checks.`);r(h,l)}}return r(n,Pt.default),i.reduce((o,l)=>o.concat(l))}function Ni(n,e){if(e&1)return 2;let t=e>>1,i=n.status[t];if(i==4)throw new Error("Cyclic dependency between fields and/or facets");if(i&2)return i;n.status[t]=4;let s=n.computeSlot(n,n.config.dynamicSlots[t]);return n.status[t]=2|s}function Vn(n,e){return e&1?n.config.staticValues[e>>1]:n.values[e>>1]}function vd(n,e){let t=[];for(let i=0,s=0;;){let r,o;if(i<n.length&&(s==e.length||e[s]>=n[i]))r=n[i++],o=n[i++];else if(s<e.length)r=e[s++],o=e[s++];else return t;!t.length||t[t.length-1]<r?t.push(r,o):t[t.length-1]<o&&(t[t.length-1]=o)}}function Ha(n,e,t){var i;let s,r,o;return t?(s=e.changes,r=be.empty(e.changes.length),o=n.changes.compose(e.changes)):(s=e.changes.map(n.changes),r=n.changes.mapDesc(e.changes,!0),o=n.changes.compose(s)),{changes:o,selection:e.selection?e.selection.map(r):(i=n.selection)===null||i===void 0?void 0:i.map(s),effects:L.mapEffects(n.effects,s).concat(L.mapEffects(e.effects,r)),annotations:n.annotations.length?n.annotations.concat(e.annotations):e.annotations,scrollIntoView:n.scrollIntoView||e.scrollIntoView}}function Tr(n,e,t){let i=e.selection,s=ri(e.annotations);return e.userEvent&&(s=s.concat(te.userEvent.of(e.userEvent))),{changes:e.changes instanceof be?e.changes:be.of(e.changes||[],t,n.facet(Ra)),selection:i&&(i instanceof b?i:b.single(i.anchor,i.head)),effects:ri(e.effects),annotations:s,scrollIntoView:!!e.scrollIntoView}}function Wa(n,e,t){let i=Tr(n,e.length?e[0]:{},n.doc.length);e.length&&e[0].filter===!1&&(t=!1);for(let r=1;r<e.length;r++){e[r].filter===!1&&(t=!1);let o=!!e[r].sequential;i=Ha(i,Tr(n,e[r],o?i.changes.newLength:n.doc.length),o)}let s=te.create(n,i.changes,i.selection,i.effects,i.annotations,i.scrollIntoView);return Cd(t?Sd(s):s)}function Sd(n){let e=n.startState,t=!0;for(let s of e.facet(Pa)){let r=s(n);if(r===!1){t=!1;break}Array.isArray(r)&&(t=t===!0?r:vd(t,r))}if(t!==!0){let s,r;if(t===!1)r=n.changes.invertedDesc,s=be.empty(e.doc.length);else{let o=n.changes.filter(t);s=o.changes,r=o.filtered.mapDesc(o.changes).invertedDesc}n=te.create(e,s,n.selection&&n.selection.map(r),L.mapEffects(n.effects,r),n.annotations,n.scrollIntoView)}let i=e.facet(Ia);for(let s=i.length-1;s>=0;s--){let r=i[s](n);r instanceof te?n=r:Array.isArray(r)&&r.length==1&&r[0]instanceof te?n=r[0]:n=Wa(e,ri(r),!1)}return n}function Cd(n){let e=n.startState,t=e.facet(Na),i=n;for(let s=t.length-1;s>=0;s--){let r=t[s](n);r&&Object.keys(r).length&&(i=Ha(i,Tr(e,r,n.changes.newLength),!0))}return i==n?n:te.create(e,n.changes,n.selection,i.effects,i.annotations,i.scrollIntoView)}function ri(n){return n==null?Ad:Array.isArray(n)?n:[n]}function Td(n){if(Dr)return Dr.test(n);for(let e=0;e<n.length;e++){let t=n[e];if(/\w/.test(t)||t>"\x80"&&(t.toUpperCase()!=t.toLowerCase()||Md.test(t)))return!0}return!1}function Dd(n){return e=>{if(!/\S/.test(e))return $.Space;if(Td(e))return $.Word;for(let t=0;t<n.length;t++)if(e.indexOf(n[t])>-1)return $.Word;return $.Other}}function pe(n,e,t={}){let i={};for(let s of n)for(let r of Object.keys(s)){let o=s[r],l=i[r];if(l===void 0)i[r]=o;else if(!(l===o||o===void 0))if(Object.hasOwnProperty.call(t,r))i[r]=t[r](l,o);else throw new Error("Config merge conflict for field "+r)}for(let s in e)i[s]===void 0&&(i[s]=e[s]);return i}function Pr(n,e){return n==e||n.constructor==e.constructor&&n.eq(e)}function Or(n,e){return n.from-e.from||n.value.startSide-e.value.startSide}function ii(n){return n[n.length-1]}function Od(n){if(n.length>1)for(let e=n[0],t=1;t<n.length;t++){let i=n[t];if(Or(e,i)>0)return n.slice().sort(Or);e=i}return n}function Ta(n,e,t){let i=new Map;for(let r of n)for(let o=0;o<r.chunk.length;o++)r.chunk[o].maxPoint<=0&&i.set(r.chunk[o],r.chunkPos[o]);let s=new Set;for(let r of e)for(let o=0;o<r.chunk.length;o++){let l=i.get(r.chunk[o]);l!=null&&(t?t.mapPos(l):l)==r.chunkPos[o]&&!t?.touchesRange(l,l+r.chunk[o].length)&&s.add(r.chunk[o])}return s}function br(n,e){for(let t=n[e];;){let i=(e<<1)+1;if(i>=n.length)break;let s=n[i];if(i+1<n.length&&s.compare(n[i+1])>=0&&(s=n[i+1],i++),t.compare(s)<0)break;n[i]=t,n[e]=s,e=i}}function Da(n,e,t,i,s,r){n.goto(e),t.goto(i);let o=i+s,l=i,a=i-e,h=!!r.boundChange;for(let c=!1;;){let f=n.to+a-t.to,u=f||n.endSide-t.endSide,d=u<0?n.to+a:t.to,p=Math.min(d,o);if(n.point||t.point?(n.point&&t.point&&Pr(n.point,t.point)&&Lr(n.activeForPoint(n.to),t.activeForPoint(t.to))||r.comparePoint(l,p,n.point,t.point),c=!1):(c&&(r.boundChange(l),c=!1),p>l&&!Lr(n.active,t.active)&&r.compareRange(l,p,n.active,t.active),h&&p<o&&(f||n.openEnd(d)!=t.openEnd(d))&&(c=!0)),d>o)break;l=d,u<=0&&n.next(),u>=0&&t.next()}}function Lr(n,e){if(n.length!=e.length)return!1;for(let t=0;t<n.length;t++)if(n[t]!=e[t]&&!Pr(n[t],e[t]))return!1;return!0}function Rn(n,e){for(let t=e,i=n.length-1;t<i;t++)n[t]=n[t+1];n.pop()}function Pn(n,e,t){for(let i=n.length-1;i>=e;i--)n[i+1]=n[i];n[e]=t}function Oa(n,e){let t=-1,i=1e9;for(let s=0;s<e.length;s++)(e[s]-i||n[s].endSide-n[t].endSide)<0&&(t=s,i=e[s]);return t}function ct(n,e,t=n.length){let i=0;for(let s=0;s<t&&s<n.length;)n.charCodeAt(s)==9?(i+=e-i%e,s++):(i++,s=ee(n,s));return i}function qn(n,e,t,i){for(let s=0,r=0;;){if(r>=e)return s;if(s==n.length)break;r+=n.charCodeAt(s)==9?t-r%t:1,s=ee(n,s)}return i===!0?-1:n.length}var N,De,ni,Nt,Nn,Fn,xr,wr,ne,ht,be,Ft,Rt,b,Er,A,si,En,Q,Pt,Fe,Hn,Ht,Fi,Wn,Ea,Cr,Ra,Pa,Ia,Na,Fa,Se,Ar,Mr,L,te,Ad,$,Md,Dr,W,Ne,Hi,Br,H,de,zn,Wi,It,ft=ye(()=>{Ca();N=class n{lineAt(e){if(e<0||e>this.length)throw new RangeError(`Invalid position ${e} in document of length ${this.length}`);return this.lineInner(e,!1,1,0)}line(e){if(e<1||e>this.lines)throw new RangeError(`Invalid line number ${e} in ${this.lines}-line document`);return this.lineInner(e,!0,1,0)}replace(e,t,i){[e,t]=oi(this,e,t);let s=[];return this.decompose(0,e,s,2),i.length&&i.decompose(0,i.length,s,3),this.decompose(t,this.length,s,1),ni.from(s,this.length-(t-e)+i.length)}append(e){return this.replace(this.length,this.length,e)}slice(e,t=this.length){[e,t]=oi(this,e,t);let i=[];return this.decompose(e,t,i,0),ni.from(i,t-e)}eq(e){if(e==this)return!0;if(e.length!=this.length||e.lines!=this.lines)return!1;let t=this.scanIdentical(e,1),i=this.length-this.scanIdentical(e,-1),s=new Nt(this),r=new Nt(e);for(let o=t,l=t;;){if(s.next(o),r.next(o),o=0,s.lineBreak!=r.lineBreak||s.done!=r.done||s.value!=r.value)return!1;if(l+=s.value.length,s.done||l>=i)return!0}}iter(e=1){return new Nt(this,e)}iterRange(e,t=this.length){return new Nn(this,e,t)}iterLines(e,t){let i;if(e==null)i=this.iter();else{t==null&&(t=this.lines+1);let s=this.line(e).from;i=this.iterRange(s,Math.max(s,t==this.lines+1?this.length:t<=1?0:this.line(t-1).to))}return new Fn(i)}toString(){return this.sliceString(0)}toJSON(){let e=[];return this.flatten(e),e}constructor(){}static of(e){if(e.length==0)throw new RangeError("A document must have at least one line");return e.length==1&&!e[0]?n.empty:e.length<=32?new De(e):ni.from(De.split(e,[]))}},De=class n extends N{constructor(e,t=yd(e)){super(),this.text=e,this.length=t}get lines(){return this.text.length}get children(){return null}lineInner(e,t,i,s){for(let r=0;;r++){let o=this.text[r],l=s+o.length;if((t?i:l)>=e)return new xr(s,l,i,o);s=l+1,i++}}decompose(e,t,i,s){let r=e<=0&&t>=this.length?this:new n(Aa(this.text,e,t),Math.min(t,this.length)-Math.max(0,e));if(s&1){let o=i.pop(),l=In(r.text,o.text.slice(),0,r.length);if(l.length<=32)i.push(new n(l,o.length+r.length));else{let a=l.length>>1;i.push(new n(l.slice(0,a)),new n(l.slice(a)))}}else i.push(r)}replace(e,t,i){if(!(i instanceof n))return super.replace(e,t,i);[e,t]=oi(this,e,t);let s=In(this.text,In(i.text,Aa(this.text,0,e)),t),r=this.length+i.length-(t-e);return s.length<=32?new n(s,r):ni.from(n.split(s,[]),r)}sliceString(e,t=this.length,i=`
`){[e,t]=oi(this,e,t);let s="";for(let r=0,o=0;r<=t&&o<this.text.length;o++){let l=this.text[o],a=r+l.length;r>e&&o&&(s+=i),e<a&&t>r&&(s+=l.slice(Math.max(0,e-r),t-r)),r=a+1}return s}flatten(e){for(let t of this.text)e.push(t)}scanIdentical(){return 0}static split(e,t){let i=[],s=-1;for(let r of e)i.push(r),s+=r.length+1,i.length==32&&(t.push(new n(i,s)),i=[],s=-1);return s>-1&&t.push(new n(i,s)),t}},ni=class n extends N{constructor(e,t){super(),this.children=e,this.length=t,this.lines=0;for(let i of e)this.lines+=i.lines}lineInner(e,t,i,s){for(let r=0;;r++){let o=this.children[r],l=s+o.length,a=i+o.lines-1;if((t?a:l)>=e)return o.lineInner(e,t,i,s);s=l+1,i=a+1}}decompose(e,t,i,s){for(let r=0,o=0;o<=t&&r<this.children.length;r++){let l=this.children[r],a=o+l.length;if(e<=a&&t>=o){let h=s&((o<=e?1:0)|(a>=t?2:0));o>=e&&a<=t&&!h?i.push(l):l.decompose(e-o,t-o,i,h)}o=a+1}}replace(e,t,i){if([e,t]=oi(this,e,t),i.lines<this.lines)for(let s=0,r=0;s<this.children.length;s++){let o=this.children[s],l=r+o.length;if(e>=r&&t<=l){let a=o.replace(e-r,t-r,i),h=this.lines-o.lines+a.lines;if(a.lines<h>>4&&a.lines>h>>6){let c=this.children.slice();return c[s]=a,new n(c,this.length-(t-e)+i.length)}return super.replace(r,l,a)}r=l+1}return super.replace(e,t,i)}sliceString(e,t=this.length,i=`
`){[e,t]=oi(this,e,t);let s="";for(let r=0,o=0;r<this.children.length&&o<=t;r++){let l=this.children[r],a=o+l.length;o>e&&r&&(s+=i),e<a&&t>o&&(s+=l.sliceString(e-o,t-o,i)),o=a+1}return s}flatten(e){for(let t of this.children)t.flatten(e)}scanIdentical(e,t){if(!(e instanceof n))return 0;let i=0,[s,r,o,l]=t>0?[0,0,this.children.length,e.children.length]:[this.children.length-1,e.children.length-1,-1,-1];for(;;s+=t,r+=t){if(s==o||r==l)return i;let a=this.children[s],h=e.children[r];if(a!=h)return i+a.scanIdentical(h,t);i+=a.length+1}}static from(e,t=e.reduce((i,s)=>i+s.length+1,-1)){let i=0;for(let d of e)i+=d.lines;if(i<32){let d=[];for(let p of e)p.flatten(d);return new De(d,t)}let s=Math.max(32,i>>5),r=s<<1,o=s>>1,l=[],a=0,h=-1,c=[];function f(d){let p;if(d.lines>r&&d instanceof n)for(let m of d.children)f(m);else d.lines>o&&(a>o||!a)?(u(),l.push(d)):d instanceof De&&a&&(p=c[c.length-1])instanceof De&&d.lines+p.lines<=32?(a+=d.lines,h+=d.length+1,c[c.length-1]=new De(p.text.concat(d.text),p.length+1+d.length)):(a+d.lines>s&&u(),a+=d.lines,h+=d.length+1,c.push(d))}function u(){a!=0&&(l.push(c.length==1?c[0]:n.from(c,h)),h=-1,a=c.length=0)}for(let d of e)f(d);return u(),l.length==1?l[0]:new n(l,t)}};N.empty=new De([""],0);Nt=class{constructor(e,t=1){this.dir=t,this.done=!1,this.lineBreak=!1,this.value="",this.nodes=[e],this.offsets=[t>0?1:(e instanceof De?e.text.length:e.children.length)<<1]}nextInner(e,t){for(this.done=this.lineBreak=!1;;){let i=this.nodes.length-1,s=this.nodes[i],r=this.offsets[i],o=r>>1,l=s instanceof De?s.text.length:s.children.length;if(o==(t>0?l:0)){if(i==0)return this.done=!0,this.value="",this;t>0&&this.offsets[i-1]++,this.nodes.pop(),this.offsets.pop()}else if((r&1)==(t>0?0:1)){if(this.offsets[i]+=t,e==0)return this.lineBreak=!0,this.value=`
`,this;e--}else if(s instanceof De){let a=s.text[o+(t<0?-1:0)];if(this.offsets[i]+=t,a.length>Math.max(0,e))return this.value=e==0?a:t>0?a.slice(e):a.slice(0,a.length-e),this;e-=a.length}else{let a=s.children[o+(t<0?-1:0)];e>a.length?(e-=a.length,this.offsets[i]+=t):(t<0&&this.offsets[i]--,this.nodes.push(a),this.offsets.push(t>0?1:(a instanceof De?a.text.length:a.children.length)<<1))}}}next(e=0){return e<0&&(this.nextInner(-e,-this.dir),e=this.value.length),this.nextInner(e,this.dir)}},Nn=class{constructor(e,t,i){this.value="",this.done=!1,this.cursor=new Nt(e,t>i?-1:1),this.pos=t>i?e.length:0,this.from=Math.min(t,i),this.to=Math.max(t,i)}nextInner(e,t){if(t<0?this.pos<=this.from:this.pos>=this.to)return this.value="",this.done=!0,this;e+=Math.max(0,t<0?this.pos-this.to:this.from-this.pos);let i=t<0?this.pos-this.from:this.to-this.pos;e>i&&(e=i),i-=e;let{value:s}=this.cursor.next(e);return this.pos+=(s.length+e)*t,this.value=s.length<=i?s:t<0?s.slice(s.length-i):s.slice(0,i),this.done=!this.value,this}next(e=0){return e<0?e=Math.max(e,this.from-this.pos):e>0&&(e=Math.min(e,this.to-this.pos)),this.nextInner(e,this.cursor.dir)}get lineBreak(){return this.cursor.lineBreak&&this.value!=""}},Fn=class{constructor(e){this.inner=e,this.afterBreak=!0,this.value="",this.done=!1}next(e=0){let{done:t,lineBreak:i,value:s}=this.inner.next(e);return t&&this.afterBreak?(this.value="",this.afterBreak=!1):t?(this.done=!0,this.value=""):i?this.afterBreak?this.value="":(this.afterBreak=!0,this.next()):(this.value=s,this.afterBreak=!1),this}get lineBreak(){return!1}};typeof Symbol<"u"&&(N.prototype[Symbol.iterator]=function(){return this.iter()},Nt.prototype[Symbol.iterator]=Nn.prototype[Symbol.iterator]=Fn.prototype[Symbol.iterator]=function(){return this});xr=class{constructor(e,t,i,s){this.from=e,this.to=t,this.number=i,this.text=s}get length(){return this.to-this.from}};wr=/\r\n?|\n/,ne=(function(n){return n[n.Simple=0]="Simple",n[n.TrackDel=1]="TrackDel",n[n.TrackBefore=2]="TrackBefore",n[n.TrackAfter=3]="TrackAfter",n})(ne||(ne={})),ht=class n{constructor(e){this.sections=e}get length(){let e=0;for(let t=0;t<this.sections.length;t+=2)e+=this.sections[t];return e}get newLength(){let e=0;for(let t=0;t<this.sections.length;t+=2){let i=this.sections[t+1];e+=i<0?this.sections[t]:i}return e}get empty(){return this.sections.length==0||this.sections.length==2&&this.sections[1]<0}iterGaps(e){for(let t=0,i=0,s=0;t<this.sections.length;){let r=this.sections[t++],o=this.sections[t++];o<0?(e(i,s,r),s+=r):s+=o,i+=r}}iterChangedRanges(e,t=!1){kr(this,e,t)}get invertedDesc(){let e=[];for(let t=0;t<this.sections.length;){let i=this.sections[t++],s=this.sections[t++];s<0?e.push(i,s):e.push(s,i)}return new n(e)}composeDesc(e){return this.empty?e:e.empty?this:Ba(this,e)}mapDesc(e,t=!1){return e.empty?this:vr(this,e,t)}mapPos(e,t=-1,i=ne.Simple){let s=0,r=0;for(let o=0;o<this.sections.length;){let l=this.sections[o++],a=this.sections[o++],h=s+l;if(a<0){if(h>e)return r+(e-s);r+=l}else{if(i!=ne.Simple&&h>=e&&(i==ne.TrackDel&&s<e&&h>e||i==ne.TrackBefore&&s<e||i==ne.TrackAfter&&h>e))return null;if(h>e||h==e&&t<0&&!l)return e==s||t<0?r:r+a;r+=a}s=h}if(e>s)throw new RangeError(`Position ${e} is out of range for changeset of length ${s}`);return r}touchesRange(e,t=e){for(let i=0,s=0;i<this.sections.length&&s<=t;){let r=this.sections[i++],o=this.sections[i++],l=s+r;if(o>=0&&s<=t&&l>=e)return s<e&&l>t?"cover":!0;s=l}return!1}toString(){let e="";for(let t=0;t<this.sections.length;){let i=this.sections[t++],s=this.sections[t++];e+=(e?" ":"")+i+(s>=0?":"+s:"")}return e}toJSON(){return this.sections}static fromJSON(e){if(!Array.isArray(e)||e.length%2||e.some(t=>typeof t!="number"))throw new RangeError("Invalid JSON representation of ChangeDesc");return new n(e)}static create(e){return new n(e)}},be=class n extends ht{constructor(e,t){super(e),this.inserted=t}apply(e){if(this.length!=e.length)throw new RangeError("Applying change set to a document with the wrong length");return kr(this,(t,i,s,r,o)=>e=e.replace(s,s+(i-t),o),!1),e}mapDesc(e,t=!1){return vr(this,e,t,!0)}invert(e){let t=this.sections.slice(),i=[];for(let s=0,r=0;s<t.length;s+=2){let o=t[s],l=t[s+1];if(l>=0){t[s]=l,t[s+1]=o;let a=s>>1;for(;i.length<a;)i.push(N.empty);i.push(o?e.slice(r,r+o):N.empty)}r+=o}return new n(t,i)}compose(e){return this.empty?e:e.empty?this:Ba(this,e,!0)}map(e,t=!1){return e.empty?this:vr(this,e,t,!0)}iterChanges(e,t=!1){kr(this,e,t)}get desc(){return ht.create(this.sections)}filter(e){let t=[],i=[],s=[],r=new Ft(this);e:for(let o=0,l=0;;){let a=o==e.length?1e9:e[o++];for(;l<a||l==a&&r.len==0;){if(r.done)break e;let c=Math.min(r.len,a-l);ue(s,c,-1);let f=r.ins==-1?-1:r.off==0?r.ins:0;ue(t,c,f),f>0&&yt(i,t,r.text),r.forward(c),l+=c}let h=e[o++];for(;l<h;){if(r.done)break e;let c=Math.min(r.len,h-l);ue(t,c,-1),ue(s,c,r.ins==-1?-1:r.off==0?r.ins:0),r.forward(c),l+=c}}return{changes:new n(t,i),filtered:ht.create(s)}}toJSON(){let e=[];for(let t=0;t<this.sections.length;t+=2){let i=this.sections[t],s=this.sections[t+1];s<0?e.push(i):s==0?e.push([i]):e.push([i].concat(this.inserted[t>>1].toJSON()))}return e}static of(e,t,i){let s=[],r=[],o=0,l=null;function a(c=!1){if(!c&&!s.length)return;o<t&&ue(s,t-o,-1);let f=new n(s,r);l=l?l.compose(f.map(l)):f,s=[],r=[],o=0}function h(c){if(Array.isArray(c))for(let f of c)h(f);else if(c instanceof n){if(c.length!=t)throw new RangeError(`Mismatched change set length (got ${c.length}, expected ${t})`);a(),l=l?l.compose(c.map(l)):c}else{let{from:f,to:u=f,insert:d}=c;if(f>u||f<0||u>t)throw new RangeError(`Invalid change range ${f} to ${u} (in doc of length ${t})`);let p=d?typeof d=="string"?N.of(d.split(i||wr)):d:N.empty,m=p.length;if(f==u&&m==0)return;f<o&&a(),f>o&&ue(s,f-o,-1),ue(s,u-f,m),yt(r,s,p),o=u}}return h(e),a(!l),l}static empty(e){return new n(e?[e,-1]:[],[])}static fromJSON(e){if(!Array.isArray(e))throw new RangeError("Invalid JSON representation of ChangeSet");let t=[],i=[];for(let s=0;s<e.length;s++){let r=e[s];if(typeof r=="number")t.push(r,-1);else{if(!Array.isArray(r)||typeof r[0]!="number"||r.some((o,l)=>l&&typeof o!="string"))throw new RangeError("Invalid JSON representation of ChangeSet");if(r.length==1)t.push(r[0],0);else{for(;i.length<s;)i.push(N.empty);i[s]=N.of(r.slice(1)),t.push(r[0],i[s].length)}}}return new n(t,i)}static createSet(e,t){return new n(e,t)}};Ft=class{constructor(e){this.set=e,this.i=0,this.next()}next(){let{sections:e}=this.set;this.i<e.length?(this.len=e[this.i++],this.ins=e[this.i++]):(this.len=0,this.ins=-2),this.off=0}get done(){return this.ins==-2}get len2(){return this.ins<0?this.len:this.ins}get text(){let{inserted:e}=this.set,t=this.i-2>>1;return t>=e.length?N.empty:e[t]}textBit(e){let{inserted:t}=this.set,i=this.i-2>>1;return i>=t.length&&!e?N.empty:t[i].slice(this.off,e==null?void 0:this.off+e)}forward(e){e==this.len?this.next():(this.len-=e,this.off+=e)}forward2(e){this.ins==-1?this.forward(e):e==this.ins?this.next():(this.ins-=e,this.off+=e)}},Rt=class n{constructor(e,t,i,s){this.from=e,this.to=t,this.flags=i,this.goalColumn=s}get anchor(){return this.flags&32?this.to:this.from}get head(){return this.flags&32?this.from:this.to}get empty(){return this.from==this.to}get assoc(){return this.flags&8?-1:this.flags&16?1:0}get undirectional(){return(this.flags&64)>0}get bidiLevel(){let e=this.flags&7;return e==7?null:e}map(e,t=-1){let i,s;return this.empty?i=s=e.mapPos(this.from,t):(i=e.mapPos(this.from,1),s=e.mapPos(this.to,-1)),i==this.from&&s==this.to?this:new n(i,s,this.flags,this.goalColumn)}extend(e,t=e,i=0){if(e<=this.anchor&&t>=this.anchor)return b.range(e,t,void 0,void 0,i);let s=Math.abs(e-this.anchor)>Math.abs(t-this.anchor)?e:t;return b.range(this.anchor,s,void 0,void 0,i)}eq(e,t=!1){return this.anchor==e.anchor&&this.head==e.head&&this.goalColumn==e.goalColumn&&(!t||!this.empty||this.assoc==e.assoc)}toJSON(){return{anchor:this.anchor,head:this.head}}static fromJSON(e){if(!e||typeof e.anchor!="number"||typeof e.head!="number")throw new RangeError("Invalid JSON representation for SelectionRange");return b.range(e.anchor,e.head)}static create(e,t,i,s){return new n(e,t,i,s)}},b=class n{constructor(e,t){this.ranges=e,this.mainIndex=t}map(e,t=-1){return e.empty?this:n.create(this.ranges.map(i=>i.map(e,t)),this.mainIndex)}eq(e,t=!1){if(this.ranges.length!=e.ranges.length||this.mainIndex!=e.mainIndex)return!1;for(let i=0;i<this.ranges.length;i++)if(!this.ranges[i].eq(e.ranges[i],t))return!1;return!0}get main(){return this.ranges[this.mainIndex]}asSingle(){return this.ranges.length==1?this:new n([this.main],0)}addRange(e,t=!0){return n.create([e].concat(this.ranges),t?0:this.mainIndex+1)}replaceRange(e,t=this.mainIndex){let i=this.ranges.slice();return i[t]=e,n.create(i,this.mainIndex)}toJSON(){return{ranges:this.ranges.map(e=>e.toJSON()),main:this.mainIndex}}static fromJSON(e){if(!e||!Array.isArray(e.ranges)||typeof e.main!="number"||e.main>=e.ranges.length)throw new RangeError("Invalid JSON representation for EditorSelection");return new n(e.ranges.map(t=>Rt.fromJSON(t)),e.main)}static single(e,t=e){return new n([n.range(e,t)],0)}static create(e,t=0){if(e.length==0)throw new RangeError("A selection needs at least one range");for(let i=0,s=0;s<e.length;s++){let r=e[s];if(r.empty?r.from<=i:r.from<i)return n.normalized(e.slice(),t);i=r.to}return new n(e,t)}static cursor(e,t=0,i,s){return Rt.create(e,e,(t==0?0:t<0?8:16)|(i==null?7:Math.min(6,i)),s)}static range(e,t,i,s,r){let o=s==null?7:Math.min(6,s);return!r&&e!=t&&(r=t<e?1:-1),r&&(o|=r<0?8:16),t<e?Rt.create(t,e,o|32,i):Rt.create(e,t,o,i)}static undirectionalRange(e,t){return Rt.create(e,t,64,void 0)}static normalized(e,t=0){let i=e[t];e.sort((s,r)=>s.from-r.from),t=e.indexOf(i);for(let s=1;s<e.length;s++){let r=e[s],o=e[s-1];if(r.empty?r.from<=o.to:r.from<o.to){let l=o.from,a=Math.max(r.to,o.to);s<=t&&t--,e.splice(--s,2,r.anchor>r.head?n.range(a,l):n.range(l,a))}}return new n(e,t)}};Er=0,A=class n{constructor(e,t,i,s,r){this.combine=e,this.compareInput=t,this.compare=i,this.isStatic=s,this.id=Er++,this.default=e([]),this.extensions=typeof r=="function"?r(this):r}get reader(){return this}static define(e={}){return new n(e.combine||(t=>t),e.compareInput||((t,i)=>t===i),e.compare||(e.combine?(t,i)=>t===i:Rr),!!e.static,e.enables)}of(e){return new si([],this,0,e)}compute(e,t){if(this.isStatic)throw new Error("Can't compute a static facet");return new si(e,this,1,t)}computeN(e,t){if(this.isStatic)throw new Error("Can't compute a static facet");return new si(e,this,2,t)}from(e,t){return t||(t=i=>i),this.compute([e],i=>t(i.field(e)))}};si=class{constructor(e,t,i,s){this.dependencies=e,this.facet=t,this.type=i,this.value=s,this.id=Er++}dynamicSlot(e){var t;let i=this.value,s=this.facet.compareInput,r=this.id,o=e[r]>>1,l=this.type==2,a=!1,h=!1,c=[];for(let f of this.dependencies)f=="doc"?a=!0:f=="selection"?h=!0:(((t=e[f.id])!==null&&t!==void 0?t:1)&1)==0&&c.push(e[f.id]);return{create(f){return f.values[o]=i(f),1},update(f,u){if(a&&u.docChanged||h&&(u.docChanged||u.selection)||Sr(f,c)){let d=i(f);if(l?!Ma(d,f.values[o],s):!s(d,f.values[o]))return f.values[o]=d,1}return 0},reconfigure:(f,u)=>{let d,p=u.config.address[r];if(p!=null){let m=Vn(u,p);if(this.dependencies.every(g=>g instanceof A?u.facet(g)===f.facet(g):g instanceof Q?u.field(g,!1)==f.field(g,!1):!0)||(l?Ma(d=i(f),m,s):s(d=i(f),m)))return f.values[o]=m,0}else d=i(f);return f.values[o]=d,1}}}get extension(){return this}};En=A.define({static:!0}),Q=class n{constructor(e,t,i,s,r){this.id=e,this.createF=t,this.updateF=i,this.compareF=s,this.spec=r,this.provides=void 0}static define(e){let t=new n(Er++,e.create,e.update,e.compare||((i,s)=>i===s),e);return e.provide&&(t.provides=e.provide(t)),t}create(e){let t=e.facet(En).find(i=>i.field==this);return(t?.create||this.createF)(e)}slot(e){let t=e[this.id]>>1;return{create:i=>(i.values[t]=this.create(i),1),update:(i,s)=>{let r=i.values[t],o=this.updateF(r,s);return this.compareF(r,o)?0:(i.values[t]=o,1)},reconfigure:(i,s)=>{let r=i.facet(En),o=s.facet(En),l;return(l=r.find(a=>a.field==this))&&l!=o.find(a=>a.field==this)?(i.values[t]=l.create(i),1):s.config.address[this.id]!=null?(i.values[t]=s.field(this),0):(i.values[t]=this.create(i),1)}}}init(e){return[this,En.of({field:this,create:e})]}get extension(){return this}},Pt={lowest:4,low:3,default:2,high:1,highest:0};Fe={highest:Ii(Pt.highest),high:Ii(Pt.high),default:Ii(Pt.default),low:Ii(Pt.low),lowest:Ii(Pt.lowest)},Hn=class{constructor(e,t){this.inner=e,this.prec=t}get extension(){return this}},Ht=class n{of(e){return new Fi(this,e)}reconfigure(e){return n.reconfigure.of({compartment:this,extension:e})}get(e){return e.config.compartments.get(this)}},Fi=class{constructor(e,t){this.compartment=e,this.inner=t}get extension(){return this}},Wn=class n{constructor(e,t,i,s,r,o){for(this.base=e,this.compartments=t,this.dynamicSlots=i,this.address=s,this.staticValues=r,this.facets=o,this.statusTemplate=[];this.statusTemplate.length<i.length;)this.statusTemplate.push(0)}staticFacet(e){let t=this.address[e.id];return t==null?e.default:this.staticValues[t>>1]}static resolve(e,t,i){let s=[],r=Object.create(null),o=new Map;for(let u of kd(e,t,o))u instanceof Q?s.push(u):(r[u.facet.id]||(r[u.facet.id]=[])).push(u);let l=Object.create(null),a=[],h=[];for(let u of s)l[u.id]=h.length<<1,h.push(d=>u.slot(d));let c=i?.config.facets;for(let u in r){let d=r[u],p=d[0].facet,m=c&&c[u]||[];if(d.every(g=>g.type==0))if(l[p.id]=a.length<<1|1,Rr(m,d))a.push(i.facet(p));else{let g=p.combine(d.map(y=>y.value));a.push(i&&p.compare(g,i.facet(p))?i.facet(p):g)}else{for(let g of d)g.type==0?(l[g.id]=a.length<<1|1,a.push(g.value)):(l[g.id]=h.length<<1,h.push(y=>g.dynamicSlot(y)));l[p.id]=h.length<<1,h.push(g=>wd(g,p,d))}}let f=h.map(u=>u(l));return new n(e,o,f,l,a,r)}};Ea=A.define(),Cr=A.define({combine:n=>n.some(e=>e),static:!0}),Ra=A.define({combine:n=>n.length?n[0]:void 0,static:!0}),Pa=A.define(),Ia=A.define(),Na=A.define(),Fa=A.define({combine:n=>n.length?n[0]:!1}),Se=class{constructor(e,t){this.type=e,this.value=t}static define(){return new Ar}},Ar=class{of(e){return new Se(this,e)}},Mr=class{constructor(e){this.map=e}of(e){return new L(this,e)}},L=class n{constructor(e,t){this.type=e,this.value=t}map(e){let t=this.type.map(this.value,e);return t===void 0?void 0:t==this.value?this:new n(this.type,t)}is(e){return this.type==e}static define(e={}){return new Mr(e.map||(t=>t))}static mapEffects(e,t){if(!e.length)return e;let i=[];for(let s of e){let r=s.map(t);r&&i.push(r)}return i}};L.reconfigure=L.define();L.appendConfig=L.define();te=class n{constructor(e,t,i,s,r,o){this.startState=e,this.changes=t,this.selection=i,this.effects=s,this.annotations=r,this.scrollIntoView=o,this._doc=null,this._state=null,i&&La(i,t.newLength),r.some(l=>l.type==n.time)||(this.annotations=r.concat(n.time.of(Date.now())))}static create(e,t,i,s,r,o){return new n(e,t,i,s,r,o)}get newDoc(){return this._doc||(this._doc=this.changes.apply(this.startState.doc))}get newSelection(){return this.selection||this.startState.selection.map(this.changes)}get state(){return this._state||this.startState.applyTransaction(this),this._state}annotation(e){for(let t of this.annotations)if(t.type==e)return t.value}get docChanged(){return!this.changes.empty}get reconfigured(){return this.startState.config!=this.state.config}isUserEvent(e){let t=this.annotation(n.userEvent);return!!(t&&(t==e||t.length>e.length&&t.slice(0,e.length)==e&&t[e.length]=="."))}};te.time=Se.define();te.userEvent=Se.define();te.addToHistory=Se.define();te.remote=Se.define();Ad=[];$=(function(n){return n[n.Word=0]="Word",n[n.Space=1]="Space",n[n.Other=2]="Other",n})($||($={})),Md=/[\u00df\u0587\u0590-\u05f4\u0600-\u06ff\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;try{Dr=new RegExp("[\\p{Alphabetic}\\p{Number}_]","u")}catch{}W=class n{constructor(e,t,i,s,r,o){this.config=e,this.doc=t,this.selection=i,this.values=s,this.status=e.statusTemplate.slice(),this.computeSlot=r,o&&(o._state=this);for(let l=0;l<this.config.dynamicSlots.length;l++)Ni(this,l<<1);this.computeSlot=null}field(e,t=!0){let i=this.config.address[e.id];if(i==null){if(t)throw new RangeError("Field is not present in this state");return}return Ni(this,i),Vn(this,i)}update(...e){return Wa(this,e,!0)}applyTransaction(e){let t=this.config,{base:i,compartments:s}=t;for(let l of e.effects)l.is(Ht.reconfigure)?(t&&(s=new Map,t.compartments.forEach((a,h)=>s.set(h,a)),t=null),s.set(l.value.compartment,l.value.extension)):l.is(L.reconfigure)?(t=null,i=l.value):l.is(L.appendConfig)&&(t=null,i=ri(i).concat(l.value));let r;t?r=e.startState.values.slice():(t=Wn.resolve(i,s,this),r=new n(t,this.doc,this.selection,t.dynamicSlots.map(()=>null),(a,h)=>h.reconfigure(a,this),null).values);let o=e.startState.facet(Cr)?e.newSelection:e.newSelection.asSingle();new n(t,e.newDoc,o,r,(l,a)=>a.update(l,e),e)}replaceSelection(e){return typeof e=="string"&&(e=this.toText(e)),this.changeByRange(t=>({changes:{from:t.from,to:t.to,insert:e},range:b.cursor(t.from+e.length,-1)}))}changeByRange(e){let t=this.selection,i=e(t.ranges[0]),s=this.changes(i.changes),r=[i.range],o=ri(i.effects);for(let l=1;l<t.ranges.length;l++){let a=e(t.ranges[l]),h=this.changes(a.changes),c=h.map(s);for(let u=0;u<l;u++)r[u]=r[u].map(c);let f=s.mapDesc(h,!0);r.push(a.range.map(f)),s=s.compose(c),o=L.mapEffects(o,c).concat(L.mapEffects(ri(a.effects),f))}return{changes:s,selection:b.create(r,t.mainIndex),effects:o}}changes(e=[]){return e instanceof be?e:be.of(e,this.doc.length,this.facet(n.lineSeparator))}toText(e){return N.of(e.split(this.facet(n.lineSeparator)||wr))}sliceDoc(e=0,t=this.doc.length){return this.doc.sliceString(e,t,this.lineBreak)}facet(e){let t=this.config.address[e.id];return t==null?e.default:(Ni(this,t),Vn(this,t))}toJSON(e){let t={doc:this.sliceDoc(),selection:this.selection.toJSON()};if(e)for(let i in e){let s=e[i];s instanceof Q&&this.config.address[s.id]!=null&&(t[i]=s.spec.toJSON(this.field(e[i]),this))}return t}static fromJSON(e,t={},i){if(!e||typeof e.doc!="string")throw new RangeError("Invalid JSON representation for EditorState");let s=[];if(i){for(let r in i)if(Object.prototype.hasOwnProperty.call(e,r)){let o=i[r],l=e[r];s.push(o.init(a=>o.spec.fromJSON(l,a)))}}return n.create({doc:e.doc,selection:b.fromJSON(e.selection),extensions:t.extensions?s.concat([t.extensions]):s})}static create(e={}){let t=Wn.resolve(e.extensions||[],new Map),i=e.doc instanceof N?e.doc:N.of((e.doc||"").split(t.staticFacet(n.lineSeparator)||wr)),s=e.selection?e.selection instanceof b?e.selection:b.single(e.selection.anchor,e.selection.head):b.single(0);return La(s,i.length),t.staticFacet(Cr)||(s=s.asSingle()),new n(t,i,s,t.dynamicSlots.map(()=>null),(r,o)=>o.create(r),null)}get tabSize(){return this.facet(n.tabSize)}get lineBreak(){return this.facet(n.lineSeparator)||`
`}get readOnly(){return this.facet(Fa)}phrase(e,...t){for(let i of this.facet(n.phrases))if(Object.prototype.hasOwnProperty.call(i,e)){e=i[e];break}return t.length&&(e=e.replace(/\$(\$|\d*)/g,(i,s)=>{if(s=="$")return"$";let r=+(s||1);return!r||r>t.length?i:t[r-1]})),e}languageDataAt(e,t,i=-1){let s=[];for(let r of this.facet(Ea))for(let o of r(this,t,i))Object.prototype.hasOwnProperty.call(o,e)&&s.push(o[e]);return s}charCategorizer(e){let t=this.languageDataAt("wordChars",e);return Dd(t.length?t[0]:"")}wordAt(e){let{text:t,from:i,length:s}=this.doc.lineAt(e),r=this.charCategorizer(e),o=e-i,l=e-i;for(;o>0;){let a=ee(t,o,!1);if(r(t.slice(a,o))!=$.Word)break;o=a}for(;l<s;){let a=ee(t,l);if(r(t.slice(l,a))!=$.Word)break;l=a}return o==l?null:b.range(o+i,l+i)}};W.allowMultipleSelections=Cr;W.tabSize=A.define({combine:n=>n.length?n[0]:4});W.lineSeparator=Ra;W.readOnly=Fa;W.phrases=A.define({compare(n,e){let t=Object.keys(n),i=Object.keys(e);return t.length==i.length&&t.every(s=>n[s]==e[s])}});W.languageData=Ea;W.changeFilter=Pa;W.transactionFilter=Ia;W.transactionExtender=Na;Ht.reconfigure=L.define();Ne=class{eq(e){return this==e}range(e,t=e){return Hi.create(e,t,this)}};Ne.prototype.startSide=Ne.prototype.endSide=0;Ne.prototype.point=!1;Ne.prototype.mapMode=ne.TrackDel;Hi=class n{constructor(e,t,i){this.from=e,this.to=t,this.value=i}static create(e,t,i){return new n(e,t,i)}};Br=class n{constructor(e,t,i,s){this.from=e,this.to=t,this.value=i,this.maxPoint=s}get length(){return ii(this.to)}findIndex(e,t,i,s=0){let r=i?this.to:this.from;for(let o=s,l=r.length;;){if(o==l)return o;let a=o+l>>1,h=r[a]-e||(i?this.value[a].endSide:this.value[a].startSide)-t;if(a==o)return h>=0?o:l;h>=0?l=a:o=a+1}}between(e,t,i,s){for(let r=this.findIndex(t,-1e9,!0),o=this.findIndex(i,1e9,!1,r);r<o;r++)if(s(this.from[r]+e,this.to[r]+e,this.value[r])===!1)return!1}map(e,t,i,s,r){let o=[],l=[],a=[],h=-1,c=-1;e:for(let f=0;f<this.value.length;f++){let u=this.value[f],d=this.from[f]+e,p=this.to[f]+e,m,g;if(d==p){let y=t.mapPos(d,u.startSide,u.mapMode);if(y==null||(m=g=y,u.startSide!=u.endSide&&(g=t.mapPos(d,u.endSide),g<m)))continue}else if(m=t.mapPos(d,u.startSide),g=t.mapPos(p,u.endSide),m>g||m==g&&u.startSide>0&&u.endSide<=0)continue;if(!((g-m||u.endSide-u.startSide)<0))if(h<0&&(h=m),u.point&&(c=Math.max(c,g-m)),(m-i||u.startSide-s)>=0)o.push(u),l.push(m-h),a.push(g-h),i=g,s=u.endSide;else{if(m==g)for(let y=o.length;y>0;y--){if((m-(a[y-1]+h)||u.startSide-o[y-1].endSide)>=0){o.splice(y,0,u),l.splice(y,0,m-h),a.splice(y,0,g-h);continue e}if((m-(l[y-1]+h)||u.endSide-o[y-1].startSide)>0)break}r(m,g,u)}}return{mapped:o.length?new n(l,a,o,c):null,pos:h}}},H=class n{constructor(e,t,i,s){this.chunkPos=e,this.chunk=t,this.nextLayer=i,this.maxPoint=s}static create(e,t,i,s){return new n(e,t,i,s)}get length(){let e=this.chunk.length-1;return e<0?0:Math.max(this.chunkEnd(e),this.nextLayer.length)}get size(){if(this.isEmpty)return 0;let e=this.nextLayer.size;for(let t of this.chunk)e+=t.value.length;return e}chunkEnd(e){return this.chunkPos[e]+this.chunk[e].length}update(e){let{add:t=[],sort:i=!1,filterFrom:s=0,filterTo:r=this.length}=e,o=e.filter;if(t.length==0&&!o)return this;if(i&&(t=t.slice().sort(Or)),this.isEmpty)return t.length?n.of(t):this;let l=new zn(this,null,-1).goto(0),a=0,h=[],c=new de;for(;l.value||a<t.length;)if(a<t.length&&(l.from-t[a].from||l.startSide-t[a].value.startSide)>=0){let f=t[a++];c.addInner(f.from,f.to,f.value,!1)||h.push(f)}else l.rangeIndex==1&&l.chunkIndex<this.chunk.length&&(a==t.length||this.chunkEnd(l.chunkIndex)<t[a].from)&&(!o||s>this.chunkEnd(l.chunkIndex)||r<this.chunkPos[l.chunkIndex])&&c.addChunk(this.chunkPos[l.chunkIndex],this.chunk[l.chunkIndex])?l.nextChunk():((!o||s>l.to||r<l.from||o(l.from,l.to,l.value))&&(c.addInner(l.from,l.to,l.value,!1)||h.push(Hi.create(l.from,l.to,l.value))),l.next());return c.finishInner(this.nextLayer.isEmpty&&!h.length?n.empty:this.nextLayer.update({add:h,filter:o,filterFrom:s,filterTo:r}))}map(e){if(e.empty||this.isEmpty)return this;let t=[],i=[],s=-1,r,o=(a,h,c)=>{r||(r=new de),r.addRange(a,h,c,!1)};for(let a=0;a<this.chunk.length;a++){let h=this.chunkPos[a],c=this.chunk[a],f=e.touchesRange(h,h+c.length);if(f===!1)s=Math.max(s,c.maxPoint),t.push(c),i.push(e.mapPos(h));else if(f===!0){let[u,d]=t.length?[ii(i)+ii(t).length,ii(ii(t).value).endSide]:[-1,-1],{mapped:p,pos:m}=c.map(h,e,u,d,o);p&&(s=Math.max(s,p.maxPoint),t.push(p),i.push(m))}}let l=this.nextLayer.map(e);return r&&(l=r.finishInner(l)),t.length==0?l:new n(i,t,l||n.empty,s)}between(e,t,i){if(!this.isEmpty){for(let s=0;s<this.chunk.length;s++){let r=this.chunkPos[s],o=this.chunk[s];if(t>=r&&e<=r+o.length&&o.between(r,e-r,t-r,i)===!1)return}this.nextLayer.between(e,t,i)}}iter(e=0){return Wi.from([this]).goto(e)}get isEmpty(){return this.nextLayer==this}static iter(e,t=0){return Wi.from(e).goto(t)}static compare(e,t,i,s,r=-1){let o=e.filter(f=>f.maxPoint>0||!f.isEmpty&&f.maxPoint>=r),l=t.filter(f=>f.maxPoint>0||!f.isEmpty&&f.maxPoint>=r),a=Ta(o,l,i),h=new It(o,a,r),c=new It(l,a,r);i.iterGaps((f,u,d)=>Da(h,f,c,u,d,s)),i.empty&&i.length==0&&Da(h,0,c,0,0,s)}static eq(e,t,i=0,s){s==null&&(s=999999999);let r=e.filter(c=>!c.isEmpty&&t.indexOf(c)<0),o=t.filter(c=>!c.isEmpty&&e.indexOf(c)<0);if(r.length!=o.length)return!1;if(!r.length)return!0;let l=Ta(r,o),a=new It(r,l,0).goto(i),h=new It(o,l,0).goto(i);for(;;){if(a.to!=h.to||!Lr(a.active,h.active)||a.point&&(!h.point||!Pr(a.point,h.point)))return!1;if(a.to>s)return!0;a.next(),h.next()}}static spans(e,t,i,s,r=-1){let o=new It(e,null,r).goto(t),l=t,a=o.openStart;for(;;){let h=Math.min(o.to,i);if(o.point){let c=o.activeForPoint(o.to),f=o.pointFrom<t?c.length+1:o.point.startSide<0?c.length:Math.min(c.length,a);s.point(l,h,o.point,c,f,o.pointRank),a=Math.min(o.openEnd(h),c.length)}else h>l&&(s.span(l,h,o.active,a),a=o.openEnd(h));if(o.to>i)return a+(o.point&&o.to>i?1:0);l=o.to,o.next()}}static of(e,t=!1){let i=new de;for(let s of e instanceof Hi?[e]:t?Od(e):e)i.add(s.from,s.to,s.value);return i.finish()}static join(e){if(!e.length)return n.empty;let t=ii(e);for(let i=e.length-2;i>=0;i--)for(let s=e[i];s!=n.empty;s=s.nextLayer)t=new n(s.chunkPos,s.chunk,t,Math.max(s.maxPoint,t.maxPoint));return t}};H.empty=new H([],[],null,-1);H.empty.nextLayer=H.empty;de=class n{finishChunk(e){this.chunks.push(new Br(this.from,this.to,this.value,this.maxPoint)),this.chunkPos.push(this.chunkStart),this.chunkStart=-1,this.setMaxPoint=Math.max(this.setMaxPoint,this.maxPoint),this.maxPoint=-1,e&&(this.from=[],this.to=[],this.value=[])}constructor(){this.chunks=[],this.chunkPos=[],this.chunkStart=-1,this.last=null,this.lastFrom=-1e9,this.lastTo=-1e9,this.from=[],this.to=[],this.value=[],this.maxPoint=-1,this.setMaxPoint=-1,this.nextLayer=null}add(e,t,i){this.addRange(e,t,i,!0)}addRange(e,t,i,s){this.addInner(e,t,i,s)||(this.nextLayer||(this.nextLayer=new n)).addRange(e,t,i,s)}addInner(e,t,i,s){let r=e-this.lastTo||i.startSide-this.last.endSide;if(s&&r<=0&&(e-this.lastFrom||i.startSide-this.last.startSide)<0)throw new Error("Ranges must be added sorted by `from` position and `startSide`");return r<0?!1:(this.from.length==250&&this.finishChunk(!0),this.chunkStart<0&&(this.chunkStart=e),this.from.push(e-this.chunkStart),this.to.push(t-this.chunkStart),this.last=i,this.lastFrom=e,this.lastTo=t,this.value.push(i),i.point&&(this.maxPoint=Math.max(this.maxPoint,t-e)),!0)}addChunk(e,t){if((e-this.lastTo||t.value[0].startSide-this.last.endSide)<0)return!1;this.from.length&&this.finishChunk(!0),this.setMaxPoint=Math.max(this.setMaxPoint,t.maxPoint),this.chunks.push(t),this.chunkPos.push(e);let i=t.value.length-1;return this.last=t.value[i],this.lastFrom=t.from[i]+e,this.lastTo=t.to[i]+e,!0}finish(){return this.finishInner(H.empty)}finishInner(e){if(this.from.length&&this.finishChunk(!1),this.chunks.length==0)return e;let t=H.create(this.chunkPos,this.chunks,this.nextLayer?this.nextLayer.finishInner(e):e,this.setMaxPoint);return this.from=null,t}};zn=class{constructor(e,t,i,s=0){this.layer=e,this.skip=t,this.minPoint=i,this.rank=s}get startSide(){return this.value?this.value.startSide:0}get endSide(){return this.value?this.value.endSide:0}goto(e,t=-1e9){return this.chunkIndex=this.rangeIndex=0,this.gotoInner(e,t,!1),this}gotoInner(e,t,i){for(;this.chunkIndex<this.layer.chunk.length;){let s=this.layer.chunk[this.chunkIndex];if(!(this.skip&&this.skip.has(s)||this.layer.chunkEnd(this.chunkIndex)<e||s.maxPoint<this.minPoint))break;this.chunkIndex++,i=!1}if(this.chunkIndex<this.layer.chunk.length){let s=this.layer.chunk[this.chunkIndex].findIndex(e-this.layer.chunkPos[this.chunkIndex],t,!0);(!i||this.rangeIndex<s)&&this.setRangeIndex(s)}this.next()}forward(e,t){(this.to-e||this.endSide-t)<0&&this.gotoInner(e,t,!0)}next(){for(;;)if(this.chunkIndex==this.layer.chunk.length){this.from=this.to=1e9,this.value=null;break}else{let e=this.layer.chunkPos[this.chunkIndex],t=this.layer.chunk[this.chunkIndex],i=e+t.from[this.rangeIndex];if(this.from=i,this.to=e+t.to[this.rangeIndex],this.value=t.value[this.rangeIndex],this.setRangeIndex(this.rangeIndex+1),this.minPoint<0||this.value.point&&this.to-this.from>=this.minPoint)break}}setRangeIndex(e){if(e==this.layer.chunk[this.chunkIndex].value.length){if(this.chunkIndex++,this.skip)for(;this.chunkIndex<this.layer.chunk.length&&this.skip.has(this.layer.chunk[this.chunkIndex]);)this.chunkIndex++;this.rangeIndex=0}else this.rangeIndex=e}nextChunk(){this.chunkIndex++,this.rangeIndex=0,this.next()}compare(e){return this.from-e.from||this.startSide-e.startSide||this.rank-e.rank||this.to-e.to||this.endSide-e.endSide}},Wi=class n{constructor(e){this.heap=e}static from(e,t=null,i=-1){let s=[];for(let r=0;r<e.length;r++)for(let o=e[r];!o.isEmpty;o=o.nextLayer)o.maxPoint>=i&&s.push(new zn(o,t,i,r));return s.length==1?s[0]:new n(s)}get startSide(){return this.value?this.value.startSide:0}goto(e,t=-1e9){for(let i of this.heap)i.goto(e,t);for(let i=this.heap.length>>1;i>=0;i--)br(this.heap,i);return this.next(),this}forward(e,t){for(let i of this.heap)i.forward(e,t);for(let i=this.heap.length>>1;i>=0;i--)br(this.heap,i);(this.to-e||this.value.endSide-t)<0&&this.next()}next(){if(this.heap.length==0)this.from=this.to=1e9,this.value=null,this.rank=-1;else{let e=this.heap[0];this.from=e.from,this.to=e.to,this.value=e.value,this.rank=e.rank,e.value&&e.next(),br(this.heap,0)}}};It=class{constructor(e,t,i){this.minPoint=i,this.active=[],this.activeTo=[],this.activeRank=[],this.minActive=-1,this.point=null,this.pointFrom=0,this.pointRank=0,this.to=-1e9,this.endSide=0,this.openStart=-1,this.cursor=Wi.from(e,t,i)}goto(e,t=-1e9){return this.cursor.goto(e,t),this.active.length=this.activeTo.length=this.activeRank.length=0,this.minActive=-1,this.to=e,this.endSide=t,this.openStart=-1,this.next(),this}forward(e,t){for(;this.minActive>-1&&(this.activeTo[this.minActive]-e||this.active[this.minActive].endSide-t)<0;)this.removeActive(this.minActive);this.cursor.forward(e,t)}removeActive(e){Rn(this.active,e),Rn(this.activeTo,e),Rn(this.activeRank,e),this.minActive=Oa(this.active,this.activeTo)}addActive(e){let t=0,{value:i,to:s,rank:r}=this.cursor;for(;t<this.activeRank.length&&(r-this.activeRank[t]||s-this.activeTo[t])>0;)t++;Pn(this.active,t,i),Pn(this.activeTo,t,s),Pn(this.activeRank,t,r),e&&Pn(e,t,this.cursor.from),this.minActive=Oa(this.active,this.activeTo)}next(){let e=this.to,t=this.point;this.point=null;let i=this.openStart<0?[]:null;for(;;){let s=this.minActive;if(s>-1&&(this.activeTo[s]-this.cursor.from||this.active[s].endSide-this.cursor.startSide)<0){if(this.activeTo[s]>e){this.to=this.activeTo[s],this.endSide=this.active[s].endSide;break}this.removeActive(s),i&&Rn(i,s)}else if(this.cursor.value)if(this.cursor.from>e){this.to=this.cursor.from,this.endSide=this.cursor.startSide;break}else{let r=this.cursor.value;if(!r.point)this.addActive(i),this.cursor.next();else if(t&&this.cursor.to==this.to&&this.cursor.from<this.cursor.to)this.cursor.next();else{this.point=r,this.pointFrom=this.cursor.from,this.pointRank=this.cursor.rank,this.to=this.cursor.to,this.endSide=r.endSide,this.cursor.next(),this.forward(this.to,this.endSide);break}}else{this.to=this.endSide=1e9;break}}if(i){this.openStart=0;for(let s=i.length-1;s>=0&&i[s]<e;s--)this.openStart++}}activeForPoint(e){if(!this.active.length)return this.active;let t=[];for(let i=this.active.length-1;i>=0&&!(this.activeRank[i]<this.pointRank);i--)(this.activeTo[i]>e||this.activeTo[i]==e&&this.active[i].endSide>=this.point.endSide)&&t.push(this.active[i]);return t.reverse()}openEnd(e){let t=0;for(let i=this.activeTo.length-1;i>=0&&this.activeTo[i]>e;i--)t++;return t}}});var Va,Ir,za,He,qa,Nr,Fr=ye(()=>{Va=typeof Symbol>"u"?"__\u037C":Symbol.for("\u037C"),Ir=typeof Symbol>"u"?"__styleSet"+Math.floor(Math.random()*1e8):Symbol("styleSet"),za=typeof globalThis<"u"?globalThis:typeof window<"u"?window:{},He=class{constructor(e,t){this.rules=[];let{finish:i}=t||{};function s(o){return/^@/.test(o)?[o]:o.split(/,\s*/)}function r(o,l,a,h){let c=[],f=/^@(\w+)\b/.exec(o[0]),u=f&&f[1]=="keyframes";if(f&&l==null)return a.push(o[0]+";");for(let d in l){let p=l[d];if(/&/.test(d))r(d.split(/,\s*/).map(m=>o.map(g=>m.replace(/&/,g))).reduce((m,g)=>m.concat(g)),p,a);else if(p&&typeof p=="object"){if(!f)throw new RangeError("The value of a property ("+d+") should be a primitive value.");r(s(d),p,c,u)}else p!=null&&c.push(d.replace(/_.*/,"").replace(/[A-Z]/g,m=>"-"+m.toLowerCase())+": "+p+";")}(c.length||u)&&a.push((i&&!f&&!h?o.map(i):o).join(", ")+" {"+c.join(" ")+"}")}for(let o in e)r(s(o),e[o],this.rules)}getRules(){return this.rules.join(`
`)}static newName(){let e=za[Va]||1;return za[Va]=e+1,"\u037C"+e.toString(36)}static mount(e,t,i){let s=e[Ir],r=i&&i.nonce;s?r&&s.setNonce(r):s=new Nr(e,r),s.mount(Array.isArray(t)?t:[t],e)}},qa=new Map,Nr=class{constructor(e,t){let i=e.ownerDocument||e,s=i.defaultView;if(!e.head&&e.adoptedStyleSheets&&s.CSSStyleSheet){let r=qa.get(i);if(r)return e[Ir]=r;this.sheet=new s.CSSStyleSheet,qa.set(i,this)}else this.styleTag=i.createElement("style"),t&&this.styleTag.setAttribute("nonce",t);this.modules=[],e[Ir]=this}mount(e,t){let i=this.sheet,s=0,r=0,o=!1;for(let l=0;l<e.length;l++){let a=e[l],h=this.modules.indexOf(a);if(h<r&&h>-1&&(this.modules.splice(h,1),o=!0,r--,h=-1),h==-1){if(this.modules.splice(r++,0,a),o=!0,i)for(let c=0;c<a.rules.length;c++)i.insertRule(a.rules[c],s++)}else{for(;r<h;)s+=this.modules[r++].rules.length;s+=a.rules.length,r++}}if(i)t.adoptedStyleSheets.indexOf(this.sheet)<0&&(t.adoptedStyleSheets=[this.sheet,...t.adoptedStyleSheets]);else{if(o){let a="";for(let h=0;h<this.modules.length;h++)a+=this.modules[h].getRules()+`
`;this.styleTag.textContent=a}let l=t.head||t;this.styleTag.parentNode!=l&&l.insertBefore(this.styleTag,l.firstChild)}}setNonce(e){this.styleTag&&this.styleTag.getAttribute("nonce")!=e&&this.styleTag.setAttribute("nonce",e)}}});function Ka(n){var e=Bd&&n.metaKey&&n.shiftKey&&!n.ctrlKey&&!n.altKey||Ld&&n.shiftKey&&n.key&&n.key.length==1||n.key=="Unidentified",t=!e&&n.key||(n.shiftKey?li:ut)[n.keyCode]||n.key||"Unidentified";return t=="Esc"&&(t="Escape"),t=="Del"&&(t="Delete"),t=="Left"&&(t="ArrowLeft"),t=="Up"&&(t="ArrowUp"),t=="Right"&&(t="ArrowRight"),t=="Down"&&(t="ArrowDown"),t}var ut,li,Bd,Ld,ie,ie,ie,Kn,$a=ye(()=>{ut={8:"Backspace",9:"Tab",10:"Enter",12:"NumLock",13:"Enter",16:"Shift",17:"Control",18:"Alt",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",44:"PrintScreen",45:"Insert",46:"Delete",59:";",61:"=",91:"Meta",92:"Meta",106:"*",107:"+",108:",",109:"-",110:".",111:"/",144:"NumLock",145:"ScrollLock",160:"Shift",161:"Shift",162:"Control",163:"Control",164:"Alt",165:"Alt",173:"-",186:";",187:"=",188:",",189:"-",190:".",191:"/",192:"`",219:"[",220:"\\",221:"]",222:"'"},li={48:")",49:"!",50:"@",51:"#",52:"$",53:"%",54:"^",55:"&",56:"*",57:"(",59:":",61:"+",173:"_",186:":",187:"+",188:"<",189:"_",190:">",191:"?",192:"~",219:"{",220:"|",221:"}",222:'"'},Bd=typeof navigator<"u"&&/Mac/.test(navigator.platform),Ld=typeof navigator<"u"&&/MSIE \d|Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(navigator.userAgent);for(ie=0;ie<10;ie++)ut[48+ie]=ut[96+ie]=String(ie);for(ie=1;ie<=24;ie++)ut[ie+111]="F"+ie;for(ie=65;ie<=90;ie++)ut[ie]=String.fromCharCode(ie+32),li[ie]=String.fromCharCode(ie);for(Kn in ut)li.hasOwnProperty(Kn)||(li[Kn]=ut[Kn])});function V(){var n=arguments[0];typeof n=="string"&&(n=document.createElement(n));var e=1,t=arguments[1];if(t&&typeof t=="object"&&t.nodeType==null&&!Array.isArray(t)){for(var i in t)if(Object.prototype.hasOwnProperty.call(t,i)){var s=t[i];typeof s=="string"?n.setAttribute(i,s):s!=null&&(n[i]=s)}e++}for(;e<arguments.length;e++)ja(n,arguments[e]);return n}function ja(n,e){if(typeof e=="string")n.appendChild(document.createTextNode(e));else if(e!=null)if(e.nodeType!=null)n.appendChild(e);else if(Array.isArray(e))for(var t=0;t<e.length;t++)ja(n,e[t]);else throw new RangeError("Unsupported child node: "+e)}var $n=ye(()=>{});function jo(n,e){for(let t in n)t=="class"&&e.class?e.class+=" "+n.class:t=="style"&&e.style?e.style+=";"+n.style:e[t]=n[t];return e}function Uo(n,e,t){if(n==e)return!0;n||(n=os),e||(e=os);let i=Object.keys(n),s=Object.keys(e);if(i.length-0!=s.length-0)return!1;for(let r of i)if(r!=t&&(s.indexOf(r)==-1||n[r]!==e[r]))return!1;return!0}function Ed(n,e){for(let t=n.attributes.length-1;t>=0;t--){let i=n.attributes[t].name;e[i]==null&&n.removeAttribute(i)}for(let t in e){let i=e[t];t=="style"?n.style.cssText=i:n.getAttribute(t)!=i&&n.setAttribute(t,i)}}function Ya(n,e,t){let i=!1;if(e)for(let s in e)t&&s in t||(i=!0,s=="style"?n.style.cssText="":n.removeAttribute(s));if(t)for(let s in t)e&&e[s]==t[s]||(i=!0,s=="style"?n.style.cssText=t[s]:n.setAttribute(s,t[s]));return i}function Rd(n){let e=Object.create(null);for(let t=0;t<n.attributes.length;t++){let i=n.attributes[t];e[i.name]=i.value}return e}function Bh(n,e=!1){let{inclusiveStart:t,inclusiveEnd:i}=n;return t==null&&(t=n.inclusive),i==null&&(i=n.inclusive),{start:t??e,end:i??e}}function Pd(n,e){return n==e||!!(n&&e&&n.compare(e))}function di(n,e,t,i=0){let s=t.length-1;s>=0&&t[s]+i>=n?t[s]=Math.max(t[s],e):t.push(n,e)}function tn(n){let e;return n.nodeType==11?e=n.getSelection?n:n.ownerDocument:e=n,e.getSelection()}function Xr(n,e){return e?n==e||n.contains(e.nodeType!=1?e.parentNode:e):!1}function $i(n,e){if(!e.anchorNode)return!1;try{return Xr(n,e.anchorNode)}catch{return!1}}function es(n){return mi(n)?nn(n,0,n.nodeValue.length).getClientRects():se(n)?n.getClientRects():[]}function ji(n,e,t,i){return t?Xa(n,e,t,i,-1)||Xa(n,e,t,i,1):!1}function wt(n){for(var e=0;;e++)if(n=n.previousSibling,!n)return e}function as(n){return se(n)&&/^(DIV|P|LI|UL|OL|BLOCKQUOTE|DD|DT|H\d|SECTION|PRE)$/.test(n.nodeName)}function Xa(n,e,t,i,s){for(;;){if(n==t&&e==i)return!0;if(e==(s<0?0:mt(n))){if(n.nodeName=="DIV")return!1;let r=n.parentNode;if(!r||!se(r))return!1;e=wt(n)+(s<0?0:1),n=r}else if(se(n)){if(n=n.childNodes[e+(s<0?-1:0)],se(n)&&(n.nodeName=="IMG"||n.nodeName=="BR"||n.contentEditable=="false"))return!1;e=s<0?mt(n):0}else return!1}}function mt(n){return mi(n)?n.nodeValue.length:n.childNodes.length}function hs(n,e){let{left:t,right:i}=n;if(t==i)return n;let s=e?t:i;return{left:s,right:s,top:n.top,bottom:n.bottom}}function Id(n){let e=n.visualViewport;return e?{left:0,right:e.width,top:0,bottom:e.height}:{left:0,right:n.innerWidth,top:0,bottom:n.innerHeight}}function Lh(n,e){let t=e.width/n.offsetWidth,i=e.height/n.offsetHeight;return(t>.995&&t<1.005||!isFinite(t)||Math.abs(e.width-n.offsetWidth)<1)&&(t=1),(i>.995&&i<1.005||!isFinite(i)||Math.abs(e.height-n.offsetHeight)<1)&&(i=1),{scaleX:t,scaleY:i}}function Nd(n,e,t,i,s,r,o,l){let a=n.ownerDocument,h=a.defaultView||window;for(let c=n,f=!1;c&&!f;)if(se(c)){let u,d=c==a.body,p=1,m=1,g=!0,y=!0;if(d)u=Id(h);else{let O=getComputedStyle(c);if(/^(fixed|sticky)$/.test(O.position)&&(f=!0),(c.scrollHeight<=c.clientHeight||!/auto|scroll/.test(O.overflowY))&&(y=!1),(c.scrollWidth<=c.clientWidth||!/auto|scroll/.test(O.overflowX))&&(g=!1),!g&&!y){c=c.assignedSlot||c.parentNode;continue}let w=c.getBoundingClientRect();({scaleX:p,scaleY:m}=Lh(c,w)),u={left:w.left,right:w.left+c.clientWidth*p,top:w.top,bottom:w.top+c.clientHeight*m}}let k=0,x=0;if(y)if(s=="nearest")e.top<u.top+o?(x=e.top-(u.top+o),t>0&&e.bottom>u.bottom+x&&(x=e.bottom-u.bottom+o)):e.bottom>u.bottom-o&&(x=e.bottom-u.bottom+o,t<0&&e.top-x<u.top&&(x=e.top-(u.top+o)));else{let O=e.bottom-e.top,w=u.bottom-u.top;x=(s=="center"&&O<=w?e.top+O/2-w/2:s=="start"||s=="center"&&t<0?e.top-o:e.bottom-w+o)-u.top}if(g&&(i=="nearest"?e.left<u.left+r?(k=e.left-(u.left+r),t>0&&e.right>u.right+k&&(k=e.right-u.right+r)):e.right>u.right-r&&(k=e.right-u.right+r,t<0&&e.left<u.left+k&&(k=e.left-(u.left+r))):k=(i=="center"?e.left+(e.right-e.left)/2-(u.right-u.left)/2:i=="start"==l?e.left-r:e.right-(u.right-u.left)+r)-u.left),k||x)if(d)h.scrollBy(k,x);else{let O=0,w=0;if(x){let S=c.scrollTop;c.scrollTop+=x/m,w=(c.scrollTop-S)*m}if(k){let S=c.scrollLeft;c.scrollLeft+=k/p,O=(c.scrollLeft-S)*p}e={left:e.left-O,top:e.top-w,right:e.right-O,bottom:e.bottom-w},O&&Math.abs(O-k)<1&&(i="nearest"),w&&Math.abs(w-x)<1&&(s="nearest")}if(d)break;(e.top<u.top||e.bottom>u.bottom||e.left<u.left||e.right>u.right)&&(e={left:Math.max(e.left,u.left),right:Math.min(e.right,u.right),top:Math.max(e.top,u.top),bottom:Math.min(e.bottom,u.bottom)}),c=c.assignedSlot||c.parentNode}else if(c.nodeType==11)c=c.host;else break}function Eh(n,e=!0){let t=n.ownerDocument,i=null,s=null;for(let r=n.parentNode;r&&!(r==t.body||(!e||i)&&s);)if(se(r))!s&&r.scrollHeight>r.clientHeight&&/scroll|auto/.test(getComputedStyle(r).overflowY)&&(s=r),e&&!i&&r.scrollWidth>r.clientWidth&&/scroll|auto/.test(getComputedStyle(r).overflowX)&&(i=r),r=r.assignedSlot||r.parentNode;else if(r.nodeType==11)r=r.host;else break;return{x:i,y:s}}function Rh(n){let e=[];for(let t=n;t;t=t.nodeType==11?t.host:t.parentNode)se(t)&&e.push({node:t,left:t.scrollLeft,top:t.scrollTop});return e}function Ph(n,e=!0){for(let{node:t,left:i,top:s}of n)e&&t.scrollTop!=s&&(t.scrollTop=s),t.scrollLeft!=i&&(t.scrollLeft=i)}function Ih(n){if(n.setActive)return n.setActive();if(Wt)return n.focus(Wt);let e=Rh(n);n.focus(Wt==null?{get preventScroll(){return Wt={preventScroll:!0},!0}}:void 0),Wt||(Wt=!1,Ph(e))}function nn(n,e,t=e){let i=Ja||(Ja=document.createRange());return i.setEnd(n,t),i.setStart(n,e),i}function pi(n,e,t,i){let s={key:e,code:e,keyCode:t,which:t,cancelable:!0};i&&({altKey:s.altKey,ctrlKey:s.ctrlKey,shiftKey:s.shiftKey,metaKey:s.metaKey}=i);let r=new KeyboardEvent("keydown",s);r.synthetic=!0,n.dispatchEvent(r);let o=new KeyboardEvent("keyup",s);return o.synthetic=!0,n.dispatchEvent(o),r.defaultPrevented||o.defaultPrevented}function Fd(n){for(;n;){if(n&&(n.nodeType==9||n.nodeType==11&&n.host))return n;n=n.assignedSlot||n.parentNode}return null}function Hd(n,e){let t=e.focusNode,i=e.focusOffset;if(!t||e.anchorNode!=t||e.anchorOffset!=i)return!1;for(i=Math.min(i,mt(t));;)if(i){if(!se(t))return!1;let s=t.childNodes[i-1];s.contentEditable=="false"?i--:(t=s,i=mt(t))}else{if(t==n)return!0;i=wt(t),t=t.parentNode}}function Nh(n){return n instanceof Window?n.pageYOffset>Math.max(0,n.document.documentElement.scrollHeight-n.innerHeight-4):n.scrollTop>Math.max(1,n.scrollHeight-n.clientHeight-4)}function Fh(n,e){for(let t=n,i=e;;){if(mi(t)&&i>0)return{node:t,offset:i};if(se(t)&&i>0){if(t.contentEditable=="false")return null;t=t.childNodes[i-1],i=mt(t)}else if(t.parentNode&&!as(t))i=wt(t),t=t.parentNode;else return null}}function Hh(n,e){for(let t=n,i=e;;){if(mi(t)&&i<t.nodeValue.length)return{node:t,offset:i};if(se(t)&&i<t.childNodes.length){if(t.contentEditable=="false")return null;t=t.childNodes[i],i=0}else if(t.parentNode&&!as(t))i=wt(t)+1,t=t.parentNode;else return null}}function Wh(n){let e=[];for(let t=0;t<n.length;t++)e.push(1<<+n[t]);return e}function Vh(n){return n<=247?Wd[n]:1424<=n&&n<=1524?2:1536<=n&&n<=1785?Vd[n-1536]:1774<=n&&n<=2220?4:8192<=n&&n<=8204?256:64336<=n&&n<=65023?4:1}function zh(n,e){if(n.length!=e.length)return!1;for(let t=0;t<n.length;t++){let i=n[t],s=e[t];if(i.from!=s.from||i.to!=s.to||i.direction!=s.direction||!zh(i.inner,s.inner))return!1}return!0}function qd(n,e,t,i,s){for(let r=0;r<=i.length;r++){let o=r?i[r-1].to:e,l=r<i.length?i[r].from:t,a=r?256:s;for(let h=o,c=a,f=a;h<l;h++){let u=Vh(n.charCodeAt(h));u==512?u=c:u==8&&f==4&&(u=16),U[h]=u==4?2:u,u&7&&(f=u),c=u}for(let h=o,c=a,f=a;h<l;h++){let u=U[h];if(u==128)h<l-1&&c==U[h+1]&&c&24?u=U[h]=c:U[h]=256;else if(u==64){let d=h+1;for(;d<l&&U[d]==64;)d++;let p=h&&c==8||d<t&&U[d]==8?f==1?1:8:256;for(let m=h;m<d;m++)U[m]=p;h=d-1}else u==8&&f==1&&(U[h]=1);c=u,u&7&&(f=u)}}}function Kd(n,e,t,i,s){let r=s==1?2:1;for(let o=0,l=0,a=0;o<=i.length;o++){let h=o?i[o-1].to:e,c=o<i.length?i[o].from:t;for(let f=h,u,d,p;f<c;f++)if(d=Qr[u=n.charCodeAt(f)])if(d<0){for(let m=l-3;m>=0;m-=3)if(tt[m+1]==-d){let g=tt[m+2],y=g&2?s:g&4?g&1?r:s:0;y&&(U[f]=U[tt[m]]=y),l=m;break}}else{if(tt.length==189)break;tt[l++]=f,tt[l++]=u,tt[l++]=a}else if((p=U[f])==2||p==1){let m=p==s;a=m?0:1;for(let g=l-3;g>=0;g-=3){let y=tt[g+2];if(y&2)break;if(m)tt[g+2]|=2;else{if(y&4)break;tt[g+2]|=4}}}}}function $d(n,e,t,i){for(let s=0,r=i;s<=t.length;s++){let o=s?t[s-1].to:n,l=s<t.length?t[s].from:e;for(let a=o;a<l;){let h=U[a];if(h==256){let c=a+1;for(;;)if(c==l){if(s==t.length)break;c=t[s++].to,l=s<t.length?t[s].from:e}else if(U[c]==256)c++;else break;let f=r==1,u=(c<e?U[c]:i)==1,d=f==u?f?1:2:i;for(let p=c,m=s,g=m?t[m-1].to:n;p>a;)p==g&&(p=t[--m].from,g=m?t[m-1].to:n),U[--p]=d;a=c}else r=h,a++}}}function Zr(n,e,t,i,s,r,o){let l=i%2?2:1;if(i%2==s%2)for(let a=e,h=0;a<t;){let c=!0,f=!1;if(h==r.length||a<r[h].from){let m=U[a];m!=l&&(c=!1,f=m==16)}let u=!c&&l==1?[]:null,d=c?i:i+1,p=a;e:for(;;)if(h<r.length&&p==r[h].from){if(f)break e;let m=r[h];if(!c)for(let g=m.to,y=h+1;;){if(g==t)break e;if(y<r.length&&r[y].from==g)g=r[y++].to;else{if(U[g]==l)break e;break}}if(h++,u)u.push(m);else{m.from>a&&o.push(new ze(a,m.from,d));let g=m.direction==gi!=!(d%2);eo(n,g?i+1:i,s,m.inner,m.from,m.to,o),a=m.to}p=m.to}else{if(p==t||(c?U[p]!=l:U[p]==l))break;p++}u?Zr(n,a,p,i+1,s,u,o):a<p&&o.push(new ze(a,p,d)),a=p}else for(let a=t,h=r.length;a>e;){let c=!0,f=!1;if(!h||a>r[h-1].to){let m=U[a-1];m!=l&&(c=!1,f=m==16)}let u=!c&&l==1?[]:null,d=c?i:i+1,p=a;e:for(;;)if(h&&p==r[h-1].to){if(f)break e;let m=r[--h];if(!c)for(let g=m.from,y=h;;){if(g==e)break e;if(y&&r[y-1].to==g)g=r[--y].from;else{if(U[g-1]==l)break e;break}}if(u)u.push(m);else{m.to<a&&o.push(new ze(m.to,a,d));let g=m.direction==gi!=!(d%2);eo(n,g?i+1:i,s,m.inner,m.from,m.to,o),a=m.from}p=m.from}else{if(p==e||(c?U[p-1]!=l:U[p-1]==l))break;p--}u?Zr(n,p,a,i+1,s,u,o):p<a&&o.push(new ze(p,a,d)),a=p}}function eo(n,e,t,i,s,r,o){let l=e%2?2:1;qd(n,s,r,i,l),Kd(n,s,r,i,l),$d(s,r,i,l),Zr(n,s,r,e,t,i,o)}function jd(n,e,t){if(!n)return[new ze(0,0,e==Go?1:0)];if(e==gi&&!t.length&&!zd.test(n))return qh(n.length);if(t.length)for(;n.length>U.length;)U[U.length]=256;let i=[],s=e==gi?0:1;return eo(n,s,s,t,0,n.length,i),i}function qh(n){return[new ze(0,n,0)]}function Ud(n,e,t,i,s){var r;if(!n.length)return null;let o=i.head-n.from,l;if(i.head==n.from&&i.assoc<0){if(!s)return null;o=e[l=0].side(!1,t)}else if(i.head==n.to&&i.assoc>0){if(s)return null;o=e[l=e.length-1].side(!0,t)}else l=ze.find(e,o,(r=i.bidiLevel)!==null&&r!==void 0?r:-1,i.assoc);let a=e[l],h=a.side(s,t);if(o==h){let u=l+=s?1:-1;if(u<0||u>=e.length)return null;a=e[l=u],o=a.side(!s,t),h=a.side(s,t)}let c=ee(n.text,o,a.forward(s,t));(c<a.from||c>a.to)&&(c=h),Kh=n.text.slice(Math.min(o,c),Math.max(o,c));let f=l==(s?e.length-1:0)?null:e[l+(s?1:-1)];if(c==h){if(!f)return s?b.cursor(n.to,1):b.cursor(n.from,-1);if(f.level+(s?0:1)<a.level)return b.cursor(f.side(!s,t)+n.from,f.forward(s,t)?1:-1,f.level)}return b.cursor(c+n.from,a.forward(s,t)?-1:1,a.level)}function Gd(n,e,t){for(let i=e;i<t;i++){let s=Vh(n.charCodeAt(i));if(s==1)return gi;if(s==2||s==4)return Go}}function he(n,e,t){let i=n.facet(Gh);i.length?i[0](e):window.onerror&&window.onerror(String(e),t,void 0,void 0,e)||(t?console.error(t+":",e):console.error(e))}function Qa(n,e){let t=n.state.facet(ic);if(!t.length)return t;let i=t.map(r=>r instanceof Function?r(n):r),s=[];return H.spans(i,e.from,e.to,{point(){},span(r,o,l,a){let h=r-e.from,c=o-e.from,f=s;for(let u=l.length-1;u>=0;u--,a--){let d=l[u].spec.bidiIsolate,p;if(a>0&&f.length&&(p=f[f.length-1]).to==h&&p.direction==d)p.to=c,f=p.inner;else{let m={from:h,to:c,direction:d,inner:[]};f.push(m),f=m.inner}}}}),nc(e.text,s)}function nc(n,e){for(let t of e){if(t.direction==null){for(let i=t.from,s=0;i<t.to;s++){let r=s<t.inner.length?t.inner[s]:null,o=Gd(n,i,r?r.from:t.to);if(o){t.direction=o;break}if(!r)break;i=r.to}t.direction==null&&(t.direction=q.LTR)}nc(n,t.inner)}return e}function Qo(n){let e=0,t=0,i=0,s=0;for(let r of n.state.facet(sc)){let o=r(n);o&&(o.left!=null&&(e=Math.max(e,o.left)),o.right!=null&&(t=Math.max(t,o.right)),o.top!=null&&(i=Math.max(i,o.top)),o.bottom!=null&&(s=Math.max(s,o.bottom)))}return{left:e,right:t,top:i,bottom:s}}function Za(n){let e=n.nextSibling;return n.parentNode.removeChild(n),e}function Xd(n){let e=n.dom.lastChild;if(!e)return n.dom.getBoundingClientRect();let t=es(e);return t[t.length-1]||null}function Jd(n,e){let t=n.coordsIn(0,1),i=e.coordsIn(0,1);return t&&i&&i.top<t.bottom}function eh(n,e){let t=i=>{for(let s of i.children)if((e?s.isText():s.length)||t(s))return!0;return!1};return t(n)}function Qd(n){let e=n.isReplace?(n.startSide<0?64:0)|(n.endSide>0?128:0):n.startSide>0?32:16;return n.block&&(e|=256),e}function Zd(n,e){let t=e.spec.attributes,i=e.spec.class;return!t&&!i||(n||(n={class:"cm-line"}),t&&jo(t,n),i&&(n.class+=" "+i)),n}function ep(n){let e=[];for(let t=n.parents.length;t>1;t--){let i=t==n.parents.length?n.tile:n.parents[t].tile;i instanceof Ce&&e.push(i.mark)}return e}function Wr(n){let e=X.get(n);return e&&e.setDOM(n.cloneNode()),n}function ao(n,e){let t=e?.get(n);if(t!=1){t==null&&n.destroy();for(let i of n.children)ao(i,e)}}function tp(n){return se(n.node)&&n.node.firstChild&&(n.offset==0||n.node.childNodes[n.offset-1].contentEditable=="false")&&(n.offset==n.node.childNodes.length||n.node.childNodes[n.offset].contentEditable=="false")}function oc(n,e){let t=n.observer.selectionRange;if(!t.focusNode)return null;let i=Fh(t.focusNode,t.focusOffset),s=Hh(t.focusNode,t.focusOffset),r=i||s;if(s&&i&&s.node!=i.node){let l=X.get(s.node);if(!l||l.isText()&&l.text!=s.node.nodeValue)r=s;else if(n.docView.lastCompositionAfterCursor){let a=X.get(i.node);!a||a.isText()&&a.text!=i.node.nodeValue||(r=s)}}if(n.docView.lastCompositionAfterCursor=r!=i,!r)return null;let o=e-r.offset;return{from:o,to:o+r.node.nodeValue.length,node:r.node}}function ip(n,e,t){let i=oc(n,t);if(!i)return null;let{node:s,from:r,to:o}=i,l=s.nodeValue;if(/[\n\r]/.test(l)||n.state.doc.sliceString(i.from,i.to)!=l)return null;let a=e.invertedDesc;return{range:new Ue(a.mapPos(r),a.mapPos(o),r,o),text:s}}function np(n,e){return se(n)?(e&&n.childNodes[e-1].contentEditable=="false"?1:0)|(e<n.childNodes.length&&n.childNodes[e].contentEditable=="false"?2:0):0}function rp(n,e,t){let i=new sp;return H.compare(n,e,t,i),i.changes}function op(n,e,t){let i=new ho;return H.compare(n,e,t,i),i.changes}function lp(n,e){for(let t=n;t&&t!=e;t=t.assignedSlot||t.parentNode)if(se(t)&&t.contentEditable=="false")return!0;return!1}function ap(n,e){let t=!1;return e&&n.iterChangedRanges((i,s)=>{i<e.to&&s>e.from&&(t=!0)}),t}function hp(n,e,t=1){let i=n.charCategorizer(e),s=n.doc.lineAt(e),r=e-s.from;if(s.length==0)return b.cursor(e);r==0?t=1:r==s.length&&(t=-1);let o=r,l=r;t<0?o=ee(s.text,r,!1):l=ee(s.text,r);let a=i(s.text.slice(o,l));for(;o>0;){let h=ee(s.text,o,!1);if(i(s.text.slice(h,o))!=a)break;o=h}for(;l<s.length;){let h=ee(s.text,l);if(i(s.text.slice(l,h))!=a)break;l=h}return b.undirectionalRange(o+s.from,l+s.from)}function cp(n,e,t,i,s){let r=Math.round((i-e.left)*n.defaultCharacterWidth);if(n.lineWrapping&&t.height>n.defaultLineHeight*1.5){let l=n.viewState.heightOracle.textHeight,a=Math.floor((s-t.top-(n.defaultLineHeight-l)*.5)/l);r+=a*n.viewState.heightOracle.lineLength}let o=n.state.sliceDoc(t.from,t.to);return t.from+qn(o,r,n.state.tabSize)}function co(n,e,t){let i=n.lineBlockAt(e);if(Array.isArray(i.type)){let s;for(let r of i.type){if(r.from>e)break;if(!(r.to<e)){if(r.from<e&&r.to>e)return r;(!s||r.type==ce.Text&&(s.type!=r.type||(t<0?r.from<e:r.to>e)))&&(s=r)}}return s||i}return i}function fp(n,e,t,i){let s=co(n,e.head,e.assoc||-1),r=!i||s.type!=ce.Text||!(n.lineWrapping||s.widgetLineBreaks)?null:n.coordsAtPos(e.assoc<0&&e.head>s.from?e.head-1:e.head);if(r){let o=n.dom.getBoundingClientRect(),l=n.textDirectionAt(s.from),a=n.posAndSideAtCoords({x:t==(l==q.LTR)?o.right-1:o.left+1,y:(r.top+r.bottom)/2});if(a)return b.cursor(a.pos,a.assoc)}return b.cursor(t?s.to:s.from,t?1:-1)}function th(n,e,t,i){let s=n.state.doc.lineAt(e.head),r=n.bidiSpans(s),o=n.textDirectionAt(s.from);for(let l=e,a=null;;){let h=Ud(s,r,o,l,t),c=Kh;if(!h){if(s.number==(t?n.state.doc.lines:1))return l;c=`
`,s=n.state.doc.line(s.number+(t?1:-1)),r=n.bidiSpans(s),h=t?b.cursor(s.from,-1):b.cursor(s.to,1)}if(a){if(!a(c))return l}else{if(!i)return h;a=i(c)}l=h}}function up(n,e,t){let i=n.state.charCategorizer(e),s=i(t);return r=>{let o=i(r);return s==$.Space&&(s=o),s==o}}function dp(n,e,t,i){let s=e.head,r=t?1:-1;if(s==(t?n.state.doc.length:0))return b.cursor(s,e.assoc);let o=e.goalColumn,l,a=n.contentDOM.getBoundingClientRect(),h=n.coordsAtPos(s,e.assoc||((e.empty?t:e.head==e.from)?1:-1)),c=n.documentTop;if(h)o==null&&(o=h.left-a.left),l=r<0?h.top:h.bottom;else{let p=n.viewState.lineBlockAt(s);o==null&&(o=Math.min(a.right-a.left,n.defaultCharacterWidth*(s-p.from))),l=(r<0?p.top:p.bottom)+c}let f=a.left+o,u=n.viewState.heightOracle.textHeight>>1,d=i??u;for(let p=0;;p+=u){let m=l+(d+p)*r,g=fo(n,{x:f,y:m},!1,r);if(t?m>a.bottom:m<a.top)return b.cursor(g.pos,g.assoc);let y=n.coordsAtPos(g.pos,g.assoc),k=y?(y.top+y.bottom)/2:0;if(!y||(t?k>l:k<l))return b.cursor(g.pos,g.assoc,void 0,o)}}function Yi(n,e,t){for(;;){let i=0;for(let s of n)s.between(e-1,e+1,(r,o,l)=>{if(e>r&&e<o){let a=i||t||(e-r<o-e?-1:1);e=a<0?r:o,i=a}});if(!i)return e}}function lc(n,e){let t=null;for(let i=0;i<e.ranges.length;i++){let s=e.ranges[i],r=null;if(s.empty){let o=Yi(n,s.from,0);o!=s.from&&(r=b.cursor(o,-1))}else{let o=Yi(n,s.from,-1),l=Yi(n,s.to,1);(o!=s.from||l!=s.to)&&(s.undirectional?r=b.undirectionalRange(s.from,s.to):r=b.range(s.from==s.anchor?o:l,s.from==s.head?o:l))}r&&(t||(t=e.ranges.slice()),t[i]=r)}return t?b.create(t,e.mainIndex):e}function zr(n,e,t){let i=Yi(n.state.facet(sn).map(s=>s(n)),t.from,e.head>t.from?-1:1);return i==t.from?t:b.cursor(i,i<t.from?1:-1)}function fo(n,e,t,i){let s=n.contentDOM.getBoundingClientRect(),r=s.top+n.viewState.paddingTop,{x:o,y:l}=e,a=l-r,h;for(;;){if(a<0)return new Ve(0,1);if(a>n.viewState.docHeight)return new Ve(n.state.doc.length,-1);if(h=n.elementAtHeight(a),i==null)break;if(h.type==ce.Text){if(i<0?h.to<n.viewport.from:h.from>n.viewport.to)break;let u=n.docView.coordsAt(i<0?h.from:h.to,i>0?-1:1);if(u&&(i<0?u.top<=a+r:u.bottom>=a+r))break}let f=n.viewState.heightOracle.textHeight/2;a=i>0?h.bottom+f:h.top-f}if(n.viewport.from>=h.to||n.viewport.to<=h.from){if(t)return null;if(h.type==ce.Text){let f=cp(n,s,h,o,l);return new Ve(f,f==h.from?1:-1)}}if(h.type!=ce.Text)return a<(h.top+h.bottom)/2?new Ve(h.from,1):new Ve(h.to,-1);let c=n.docView.lineAt(h.from,2);return(!c||c.length!=h.length)&&(c=n.docView.lineAt(h.from,-2)),new uo(n,o,l,n.textDirectionAt(h.from)).scanTile(c,h.from)}function pp(n,e,t){for(;;){if(!e||t<mt(e))return!1;if(e==n)return!0;t=wt(e)+1,e=e.parentNode}}function mp(n,e){let t;for(;!(n==e||!n);n=n.nextSibling){let i=X.get(n);if(!i?.isWidget())return!1;i&&(t||(t=[])).push(i)}if(t)for(let i of t){let s=i.overrideDOMText;if(s?.length)return!1}return!0}function ac(n,e,t,i){if(n.isComposite()){let s=-1,r=-1,o=-1,l=-1;for(let a=0,h=i,c=i;a<n.children.length;a++){let f=n.children[a],u=h+f.length;if(h<e&&u>t)return ac(f,e,t,h);if(u>=e&&s==-1&&(s=a,r=h),h>t&&f.dom.parentNode==n.dom){o=a,l=c;break}c=u,h=u+f.breakAfter}return{from:r,to:l<0?i+n.length:l,startDOM:(s?n.children[s-1].dom.nextSibling:null)||n.dom.firstChild,endDOM:o<n.children.length&&o>=0?n.children[o].dom:null}}else return n.isText()?{from:i,to:i+n.length,startDOM:n.dom,endDOM:n.dom.nextSibling}:null}function hc(n,e){let t,{newSel:i}=e,{state:s}=n,r=s.selection.main,o=n.inputState.lastKeyTime>Date.now()-100?n.inputState.lastKeyCode:-1;if(e.bounds){let{from:l,to:a}=e.bounds,h=r.from,c=null;(o===8||D.android&&e.text.length<a-l)&&(h=r.to,c="end");let f=s.doc.sliceString(l,a,ai),u,d;!r.empty&&r.from>=l&&r.to<=a&&(e.typeOver||f!=e.text)&&f.slice(0,r.from-l)==e.text.slice(0,r.from-l)&&f.slice(r.to-l)==e.text.slice(u=e.text.length-(f.length-(r.to-l)))?t={from:r.from,to:r.to,insert:N.of(e.text.slice(r.from-l,u).split(ai))}:(d=cc(f,e.text,h-l,c))&&(D.chrome&&o==13&&d.toB==d.from+2&&e.text.slice(d.from,d.toB)==ai+ai&&d.toB--,t={from:l+d.from,to:l+d.toA,insert:N.of(e.text.slice(d.from,d.toB).split(ai))})}else i&&(!n.hasFocus&&s.facet(dt)||go(i,r))&&(i=null);if(!t&&!i)return!1;if((D.mac||D.android)&&t&&t.from==t.to&&t.from==r.head-1&&/^\. ?$/.test(t.insert.toString())&&n.contentDOM.getAttribute("autocorrect")=="off"?(i&&t.insert.length==2&&(i=b.single(i.main.anchor-1,i.main.head-1)),t={from:t.from,to:t.to,insert:N.of([t.insert.toString().replace("."," ")])}):s.doc.lineAt(r.from).to<r.to&&n.docView.lineHasWidget(r.to)&&n.inputState.insertingTextAt>Date.now()-50?t={from:r.from,to:r.to,insert:s.toText(n.inputState.insertingText)}:D.chrome&&t&&t.from==t.to&&t.from==r.head&&t.insert.toString()==`
 `&&n.lineWrapping&&(i&&(i=b.single(i.main.anchor-1,i.main.head-1)),t={from:r.from,to:r.to,insert:N.of([" "])}),t)return Zo(n,t,i,o);if(i&&!go(i,r)){let l=!1,a="select";return n.inputState.lastSelectionTime>Date.now()-50&&(n.inputState.lastSelectionOrigin=="select"&&(l=!0),a=n.inputState.lastSelectionOrigin,a=="select.pointer"&&(i=lc(s.facet(sn).map(h=>h(n)),i))),n.dispatch({selection:i,scrollIntoView:l,userEvent:a}),!0}else return!1}function Zo(n,e,t,i=-1){if(D.ios&&n.inputState.flushIOSKey(e))return!0;let s=n.state.selection.main;if(D.android&&(e.to==s.to&&(e.from==s.from||e.from==s.from-1&&n.state.sliceDoc(e.from,s.from)==" ")&&e.insert.length==1&&e.insert.lines==2&&pi(n.contentDOM,"Enter",13)||(e.from==s.from-1&&e.to==s.to&&e.insert.length==0||i==8&&e.insert.length<e.to-e.from&&e.to>s.head)&&pi(n.contentDOM,"Backspace",8)||e.from==s.from&&e.to==s.to+1&&e.insert.length==0&&pi(n.contentDOM,"Delete",46)))return!0;let r=e.insert.toString();n.inputState.composing>=0&&n.inputState.composing++;let o,l=()=>o||(o=gp(n,e,t));return n.state.facet(_h).some(a=>a(n,e.from,e.to,r,l))||n.dispatch(l()),!0}function gp(n,e,t){let i,s=n.state,r=s.selection.main,o=-1;if(e.from==e.to&&e.from<r.from||e.from>r.to){let a=e.from<r.from?-1:1,h=a<0?r.from:r.to,c=Yi(s.facet(sn).map(f=>f(n)),h,a);e.from==c&&(o=c)}if(o>-1)i={changes:e,selection:b.cursor(e.from+e.insert.length,-1)};else if(e.from>=r.from&&e.to<=r.to&&e.to-e.from>=(r.to-r.from)/3&&(!t||t.main.empty&&t.main.from==e.from+e.insert.length)&&n.inputState.composing<0){let a=r.from<e.from?s.sliceDoc(r.from,e.from):"",h=r.to>e.to?s.sliceDoc(e.to,r.to):"";i=s.replaceSelection(n.state.toText(a+e.insert.sliceString(0,void 0,n.state.lineBreak)+h))}else{let a=s.changes(e),h=t&&t.main.to<=a.newLength?t.main:void 0;if(s.selection.ranges.length>1&&(n.inputState.composing>=0||n.inputState.compositionPendingChange)&&e.to<=r.to+10&&e.to>=r.to-10){let c=n.state.sliceDoc(e.from,e.to),f,u=t&&oc(n,t.main.head);if(u){let p=e.insert.length-(e.to-e.from);f={from:u.from,to:u.to-p}}else f=n.state.doc.lineAt(r.head);let d=r.to-e.to;i=s.changeByRange(p=>{if(p.from==r.from&&p.to==r.to)return{changes:a,range:h||p.map(a)};let m=p.to-d,g=m-c.length;if(n.state.sliceDoc(g,m)!=c||m>=f.from&&g<=f.to)return{range:p};let y=s.changes({from:g,to:m,insert:e.insert}),k=p.to-r.to;return{changes:y,range:h?b.range(Math.max(0,h.anchor+k),Math.max(0,h.head+k)):p.map(y)}})}else i={changes:a,selection:h&&s.selection.replaceRange(h)}}let l="input.type";return(n.composing||n.inputState.compositionPendingChange&&n.inputState.compositionEndedAt>Date.now()-50)&&(n.inputState.compositionPendingChange=!1,l+=".compose",n.inputState.compositionFirstChange&&(l+=".start",n.inputState.compositionFirstChange=!1)),s.update(i,{userEvent:l,scrollIntoView:!0})}function cc(n,e,t,i){let s=Math.min(n.length,e.length),r=0;for(;r<s&&n.charCodeAt(r)==e.charCodeAt(r);)r++;if(r==s&&n.length==e.length)return null;let o=n.length,l=e.length;for(;o>0&&l>0&&n.charCodeAt(o-1)==e.charCodeAt(l-1);)o--,l--;if(i=="end"){let a=Math.max(0,r-Math.min(o,l));t-=o+a-r}if(o<r&&n.length<e.length){let a=t<=r&&t>=o?r-t:0;r-=a,l=r+(l-o),o=r}else if(l<r){let a=t<=r&&t>=l?r-t:0;r-=a,o=r+(o-l),l=r}return{from:r,toA:o,toB:l}}function yp(n){let e=[];if(n.root.activeElement!=n.contentDOM)return e;let{anchorNode:t,anchorOffset:i,focusNode:s,focusOffset:r}=n.observer.selectionRange;return t&&(e.push(new ds(t,i)),(s!=t||r!=i)&&e.push(new ds(s,r))),e}function bp(n,e){if(n.length==0)return null;let t=n[0].pos,i=n.length==2?n[1].pos:t;return t<0||i<0?null:t==i?b.create([b.cursor(i+e,-1)]):b.single(t+e,i+e)}function go(n,e){return e.head==n.main.head&&e.anchor==n.main.anchor}function xp(n){return n.visualViewport?n.visualViewport.height*n.visualViewport.scale/n.document.documentElement.clientHeight<.85:!1}function ih(n,e){return(t,i)=>{try{return e.call(n,i,t)}catch(s){he(t.state,s)}}}function wp(n){let e=Object.create(null);function t(i){return e[i]||(e[i]={observers:[],handlers:[]})}for(let i of n){let s=i.spec,r=s&&s.plugin.domEventHandlers,o=s&&s.plugin.domEventObservers;if(r)for(let l in r){let a=r[l];a&&t(l).handlers.push(ih(i.value,a))}if(o)for(let l in o){let a=o[l];a&&t(l).observers.push(ih(i.value,a))}}for(let i in Ge)t(i).handlers.push(Ge[i]);for(let i in ke)t(i).observers.push(ke[i]);return e}function Gn(n){return Math.max(0,n)*.7+8}function vp(n,e){return Math.max(Math.abs(n.clientX-e.clientX),Math.abs(n.clientY-e.clientY))}function Sp(n,e){let t=n.state.facet($h);return t.length?t[0](e):D.mac?e.metaKey:e.ctrlKey}function Cp(n,e){let t=n.state.facet(jh);return t.length?t[0](e):D.mac?!e.altKey:!e.ctrlKey}function Ap(n,e){let{main:t}=n.state.selection;if(t.empty)return!1;let i=tn(n.root);if(!i||i.rangeCount==0)return!0;let s=i.getRangeAt(0).getClientRects();for(let r=0;r<s.length;r++){let o=s[r];if(o.left<=e.clientX&&o.right>=e.clientX&&o.top<=e.clientY&&o.bottom>=e.clientY)return!0}return!1}function Mp(n,e){if(!e.bubbles)return!0;if(e.defaultPrevented)return!1;for(let t=e.target,i;t!=n.contentDOM;t=t.parentNode)if(!t||t.nodeType==11||(i=X.get(t))&&i.isWidget()&&!i.isHidden&&i.widget.ignoreEvent(e))return!1;return!0}function Tp(n){let e=n.dom.parentNode;if(!e)return;let t=e.appendChild(document.createElement("textarea"));t.style.cssText="position: fixed; left: -10000px; top: 10px",t.focus(),setTimeout(()=>{n.focus(),t.remove(),pc(n,t.value)},50)}function As(n,e,t){for(let i of n.facet(e))t=i(t,n);return t}function pc(n,e){e=As(n.state,_o,e);let{state:t}=n,i,s=1,r=t.toText(e),o=r.lines==t.selection.ranges.length;if(xo!=null&&t.selection.ranges.every(a=>a.empty)&&xo==r.toString()){let a=-1;i=t.changeByRange(h=>{let c=t.doc.lineAt(h.from);if(c.from==a)return{range:h};a=c.from;let f=t.toText((o?r.line(s++).text:e)+t.lineBreak);return{changes:{from:c.from,insert:f},range:b.cursor(h.from+f.length,-1)}})}else o?i=t.changeByRange(a=>{let h=r.line(s++);return{changes:{from:a.from,to:a.to,insert:h.text},range:b.cursor(a.from+h.length,-1)}}):i=t.replaceSelection(r);n.dispatch(i,{userEvent:"input.paste",scrollIntoView:!0})}function nh(n,e,t,i){if(i==1)return b.cursor(e,t);if(i==2)return hp(n.state,e,t);{let s=n.docView.lineAt(e,t),r=n.state.doc.lineAt(s?s.posAtEnd:e),o=s?s.posAtStart:r.from,l=s?s.posAtEnd:r.to;return l<n.state.doc.length&&l==r.to&&l++,b.undirectionalRange(o,l)}}function mc(n){if(!Dp)return n.detail;let e=sh,t=oh;return sh=n,oh=Date.now(),rh=!e||t>Date.now()-400&&Math.abs(e.clientX-n.clientX)<2&&Math.abs(e.clientY-n.clientY)<2?(rh+1)%3:1}function Op(n,e){let t=n.posAndSideAtCoords({x:e.clientX,y:e.clientY},!1),i=mc(e),s=n.state.selection;return{update(r){r.docChanged&&(t.pos=r.changes.mapPos(t.pos),s=s.map(r.changes))},get(r,o,l){let a=n.posAndSideAtCoords({x:r.clientX,y:r.clientY},!1),h,c=nh(n,a.pos,a.assoc,i);if(t.pos!=a.pos&&!o){let f=nh(n,t.pos,t.assoc,i),u=Math.min(f.from,c.from),d=Math.max(f.to,c.to);c=u<c.from?b.range(u,d,c.assoc):b.range(d,u,c.assoc)}return o?s.replaceRange(s.main.extend(c.from,c.to,c.assoc)):l&&i==1&&s.ranges.length>1&&(h=Bp(s,a.pos))?h:l?s.addRange(c):b.create([c])}}}function Bp(n,e){for(let t=0;t<n.ranges.length;t++){let{from:i,to:s}=n.ranges[t];if(i<=e&&s>=e)return b.create(n.ranges.slice(0,t).concat(n.ranges.slice(t+1)),n.mainIndex==t?0:n.mainIndex-(n.mainIndex>t?1:0))}return null}function lh(n,e,t,i){if(t=As(n.state,_o,t),!t)return;let s=n.posAtCoords({x:e.clientX,y:e.clientY},!1),{draggedContent:r}=n.inputState,o=i&&r&&Cp(n,e)?{from:r.from,to:r.to}:null,l={from:s,insert:t},a=n.state.changes(o?[o,l]:l);n.focus(),n.dispatch({changes:a,selection:{anchor:a.mapPos(s,-1),head:a.mapPos(s,1)},userEvent:o?"move.drop":"input.drop"}),n.inputState.draggedContent=null}function Lp(n,e){let t=n.dom.parentNode;if(!t)return;let i=t.appendChild(document.createElement("textarea"));i.style.cssText="position: fixed; left: -10000px; top: 10px",i.value=e,i.focus(),i.selectionEnd=e.length,i.selectionStart=0,setTimeout(()=>{i.remove(),n.focus()},50)}function Ep(n){let e=[],t=[],i=!1;for(let s of n.selection.ranges)s.empty||(e.push(n.sliceDoc(s.from,s.to)),t.push(s));if(!e.length){let s=-1;for(let{from:r}of n.selection.ranges){let o=n.doc.lineAt(r);o.number>s&&(e.push(o.text),t.push({from:o.from,to:Math.min(n.doc.length,o.to+1)})),s=o.number}i=!0}return{text:As(n,Yo,e.join(n.lineBreak)),ranges:t,linewise:i}}function yc(n,e){let t=[];for(let i of n.facet(Yh)){let s=i(n,e);s&&t.push(s)}return t.length?n.update({effects:t,annotations:gc.of(!0)}):null}function bc(n){setTimeout(()=>{let e=n.hasFocus;if(e!=n.inputState.notifiedFocused){let t=yc(n.state,e);t?n.dispatch(t):n.update([])}},10)}function Rp(n){ah.has(n)||(ah.add(n),n.addEventListener("copy",()=>{}),n.addEventListener("cut",()=>{}))}function ch(){ki=!1}function ps(n,e){return n==e?n:(n.constructor!=e.constructor&&(ki=!0),e)}function fh(n,e){let t,i;n[e]==null&&(t=n[e-1])instanceof xt&&(i=n[e+1])instanceof xt&&n.splice(e-1,3,new xt(t.length+1+i.length))}function Np(n,e,t){let i=new Co;return H.compare(n,e,t,i,0),i.changes}function Fp(n,e){let t=n.getBoundingClientRect(),i=n.ownerDocument,s=i.defaultView||window,r=Math.max(0,t.left),o=Math.min(s.innerWidth,t.right),l=Math.max(0,t.top),a=Math.min(s.innerHeight,t.bottom);for(let h=n.parentNode;h&&h!=i.body;)if(se(h)){let c=window.getComputedStyle(h);if((h.scrollHeight>h.clientHeight||h.scrollWidth>h.clientWidth)&&c.overflow!="visible"){let f=h.getBoundingClientRect();r=Math.max(r,f.left),o=Math.min(o,f.right),l=Math.max(l,f.top),a=Math.min(h==n.parentNode?s.innerHeight:a,f.bottom)}h=c.position=="absolute"||c.position=="fixed"?h.offsetParent:h.parentNode}else if(h.nodeType==11)h=h.host;else break;return{left:r-t.left,right:Math.max(r,o)-t.left,top:l-(t.top+e),bottom:Math.max(l,a)-(t.top+e)}}function Hp(n){let e=n.getBoundingClientRect(),t=n.ownerDocument.defaultView||window;return e.left<t.innerWidth&&e.right>0&&e.top<t.innerHeight&&e.bottom>0}function Wp(n,e){let t=n.getBoundingClientRect();return{left:0,right:t.right-t.left,top:e,bottom:t.bottom-(t.top+e)}}function Vp(n,e,t){let i=[],s=n,r=0;return H.spans(t,n,e,{span(){},point(o,l){o>s&&(i.push({from:s,to:o}),r+=o-s),s=l}},20),s<e&&(i.push({from:s,to:e}),r+=e-s),{total:r,ranges:i}}function _n({total:n,ranges:e},t){if(t<=0)return e[0].from;if(t>=1)return e[e.length-1].to;let i=Math.floor(n*t);for(let s=0;;s++){let{from:r,to:o}=e[s],l=o-r;if(i<=l)return r+i;i-=l}}function Yn(n,e){let t=0;for(let{from:i,to:s}of n.ranges){if(e<=s){t+=e-i;break}t+=s-i}return t/n.total}function zp(n,e){for(let t of n)if(e(t))return t}function uh(n){let e=n.facet(Cs).filter(i=>typeof i!="function"),t=n.facet(Jo).filter(i=>typeof i!="function");return t.length&&e.push(H.join(t)),e}function qi(n,e){if(e.scale==1)return n;let t=e.toDOM(n.top),i=e.toDOM(n.bottom);return new je(n.from,n.length,t,i-t,Array.isArray(n._content)?n._content.map(s=>qi(s,e)):n._content)}function Bo(n,e,t){return new He(e,{finish(i){return/&/.test(i)?i.replace(/&\w*/,s=>{if(s=="&")return n;if(!t||!t[s])throw new RangeError(`Unsupported selector: ${s}`);return t[s]}):n+" "+i}})}function dh(n,e,t){for(;e;){let i=X.get(e);if(i&&i.parent==n)return i;let s=e.parentNode;e=s!=n.dom?s:t>0?e.nextSibling:e.previousSibling}return null}function ph(n,e){let t=e.startContainer,i=e.startOffset,s=e.endContainer,r=e.endOffset,o=n.docView.domAtPos(n.state.selection.main.anchor,1);return ji(o.node,o.offset,s,r)&&([t,i,s,r]=[s,r,t,i]),{anchorNode:t,anchorOffset:i,focusNode:s,focusOffset:r}}function $p(n,e){if(e.getComposedRanges){let s=e.getComposedRanges(n.root)[0];if(s)return ph(n,s)}let t=null;function i(s){s.preventDefault(),s.stopImmediatePropagation(),t=s.getTargetRanges()[0]}return n.contentDOM.addEventListener("beforeinput",i,!0),n.dom.ownerDocument.execCommand("indent"),n.contentDOM.removeEventListener("beforeinput",i,!0),t?ph(n,t):null}function gh(n,e,t){for(let i=n.state.facet(e),s=i.length-1;s>=0;s--){let r=i[s],o=typeof r=="function"?r(n):r;o&&jo(o,t)}return t}function Gp(n,e){let t=n.split(/-(?!$)/),i=t[t.length-1];i=="Space"&&(i=" ");let s,r,o,l;for(let a=0;a<t.length-1;++a){let h=t[a];if(/^(cmd|meta|m)$/i.test(h))l=!0;else if(/^a(lt)?$/i.test(h))s=!0;else if(/^(c|ctrl|control)$/i.test(h))r=!0;else if(/^s(hift)?$/i.test(h))o=!0;else if(/^mod$/i.test(h))e=="mac"?l=!0:r=!0;else throw new Error("Unrecognized modifier name: "+h)}return s&&(i="Alt-"+i),r&&(i="Ctrl-"+i),l&&(i="Meta-"+i),o&&(i="Shift-"+i),i}function Jn(n,e,t){return e.altKey&&(n="Alt-"+n),e.ctrlKey&&(n="Ctrl-"+n),e.metaKey&&(n="Meta-"+n),t!==!1&&e.shiftKey&&(n="Shift-"+n),n}function vc(n){let e=n.facet(vt),t=yh.get(e);return t||yh.set(e,t=Xp(e.reduce((i,s)=>i.concat(s),[]))),t}function Sc(n,e,t){return Cc(vc(n.state),e,n,t)}function Xp(n,e=Up){let t=Object.create(null),i=Object.create(null),s=(o,l)=>{let a=i[o];if(a==null)i[o]=l;else if(a!=l)throw new Error("Key binding "+o+" is used both as a regular binding and as a multi-stroke prefix")},r=(o,l,a,h,c)=>{var f,u;let d=t[o]||(t[o]=Object.create(null)),p=l.split(/ (?!$)/).map(y=>Gp(y,e));for(let y=1;y<p.length;y++){let k=p.slice(0,y).join(" ");s(k,!0),d[k]||(d[k]={preventDefault:!0,stopPropagation:!1,run:[x=>{let O=bt={view:x,prefix:k,scope:o};return setTimeout(()=>{bt==O&&(bt=null)},Yp),!0}]})}let m=p.join(" ");s(m,!1);let g=d[m]||(d[m]={preventDefault:!1,stopPropagation:!1,run:((u=(f=d._any)===null||f===void 0?void 0:f.run)===null||u===void 0?void 0:u.slice())||[]});a&&g.run.push(a),h&&(g.preventDefault=!0),c&&(g.stopPropagation=!0)};for(let o of n){let l=o.scope?o.scope.split(" "):["editor"];if(o.any)for(let h of l){let c=t[h]||(t[h]=Object.create(null));c._any||(c._any={preventDefault:!1,stopPropagation:!1,run:[]});let{any:f}=o;for(let u in c)c[u].run.push(d=>f(d,Ro))}let a=o[e]||o.key;if(a)for(let h of l)r(h,a,o.run,o.preventDefault,o.stopPropagation),o.shift&&r(h,"Shift-"+a,o.shift,o.preventDefault,o.stopPropagation)}return t}function Cc(n,e,t,i){Ro=e;let s=Ka(e),r=ae(s,0),o=Oe(r)==s.length&&s!=" ",l="",a=!1,h=!1,c=!1;bt&&bt.view==t&&bt.scope==i&&(l=bt.prefix+" ",uc.indexOf(e.keyCode)<0&&(h=!0,bt=null));let f=new Set,u=g=>{if(g){for(let y of g.run)if(!f.has(y)&&(f.add(y),y(t)))return g.stopPropagation&&(c=!0),!0;g.preventDefault&&(g.stopPropagation&&(c=!0),h=!0)}return!1},d=n[i],p,m;return d&&(u(d[l+Jn(s,e,!o)])?a=!0:o&&(e.altKey||e.metaKey||e.ctrlKey)&&!(D.windows&&e.ctrlKey&&e.altKey)&&!(D.mac&&e.altKey&&!(e.ctrlKey||e.metaKey))&&(p=ut[e.keyCode])&&p!=s?(u(d[l+Jn(p,e,!0)])||e.shiftKey&&(m=li[e.keyCode])!=s&&m!=p&&u(d[l+Jn(m,e,!1)]))&&(a=!0):o&&e.shiftKey&&u(d[l+Jn(s,e,!0)])&&(a=!0),!a&&u(d._any)&&(a=!0)),h&&(a=!0),a&&c&&e.stopPropagation(),Ro=null,a}function Ac(n){let e=n.scrollDOM.getBoundingClientRect();return{left:(n.textDirection==q.LTR?e.left:e.right-n.scrollDOM.clientWidth*n.scaleX)-n.scrollDOM.scrollLeft*n.scaleX,top:e.top-n.scrollDOM.scrollTop*n.scaleY}}function bh(n,e,t,i){let s=n.coordsAtPos(e,t*2);if(!s)return i;let r=n.dom.getBoundingClientRect(),o=(s.top+s.bottom)/2,l=n.posAtCoords({x:r.left+1,y:o}),a=n.posAtCoords({x:r.right-1,y:o});return l==null||a==null?i:{from:Math.max(i.from,Math.min(l,a)),to:Math.min(i.to,Math.max(l,a))}}function Jp(n,e,t){if(t.to<=n.viewport.from||t.from>=n.viewport.to)return[];let i=Math.max(t.from,n.viewport.from),s=Math.min(t.to,n.viewport.to),r=n.textDirection==q.LTR,o=n.contentDOM,l=o.getBoundingClientRect(),a=Ac(n),h=o.querySelector(".cm-line"),c=h&&window.getComputedStyle(h),f=l.left+(c?parseInt(c.paddingLeft)+Math.min(0,parseInt(c.textIndent)):0),u=l.right-(c?parseInt(c.paddingRight):0),d=co(n,i,1),p=co(n,s,-1),m=d.type==ce.Text?d:null,g=p.type==ce.Text?p:null;if(m&&(n.lineWrapping||d.widgetLineBreaks)&&(m=bh(n,i,1,m)),g&&(n.lineWrapping||p.widgetLineBreaks)&&(g=bh(n,s,-1,g)),m&&g&&m.from==g.from&&m.to==g.to)return k(x(t.from,t.to,m));{let w=m?x(t.from,null,m):O(d,!1),S=g?x(null,t.to,g):O(p,!0),C=[];return(m||d).to<(g||p).from-(m&&g?1:0)||d.widgetLineBreaks>1&&w.bottom+n.defaultLineHeight/2<S.top?C.push(y(f,w.bottom,u,S.top)):w.bottom<S.top&&n.elementAtHeight((w.bottom+S.top)/2).type==ce.Text&&(w.bottom=S.top=(w.bottom+S.top)/2),k(w).concat(C).concat(k(S))}function y(w,S,C,R){return new zt(e,w-a.left,S-a.top,Math.max(0,C-w),R-S)}function k({top:w,bottom:S,horizontal:C}){let R=[];for(let F=0;F<C.length;F+=2)R.push(y(C[F],w,C[F+1],S));return R}function x(w,S,C){let R=1e9,F=-1e9,j=[];function I(z,Y,fe,Te,Ze){let le=n.coordsAtPos(z,z==C.to?-2:2),Ie=n.coordsAtPos(fe,fe==C.from?2:-2);!le||!Ie||(R=Math.min(le.top,Ie.top,R),F=Math.max(le.bottom,Ie.bottom,F),Ze==q.LTR?j.push(r&&Y?f:le.left,r&&Te?u:Ie.right):j.push(!r&&Te?f:Ie.left,!r&&Y?u:le.right))}let E=w??C.from,K=S??C.to;for(let z of n.visibleRanges)if(z.to>E&&z.from<K)for(let Y=Math.max(z.from,E),fe=Math.min(z.to,K);;){let Te=n.state.doc.lineAt(Y);for(let Ze of n.bidiSpans(Te)){let le=Ze.from+Te.from,Ie=Ze.to+Te.from;if(le>=fe)break;Ie>Y&&I(Math.max(le,Y),w==null&&le<=E,Math.min(Ie,fe),S==null&&Ie>=K,Ze.dir)}if(Y=Te.to+1,Y>=fe)break}return j.length==0&&I(E,w==null,K,S==null,n.textDirection),{top:R,bottom:F,horizontal:j}}function O(w,S){let C=l.top+(S?w.top:w.bottom);return{top:C,bottom:C,horizontal:[]}}}function Qp(n,e){return n.constructor==e.constructor&&n.eq(e)}function Mc(n){return[_.define(e=>new Po(e,n)),is.of(n)]}function Tc(n={}){return[vi.of(n),Zp,em,im,Jh.of(!0)]}function Dc(n){return n.startState.facet(vi)!=n.state.facet(vi)}function xh(n,e){e.style.animationDuration=n.facet(vi).cursorBlinkRate+"ms"}function Bc(){return[Ki,nm]}function wh(n,e,t,i,s){e.lastIndex=0;for(let r=n.iterRange(t,i),o=t,l;!r.next().done;o+=r.value.length)if(!r.lineBreak)for(;l=e.exec(r.value);)s(o+l.index,l)}function sm(n,e){let t=n.visibleRanges;if(t.length==1&&t[0].from==n.viewport.from&&t[0].to==n.viewport.to)return t;let i=[];for(let{from:s,to:r}of t)s=Math.max(n.state.doc.lineAt(s).from,s-e),r=Math.min(n.state.doc.lineAt(r).to,r+e),i.length&&i[i.length-1].to>=s?i[i.length-1].to=r:i.push({from:s,to:r});return i}function lm(){var n;if(Kr==null&&typeof document<"u"&&document.body){let e=document.body.style;Kr=((n=e.tabSize)!==null&&n!==void 0?n:e.MozTabSize)!=null}return Kr||!1}function Lc(n={}){return[ns.of(n),am()]}function am(){return kh||(kh=_.fromClass(class{constructor(n){this.view=n,this.decorations=B.none,this.decorationCache=Object.create(null),this.decorator=this.makeDecorator(n.state.facet(ns)),this.decorations=this.decorator.createDeco(n)}makeDecorator(n){return new No({regexp:n.specialChars,decoration:(e,t,i)=>{let{doc:s}=t.state,r=ae(e[0],0);if(r==9){let o=s.lineAt(i),l=t.state.tabSize,a=ct(o.text,l,i-o.from);return B.replace({widget:new Wo((l-a%l)*this.view.defaultCharacterWidth/this.view.scaleX)})}return this.decorationCache[r]||(this.decorationCache[r]=B.replace({widget:new Ho(n,r)}))},boundary:n.replaceTabs?void 0:/[^]/})}update(n){let e=n.state.facet(ns);n.startState.facet(ns)!=e?(this.decorator=this.makeDecorator(e),this.decorations=this.decorator.createDeco(n.view)):this.decorations=this.decorator.updateDeco(n,this.decorations)}},{decorations:n=>n.decorations}))}function cm(n){return n>=32?hm:n==10?"\u2424":String.fromCharCode(9216+n)}function Ec(){return um}function dm(n,e,t){let i=Math.min(e.line,t.line),s=Math.max(e.line,t.line),r=[];if(e.off>Vo||t.off>Vo||e.col<0||t.col<0){let o=Math.min(e.off,t.off),l=Math.max(e.off,t.off);for(let a=i;a<=s;a++){let h=n.doc.line(a);h.length<=l&&r.push(b.range(h.from+o,h.to+l))}}else{let o=Math.min(e.col,t.col),l=Math.max(e.col,t.col);for(let a=i;a<=s;a++){let h=n.doc.line(a),c=qn(h.text,o,n.tabSize,!0);if(c<0)r.push(b.cursor(h.to));else{let f=qn(h.text,l,n.tabSize);r.push(b.range(h.from+c,h.from+f))}}}return r}function pm(n,e){let t=n.coordsAtPos(n.viewport.from);return t?Math.round(Math.abs((t.left-e)/n.defaultCharacterWidth)):-1}function vh(n,e){let t=n.posAtCoords({x:e.clientX,y:e.clientY},!1),i=n.state.doc.lineAt(t),s=t-i.from,r=s>Vo?-1:s==i.length?pm(n,e.clientX):ct(i.text,n.state.tabSize,t-i.from);return{line:i.number,col:r,off:s}}function mm(n,e){let t=vh(n,e),i=n.state.selection;return t?{update(s){if(s.docChanged){let r=s.changes.mapPos(s.startState.doc.line(t.line).from),o=s.state.doc.lineAt(r);t={line:o.number,col:t.col,off:Math.min(t.off,o.length)},i=i.map(s.changes)}},get(s,r,o){let l=vh(n,s);if(!l)return i;let a=dm(n.state,t,l);return a.length?o?b.create(a.concat(i.ranges)):b.create(a):i}}:null}function Rc(n){let e=n?.eventFilter||(t=>t.altKey&&t.button==0);return M.mouseSelectionStyle.of((t,i)=>e(i)?mm(t,i):null)}function Pc(n={}){let[e,t]=gm[n.key||"Alt"],i=_.fromClass(class{constructor(s){this.view=s,this.isDown=!1}set(s){this.isDown!=s&&(this.isDown=s,this.view.update([]))}},{eventObservers:{keydown(s){this.set(s.keyCode==e||t(s))},keyup(s){(s.keyCode==e||!t(s))&&this.set(!1)},mousemove(s){this.set(t(s))}}});return[i,M.contentAttributes.of(s=>{var r;return!((r=s.plugin(i))===null||r===void 0)&&r.isDown?ym:null})]}function Ic(n){let e=n.dom.ownerDocument.documentElement,t=e.clientWidth,i=getComputedStyle(e);if(!/stable/.test(i.scrollbarGutter||""))return{left:0,right:t};let s=e.getBoundingClientRect(),r=n.win.scrollX;return{left:Math.max(0,s.left+r-parseFloat(i.marginLeft)),right:Math.min(t,s.right+r+parseFloat(i.marginRight))}}function bm(n){let{left:e,right:t}=Ic(n);return{top:0,left:e,right:t,bottom:n.dom.ownerDocument.documentElement.clientHeight}}function Ch(n,e){let t=parseInt(n.style.left,10);(isNaN(t)||Math.abs(e-t)>1)&&(n.style.left=e+"px")}function vm(n,e){let{left:t,right:i,top:s,bottom:r}=n.getBoundingClientRect(),o;if(o=n.querySelector(".cm-tooltip-arrow")){let l=o.getBoundingClientRect();s=Math.min(l.top,s),r=Math.max(l.bottom,r)}return e.clientX>=t-Zn&&e.clientX<=i+Zn&&e.clientY>=s-Zn&&e.clientY<=r+Zn}function Sm(n,e,t,i,s,r){let o=n.scrollDOM.getBoundingClientRect(),l=n.documentTop+n.documentPadding.top+n.contentHeight;if(o.left>i||o.right<i||o.top>s||Math.min(o.bottom,l)<s)return!1;let a=n.posAtCoords({x:i,y:s},!1);return a>=e&&a<=t}function Fc(n,e={}){let t=L.define(),i=new WeakMap,s=Q.define({create(){return[]},update(o,l){let a=i.get(o);if(o.length&&(e.hideOnChange&&(l.docChanged||l.selection)?o=[]:a&&a(l)?o=[]:e.hideOn&&(o=o.filter(h=>!e.hideOn(l,h)))),l.docChanged&&o.length){let h=[];for(let c of o){let f=l.changes.mapPos(c.pos,-1,ne.TrackDel);if(f!=null){let u=Object.assign(Object.create(null),c);u.pos=f,u.end!=null&&(u.end=l.changes.mapPos(u.end)),h.push(u)}}o=h}for(let h of l.effects)h.is(t)&&(o=h.value,a=void 0),(h.is(Cm)&&!h.value||h.value==s)&&(o=[]);return o.length&&a&&i.set(o,a),o},provide:o=>xs.from(o)}),r=_.define(o=>new zo(o,n,s,i,t,e.hoverTime||300));return{active:s,extension:[s,r,Nc.of(r),km]}}function Hc(n,e,t,i={}){var s;let r=n.state.facet(Nc).map(o=>n.plugin(o)).filter(o=>!!o);if(i.tooltip&&i.tooltip.active){let o=r.find(l=>l.field==i.tooltip.active);o&&(r=[o])}for(let o of r)o.activateHover(n,e,t,(s=i.until)!==null&&s!==void 0?s:(()=>!1))}function tl(n,e){let t=n.plugin(el);if(!t)return null;let i=t.manager.tooltips.indexOf(e);return i<0?null:t.manager.tooltipViews[i]}function Si(n,e){let t=n.plugin(Wc),i=t?t.specs.indexOf(e):-1;return i>-1?t.panels[i]:null}function Mh(n){let e=n.nextSibling;return n.remove(),e}function Vc(n,e){let t,i=new Promise(o=>t=o),s=o=>Am(o,e,t);n.state.field(ss,!1)?n.dispatch({effects:qc.of(s)}):n.dispatch({effects:L.appendConfig.of(ss.init(()=>[s]))});let r=Kc.of(s);return{close:r,result:i.then(o=>((n.win.queueMicrotask||(a=>n.win.setTimeout(a,10)))(()=>{n.state.field(ss).indexOf(s)>-1&&n.dispatch({effects:r})}),o))}}function zc(n,e){let t=n.state.field(ss,!1)||[];for(let i of t){let s=Si(n,i);if(s&&s.dom.classList.contains(e))return s}return null}function Am(n,e,t){let i=e.content?e.content(n,()=>l(null)):null;if(!i){if(i=V("form"),e.input){let a=V("input",e.input);/^(text|password|number|email|tel|url)$/.test(a.type)&&a.classList.add("cm-textfield"),a.name||(a.name="input"),i.appendChild(V("label",(e.label||"")+": ",a))}else i.appendChild(document.createTextNode(e.label||""));i.appendChild(document.createTextNode(" ")),i.appendChild(V("button",{class:"cm-button",type:"submit"},e.submitLabel||"OK"))}let s=i.nodeName=="FORM"?[i]:i.querySelectorAll("form");for(let a=0;a<s.length;a++){let h=s[a];h.addEventListener("keydown",c=>{c.keyCode==27?(c.preventDefault(),l(null)):c.keyCode==13&&(c.preventDefault(),l(h))}),h.addEventListener("submit",c=>{c.preventDefault(),l(h)})}let r=V("div",i,V("button",{onclick:()=>l(null),"aria-label":n.state.phrase("close"),class:"cm-dialog-close",type:"button"},["\xD7"]));e.class&&(r.className=e.class),r.classList.add("cm-dialog");let o=typeof e.focus=="string"?i.querySelector(e.focus):e.focus?i.querySelector("input")||i.querySelector("button"):null;function l(a){r.contains(r.ownerDocument.activeElement)&&n.focus(),t(a)}return{dom:r,top:e.top,mount:()=>{o&&("select"in o?o.select():"focus"in o&&o.focus())},destroy:()=>t(null)}}function il(n){return[$c(),Ji.of({...Tm,...n})]}function $c(n){let e=[Dm];return n&&n.fixed===!1&&e.push(qo.of(!0)),e}function Th(n){return Array.isArray(n)?n:[n]}function Ko(n,e,t){for(;n.value&&n.from<=t;)n.from==t&&e.push(n.value),n.next()}function Om(n,e){if(n.length!=e.length)return!1;for(let t=0;t<n.length;t++)if(!n[t].compare(e[t]))return!1;return!0}function jr(n,e){return n.state.facet(ui).formatNumber(e,n.state)}function jc(n={}){return[ui.of(n),$c(),Em]}function Dh(n){let e=9;for(;e<n;)e=e*10+9;return e}function Uc(){return Pm}var xe,Ur,Gr,Oh,_r,Ss,Ua,Hr,Ga,Yr,_a,D,os,we,ce,B,Zi,en,qt,ls,se,mi,Jr,Wt,Ja,it,q,gi,Go,Wd,Vd,Qr,tt,zd,ze,U,Kh,$h,jh,Uh,Gh,to,_h,Yh,_o,Yo,Xh,Jh,Qh,Ui,jn,Zh,dt,_d,hi,_,Gi,ec,Xo,Cs,tc,Jo,sn,ic,sc,zi,Ue,cs,Yd,X,yi,bi,pt,xi,Ce,Vt,Kt,wi,io,no,so,ro,fs,oo,lo,rc,kt,Vr,us,sp,ho,_i,Ve,uo,ai,po,ds,mo,yo,fc,kp,uc,Un,bo,Ge,ke,dc,Dp,sh,rh,oh,xo,gc,ah,hh,ki,wo,ko,je,G,ts,Be,Pp,ms,We,xt,vo,Ip,So,Co,Xi,Ao,gs,ci,Mo,To,Xn,Do,Oo,xc,wc,kc,qp,Kp,qr,Lo,Eo,M,jp,mh,ys,Up,_p,vt,yh,bt,Yp,Ro,zt,Po,is,Io,vi,Zp,em,tm,im,Oc,Ki,nm,No,Fo,rm,om,Kr,ns,kh,hm,Ho,Wo,fm,um,Vo,gm,ym,Qn,bs,$r,Sh,el,xm,wm,rn,xs,ws,km,Nc,zo,Zn,Cm,Ah,Wc,fi,$t,ss,qc,Kc,Le,rs,Mm,Tm,Ji,qo,Dm,$o,ks,vs,Bm,Lm,ui,Qi,Em,Rm,Pm,St=ye(()=>{ft();Fr();$a();$n();xe=typeof navigator<"u"?navigator:{userAgent:"",vendor:"",platform:""},Ur=typeof document<"u"?document:{documentElement:{style:{}}},Gr=/Edge\/(\d+)/.exec(xe.userAgent),Oh=/MSIE \d/.test(xe.userAgent),_r=/Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(xe.userAgent),Ss=!!(Oh||_r||Gr),Ua=!Ss&&/gecko\/(\d+)/i.test(xe.userAgent),Hr=!Ss&&/Chrome\/(\d+)/.exec(xe.userAgent),Ga="webkitFontSmoothing"in Ur.documentElement.style,Yr=!Ss&&/Apple Computer/.test(xe.vendor),_a=Yr&&(/Mobile\/\w+/.test(xe.userAgent)||xe.maxTouchPoints>2),D={mac:_a||/Mac/.test(xe.platform),windows:/Win/.test(xe.platform),linux:/Linux|X11/.test(xe.platform),ie:Ss,ie_version:Oh?Ur.documentMode||6:_r?+_r[1]:Gr?+Gr[1]:0,gecko:Ua,gecko_version:Ua?+(/Firefox\/(\d+)/.exec(xe.userAgent)||[0,0])[1]:0,chrome:!!Hr,chrome_version:Hr?+Hr[1]:0,ios:_a,android:/Android\b/.test(xe.userAgent),webkit:Ga,webkit_version:Ga?+(/\bAppleWebKit\/(\d+)/.exec(xe.userAgent)||[0,0])[1]:0,safari:Yr,safari_version:Yr?+(/\bVersion\/(\d+(\.\d+)?)/.exec(xe.userAgent)||[0,0])[1]:0,tabSize:Ur.documentElement.style.tabSize!=null?"tab-size":"-moz-tab-size"};os=Object.create(null);we=class{eq(e){return!1}updateDOM(e,t,i){return!1}compare(e){return this==e||this.constructor==e.constructor&&this.eq(e)}get estimatedHeight(){return-1}get lineBreaks(){return 0}ignoreEvent(e){return!0}coordsAt(e,t,i){return null}get isHidden(){return!1}get editable(){return!1}destroy(e){}},ce=(function(n){return n[n.Text=0]="Text",n[n.WidgetBefore=1]="WidgetBefore",n[n.WidgetAfter=2]="WidgetAfter",n[n.WidgetRange=3]="WidgetRange",n})(ce||(ce={})),B=class extends Ne{constructor(e,t,i,s){super(),this.startSide=e,this.endSide=t,this.widget=i,this.spec=s}get heightRelevant(){return!1}static mark(e){return new Zi(e)}static widget(e){let t=Math.max(-1e4,Math.min(1e4,e.side||0)),i=!!e.block;return t+=i&&!e.inlineOrder?t>0?3e8:-4e8:t>0?1e8:-1e8,new qt(e,t,t,i,e.widget||null,!1)}static replace(e){let t=!!e.block,i,s;if(e.isBlockGap)i=-5e8,s=4e8;else{let{start:r,end:o}=Bh(e,t);i=(r?t?-3e8:-1:5e8)-1,s=(o?t?2e8:1:-6e8)+1}return new qt(e,i,s,t,e.widget||null,!0)}static line(e){return new en(e)}static set(e,t=!1){return H.of(e,t)}hasHeight(){return this.widget?this.widget.estimatedHeight>-1:!1}};B.none=H.empty;Zi=class n extends B{constructor(e){let{start:t,end:i}=Bh(e);super(t?-1:5e8,i?1:-6e8,null,e),this.tagName=e.tagName||"span",this.attrs=e.class&&e.attributes?jo(e.attributes,{class:e.class}):e.class?{class:e.class}:e.attributes||os}eq(e){return this==e||e instanceof n&&this.tagName==e.tagName&&Uo(this.attrs,e.attrs)}range(e,t=e){if(e>=t)throw new RangeError("Mark decorations may not be empty");return super.range(e,t)}};Zi.prototype.point=!1;en=class n extends B{constructor(e){super(-2e8,-2e8,null,e)}eq(e){return e instanceof n&&this.spec.class==e.spec.class&&Uo(this.spec.attributes,e.spec.attributes)}range(e,t=e){if(t!=e)throw new RangeError("Line decoration ranges must be zero-length");return super.range(e,t)}};en.prototype.mapMode=ne.TrackBefore;en.prototype.point=!0;qt=class n extends B{constructor(e,t,i,s,r,o){super(t,i,r,e),this.block=s,this.isReplace=o,this.mapMode=s?t<=0?ne.TrackBefore:ne.TrackAfter:ne.TrackDel}get type(){return this.startSide!=this.endSide?ce.WidgetRange:this.startSide<=0?ce.WidgetBefore:ce.WidgetAfter}get heightRelevant(){return this.block||!!this.widget&&(this.widget.estimatedHeight>=5||this.widget.lineBreaks>0)}eq(e){return e instanceof n&&Pd(this.widget,e.widget)&&this.block==e.block&&this.startSide==e.startSide&&this.endSide==e.endSide}range(e,t=e){if(this.isReplace&&(e>t||e==t&&this.startSide>0&&this.endSide<=0))throw new RangeError("Invalid range for replacement decoration");if(!this.isReplace&&t!=e)throw new RangeError("Widget decorations can only have zero-length ranges");return super.range(e,t)}};qt.prototype.point=!0;ls=class n extends Ne{constructor(e,t,i){super(),this.tagName=e,this.attributes=t,this.rank=i}eq(e){return e==this||e instanceof n&&this.tagName==e.tagName&&Uo(this.attributes,e.attributes)}static create(e){return new n(e.tagName,e.attributes||os,e.rank==null?50:Math.max(0,Math.min(e.rank,100)))}static set(e,t=!1){return H.of(e,t)}};ls.prototype.startSide=ls.prototype.endSide=-1;se=n=>n.nodeType==1,mi=n=>n.nodeType==3;Jr=class{constructor(){this.anchorNode=null,this.anchorOffset=0,this.focusNode=null,this.focusOffset=0}eq(e){return this.anchorNode==e.anchorNode&&this.anchorOffset==e.anchorOffset&&this.focusNode==e.focusNode&&this.focusOffset==e.focusOffset}setRange(e){let{anchorNode:t,focusNode:i}=e;this.set(t,Math.min(e.anchorOffset,t?mt(t):0),i,Math.min(e.focusOffset,i?mt(i):0))}set(e,t,i,s){this.anchorNode=e,this.anchorOffset=t,this.focusNode=i,this.focusOffset=s}};Wt=null;D.safari&&D.safari_version>=26&&(Wt=!1);it=class n{constructor(e,t,i=!0){this.node=e,this.offset=t,this.precise=i}static before(e,t){return new n(e.parentNode,wt(e),t)}static after(e,t){return new n(e.parentNode,wt(e)+1,t)}},q=(function(n){return n[n.LTR=0]="LTR",n[n.RTL=1]="RTL",n})(q||(q={})),gi=q.LTR,Go=q.RTL;Wd=Wh("88888888888888888888888888888888888666888888787833333333337888888000000000000000000000000008888880000000000000000000000000088888888888888888888888888888888888887866668888088888663380888308888800000000000000000000000800000000000000000000000000000008"),Vd=Wh("4444448826627288999999999992222222222222222222222222222222222222222222222229999999999999999999994444444444644222822222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222999999949999999229989999223333333333"),Qr=Object.create(null),tt=[];for(let n of["()","[]","{}"]){let e=n.charCodeAt(0),t=n.charCodeAt(1);Qr[e]=t,Qr[t]=-e}zd=/[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac\ufb50-\ufdff]/,ze=class{get dir(){return this.level%2?Go:gi}constructor(e,t,i){this.from=e,this.to=t,this.level=i}side(e,t){return this.dir==t==e?this.to:this.from}forward(e,t){return e==(this.dir==t)}static find(e,t,i,s){let r=-1;for(let o=0;o<e.length;o++){let l=e[o];if(l.from<=t&&l.to>=t){if(l.level==i)return o;(r<0||(s!=0?s<0?l.from<t:l.to>t:e[r].level>l.level))&&(r=o)}}if(r<0)throw new RangeError("Index out of range");return r}};U=[];Kh="";$h=A.define(),jh=A.define(),Uh=A.define(),Gh=A.define(),to=A.define(),_h=A.define(),Yh=A.define(),_o=A.define(),Yo=A.define(),Xh=A.define({combine:n=>n.some(e=>e)}),Jh=A.define({combine:n=>n.some(e=>e)}),Qh=A.define(),Ui=class n{constructor(e,t,i,s,r,o=!1){this.range=e,this.y=t,this.x=i,this.yMargin=s,this.xMargin=r,this.isSnapshot=o}map(e){return e.empty?this:new n(this.range.map(e),this.y,this.x,this.yMargin,this.xMargin,this.isSnapshot)}clip(e){return this.range.to<=e.doc.length?this:new n(b.cursor(e.doc.length),this.y,this.x,this.yMargin,this.xMargin,this.isSnapshot)}},jn=L.define({map:(n,e)=>n.map(e)}),Zh=L.define();dt=A.define({combine:n=>n.length?n[0]:!0}),_d=0,hi=A.define({combine(n){return n.filter((e,t)=>{for(let i=0;i<t;i++)if(n[i].plugin==e.plugin)return!1;return!0})}}),_=class n{constructor(e,t,i,s,r){this.id=e,this.create=t,this.domEventHandlers=i,this.domEventObservers=s,this.baseExtensions=r(this),this.extension=this.baseExtensions.concat(hi.of({plugin:this,arg:void 0}))}of(e){return this.baseExtensions.concat(hi.of({plugin:this,arg:e}))}static define(e,t){let{eventHandlers:i,eventObservers:s,provide:r,decorations:o}=t||{};return new n(_d++,e,i,s,l=>{let a=[];return o&&a.push(Cs.of(h=>{let c=h.plugin(l);return c?o(c):B.none})),r&&a.push(r(l)),a})}static fromClass(e,t){return n.define((i,s)=>new e(i,s),t)}},Gi=class{constructor(e){this.spec=e,this.mustUpdate=null,this.value=null}get plugin(){return this.spec&&this.spec.plugin}update(e){if(this.value){if(this.mustUpdate){let t=this.mustUpdate;if(this.mustUpdate=null,this.value.update)try{this.value.update(t)}catch(i){if(he(t.state,i,"CodeMirror plugin crashed"),this.value.destroy)try{this.value.destroy()}catch{}this.deactivate()}}}else if(this.spec)try{this.value=this.spec.plugin.create(e,this.spec.arg)}catch(t){he(e.state,t,"CodeMirror plugin crashed"),this.deactivate()}return this}destroy(e){var t;if(!((t=this.value)===null||t===void 0)&&t.destroy)try{this.value.destroy()}catch(i){he(e.state,i,"CodeMirror plugin crashed")}}deactivate(){this.spec=this.value=null}},ec=A.define(),Xo=A.define(),Cs=A.define(),tc=A.define(),Jo=A.define(),sn=A.define(),ic=A.define();sc=A.define();zi=A.define(),Ue=class n{constructor(e,t,i,s){this.fromA=e,this.toA=t,this.fromB=i,this.toB=s}join(e){return new n(Math.min(this.fromA,e.fromA),Math.max(this.toA,e.toA),Math.min(this.fromB,e.fromB),Math.max(this.toB,e.toB))}addToSet(e){let t=e.length,i=this;for(;t>0;t--){let s=e[t-1];if(!(s.fromA>i.toA)){if(s.toA<i.fromA)break;i=i.join(s),e.splice(t-1,1)}}return e.splice(t,0,i),e}static extendWithRanges(e,t){if(t.length==0)return e;let i=[];for(let s=0,r=0,o=0;;){let l=s<e.length?e[s].fromB:1e9,a=r<t.length?t[r]:1e9,h=Math.min(l,a);if(h==1e9)break;let c=h+o,f=h,u=c;for(;;)if(r<t.length&&t[r]<=f){let d=t[r+1];r+=2,f=Math.max(f,d);for(let p=s;p<e.length&&e[p].fromB<=f;p++)o=e[p].toA-e[p].toB;u=Math.max(u,d+o)}else if(s<e.length&&e[s].fromB<=f){let d=e[s++];f=Math.max(f,d.toB),u=Math.max(u,d.toA),o=d.toA-d.toB}else break;i.push(new n(c,u,h,f))}return i}},cs=class n{constructor(e,t,i){this.view=e,this.state=t,this.transactions=i,this.flags=0,this.startState=e.state,this.changes=be.empty(this.startState.doc.length);for(let r of i)this.changes=this.changes.compose(r.changes);let s=[];this.changes.iterChangedRanges((r,o,l,a)=>s.push(new Ue(r,o,l,a))),this.changedRanges=s}static create(e,t,i){return new n(e,t,i)}get viewportChanged(){return(this.flags&4)>0}get viewportMoved(){return(this.flags&8)>0}get heightChanged(){return(this.flags&2)>0}get geometryChanged(){return this.docChanged||(this.flags&18)>0}get focusChanged(){return(this.flags&1)>0}get docChanged(){return!this.changes.empty}get selectionSet(){return this.transactions.some(e=>e.selection)}get empty(){return this.flags==0&&this.transactions.length==0}},Yd=[],X=class{constructor(e,t,i=0){this.dom=e,this.length=t,this.flags=i,this.parent=null,e.cmTile=this}get breakAfter(){return this.flags&1}get children(){return Yd}isWidget(){return!1}get isHidden(){return!1}isComposite(){return!1}isLine(){return!1}isText(){return!1}isBlock(){return!1}get domAttrs(){return null}sync(e){if(this.flags|=2,this.flags&4){this.flags&=-5;let t=this.domAttrs;t&&Ed(this.dom,t)}}toString(){return this.constructor.name+(this.children.length?`(${this.children})`:"")+(this.breakAfter?"#":"")}destroy(){this.parent=null}setDOM(e){this.dom=e,e.cmTile=this}get posAtStart(){return this.parent?this.parent.posBefore(this):0}get posAtEnd(){return this.posAtStart+this.length}posBefore(e,t=this.posAtStart){let i=t;for(let s of this.children){if(s==e)return i;i+=s.length+s.breakAfter}throw new RangeError("Invalid child in posBefore")}posAfter(e){return this.posBefore(e)+e.length}covers(e){return!0}coordsIn(e,t,i){return null}domPosFor(e,t){let i=wt(this.dom),s=this.length?e>0:t>0;return new it(this.parent.dom,i+(s?1:0),e==0||e==this.length)}markDirty(e){this.flags&=-3,e&&(this.flags|=4),this.parent&&this.parent.flags&2&&this.parent.markDirty(!1)}get overrideDOMText(){return null}get root(){for(let e=this;e;e=e.parent)if(e instanceof bi)return e;return null}static get(e){return e.cmTile}},yi=class extends X{constructor(e){super(e,0),this._children=[]}isComposite(){return!0}get children(){return this._children}get lastChild(){return this.children.length?this.children[this.children.length-1]:null}append(e){this.children.push(e),e.parent=this}sync(e){if(this.flags&2)return;super.sync(e);let t=this.dom,i=null,s,r=e?.node==t?e:null,o=0;for(let l of this.children){if(l.sync(e),o+=l.length+l.breakAfter,s=i?i.nextSibling:t.firstChild,r&&s!=l.dom&&(r.written=!0),l.dom.parentNode==t)for(;s&&s!=l.dom;)s=Za(s);else t.insertBefore(l.dom,s);i=l.dom}for(s=i?i.nextSibling:t.firstChild,r&&s&&(r.written=!0);s;)s=Za(s);this.length=o}};bi=class extends yi{constructor(e,t){super(t),this.view=e}owns(e){for(;e;e=e.parent)if(e==this)return!0;return!1}isBlock(){return!0}nearest(e){for(;;){if(!e)return null;let t=X.get(e);if(t&&this.owns(t))return t;e=e.parentNode}}blockTiles(e){for(let t=[],i=this,s=0,r=0;;)if(s==i.children.length){if(!t.length)return;i=i.parent,i.breakAfter&&r++,s=t.pop()}else{let o=i.children[s++];if(o instanceof pt)t.push(s),i=o,s=0;else{let l=r+o.length,a=e(o,r);if(a!==void 0)return a;r=l+o.breakAfter}}}resolveBlock(e,t){let i,s=-1,r,o=-1;if(this.blockTiles((l,a)=>{let h=a+l.length;if(e>=a&&e<=h){if(l.isWidget()&&t>=-1&&t<=1){if(l.flags&32)return!0;l.flags&16&&(i=void 0)}(a<e||e==h&&(t<-1?l.length:l.covers(1)))&&(!i||!l.isWidget()&&i.isWidget())&&(i=l,s=e-a),(h>e||e==a&&(t>1?l.length:l.covers(-1)))&&(!r||!l.isWidget()&&r.isWidget())&&(r=l,o=e-a)}}),!i&&!r)throw new Error("No tile at position "+e);return i&&t<0||!r?{tile:i,offset:s}:{tile:r,offset:o}}},pt=class n extends yi{constructor(e,t){super(e),this.wrapper=t}isBlock(){return!0}covers(e){return this.children.length?e<0?this.children[0].covers(-1):this.lastChild.covers(1):!1}get domAttrs(){return this.wrapper.attributes}static of(e,t){let i=new n(t||document.createElement(e.tagName),e);return t||(i.flags|=4),i}},xi=class n extends yi{constructor(e,t){super(e),this.attrs=t}isLine(){return!0}static start(e,t,i){let s=new n(t||document.createElement("div"),e);return(!t||!i)&&(s.flags|=4),s}get domAttrs(){return this.attrs}resolveInline(e,t,i=!1){let s=null,r=-1,o=null,l=-1;function a(c,f){for(let u=0,d=0;u<c.children.length&&d<=f;u++){let p=c.children[u],m=d+p.length;m>=f&&(p.isComposite()?a(p,f-d):(!o||i&&o.isHidden&&(t>0&&!(o.flags&32)||i&&Jd(o,p)))&&(m>f||p.flags&32&&t<=1)?(o=p,l=f-d):(d<f||p.flags&16&&!(i&&p.isHidden)&&t>=-1)&&(s=p,r=f-d)),d=m}}a(this,e);let h=(t<0?s:o)||s||o;return h?{tile:h,offset:h==s?r:l}:null}coordsIn(e,t,i){let s=this.resolveInline(e,t,!0);return s?s.tile.coordsIn(Math.max(0,s.offset),t,i):Xd(this)}domIn(e,t){let i=this.resolveInline(e,t);if(i){let{tile:s,offset:r}=i;if(this.dom.contains(s.dom))return s.isText()?new it(s.dom,Math.min(s.dom.nodeValue.length,r)):s.domPosFor(r,s.flags&16?1:s.flags&32?-1:t);let o=i.tile.parent,l=!1;for(let a of o.children){if(l)return new it(a.dom,0);a==i.tile&&(l=!0)}}return new it(this.dom,0)}};Ce=class n extends yi{constructor(e,t){super(e),this.mark=t}get domAttrs(){return this.mark.attrs}static of(e,t){let i=new n(t||document.createElement(e.tagName),e);return t||(i.flags|=4),i}},Vt=class n extends X{constructor(e,t){super(e,t.length),this.text=t}sync(e){this.flags&2||(super.sync(e),this.dom.nodeValue!=this.text&&(e&&e.node==this.dom&&(e.written=!0),this.dom.nodeValue=this.text))}isText(){return!0}toString(){return JSON.stringify(this.text)}coordsIn(e,t,i){let s=this.dom.nodeValue.length;e>s&&(e=s);let r=e,o=e,l=0;e==0&&t<0||e==s&&t>=0?D.chrome||D.gecko||(e?(r--,l=1):o<s&&(o++,l=-1)):t<0?r--:o<s&&o++;let a=nn(this.dom,r,o).getClientRects();if(!a.length)return null;let h=a[(l?l<0:t>=0)?0:a.length-1];return D.safari&&!l&&h.width==0&&(h=Array.prototype.find.call(a,c=>c.width)||h),i==null?h:hs(h,(l?l>0:t<0)==i)}static of(e,t){let i=new n(t||document.createTextNode(e),e);return t||(i.flags|=2),i}},Kt=class n extends X{constructor(e,t,i,s){super(e,t,s),this.widget=i}isWidget(){return!0}get isHidden(){return this.widget.isHidden}covers(e){return this.flags&48?!1:(this.flags&(e<0?64:128))>0}coordsIn(e,t){return this.coordsInWidget(e,t,!1)}coordsInWidget(e,t,i){let s=this.widget.coordsAt(this.dom,e,t);if(s)return s;if(i)return hs(this.dom.getBoundingClientRect(),this.length?e==0:t<=0);{let r=this.dom.getClientRects(),o=null;if(!r.length)return null;let l=this.flags&16?!0:this.flags&32?!1:e>0;for(let a=l?r.length-1:0;o=r[a],!(e>0?a==0:a==r.length-1||o.top<o.bottom);a+=l?-1:1);return hs(o,!l)}}get overrideDOMText(){if(!this.length)return N.empty;let{root:e}=this;if(!e)return N.empty;let t=this.posAtStart;return e.view.state.doc.slice(t,t+this.length)}destroy(){super.destroy(),this.widget.destroy(this.dom)}static of(e,t,i,s,r){return r||(r=e.toDOM(t),e.editable||(r.contentEditable="false")),new n(r,i,e,s)}},wi=class extends X{constructor(e){let t=document.createElement("img");t.className="cm-widgetBuffer",t.setAttribute("aria-hidden","true"),super(t,0,e)}get isHidden(){return!0}get overrideDOMText(){return N.empty}coordsIn(e,t,i){let s=this.dom.getBoundingClientRect();return i==null?s:hs(s,t>0==i)}},io=class{constructor(e){this.index=0,this.beforeBreak=!1,this.parents=[],this.tile=e}advance(e,t,i){let{tile:s,index:r,beforeBreak:o,parents:l}=this;for(;e||t>0;)if(s.isComposite())if(o){if(!e)break;i&&i.break(),e--,o=!1}else if(r==s.children.length){if(!e&&!l.length)break;i&&i.leave(s),o=!!s.breakAfter,{tile:s,index:r}=l.pop(),r++}else{let a=s.children[r],h=a.breakAfter;(t>0?a.length<=e:a.length<e)&&(!i||i.skip(a,0,a.length)!==!1||!a.isComposite)?(o=!!h,r++,e-=a.length):(l.push({tile:s,index:r}),s=a,r=0,i&&a.isComposite()&&i.enter(a))}else{let a=s.length;if(r<a&&e){let h=Math.min(e,a-r);i&&i.skip(s,r,r+h),e-=h,r+=h}if(r==a)o=!!s.breakAfter,{tile:s,index:r}=l.pop(),r++;else if(!e)break}return this.tile=s,this.index=r,this.beforeBreak=o,this}get root(){return this.parents.length?this.parents[0].tile:this.tile}},no=class{constructor(e,t,i,s){this.from=e,this.to=t,this.wrapper=i,this.rank=s}},so=class{constructor(e,t,i){this.cache=e,this.root=t,this.blockWrappers=i,this.curLine=null,this.lastBlock=null,this.afterWidget=null,this.pos=0,this.wrappers=[],this.wrapperPos=0}addText(e,t,i,s){var r;this.flushBuffer();let o=this.ensureMarks(t,i),l=o.lastChild;if(l&&l.isText()&&!(l.flags&8)&&l.length+e.length<512){this.cache.reused.set(l,2);let a=o.children[o.children.length-1]=new Vt(l.dom,l.text+e);a.parent=o}else o.append(s||Vt.of(e,(r=this.cache.find(Vt))===null||r===void 0?void 0:r.dom));this.pos+=e.length,this.afterWidget=null}addComposition(e,t){let i=this.curLine;i.dom!=t.line.dom&&(i.setDOM(this.cache.reused.has(t.line)?Wr(t.line.dom):t.line.dom),this.cache.reused.set(t.line,2));let s=i;for(let l=t.marks.length-1;l>=0;l--){let a=t.marks[l],h=s.lastChild;if(h instanceof Ce&&h.mark.eq(a.mark))h.dom!=a.dom&&h.setDOM(Wr(a.dom)),s=h;else{let{dom:c}=a;this.cache.reused.get(a)&&X.get(a.dom)&&(c=Wr(a.dom));let f=Ce.of(a.mark,c);s.append(f),s=f}this.cache.reused.set(a,2)}let r=X.get(e.text);r&&this.cache.reused.set(r,2);let o=new Vt(e.text,e.text.nodeValue);o.flags|=8,this.pos=e.range.toB,s.append(o)}addInlineWidget(e,t,i){let s=this.afterWidget&&e.flags&48&&(this.afterWidget.flags&48)==(e.flags&48);s||this.flushBuffer();let r=this.ensureMarks(t,i);!s&&!(e.flags&16)&&r.append(this.getBuffer(1)),r.append(e),this.pos+=e.length,this.afterWidget=e}addMark(e,t,i){this.flushBuffer(),this.ensureMarks(t,i).append(e),this.pos+=e.length,this.afterWidget=null}addBlockWidget(e){this.getBlockPos().append(e),this.pos+=e.length,this.lastBlock=e,this.endLine()}continueWidget(e){let t=this.afterWidget||this.lastBlock;t.length+=e,this.pos+=e}addLineStart(e,t){var i;e||(e=rc);let s=xi.start(e,t||((i=this.cache.find(xi))===null||i===void 0?void 0:i.dom),!!t);this.getBlockPos().append(this.lastBlock=this.curLine=s)}addLine(e){this.getBlockPos().append(e),this.pos+=e.length,this.lastBlock=e,this.endLine()}addBreak(){this.lastBlock.flags|=1,this.endLine(),this.pos++}addLineStartIfNotCovered(e){this.blockPosCovered()||this.addLineStart(e)}ensureLine(e){this.curLine||this.addLineStart(e)}ensureMarks(e,t){var i;let s=this.curLine;for(let r=e.length-1;r>=0;r--){let o=e[r],l;if(t>0&&(l=s.lastChild)&&l instanceof Ce&&l.mark.eq(o))s=l,t--;else{let a=Ce.of(o,(i=this.cache.find(Ce,h=>h.mark.eq(o)))===null||i===void 0?void 0:i.dom);s.append(a),s=a,t=0}}return s}endLine(){if(this.curLine){this.flushBuffer();let e=this.curLine.lastChild;(!e||!eh(this.curLine,!1)||e.dom.nodeName!="BR"&&e.isWidget()&&!(D.ios&&eh(this.curLine,!0)))&&this.curLine.append(this.cache.findWidget(Vr,0,32)||new Kt(Vr.toDOM(),0,Vr,32)),this.curLine=this.afterWidget=null}}updateBlockWrappers(){this.wrapperPos>this.pos+1e4&&(this.blockWrappers.goto(this.pos),this.wrappers.length=0);for(let e=this.wrappers.length-1;e>=0;e--)this.wrappers[e].to<this.pos&&this.wrappers.splice(e,1);for(let e=this.blockWrappers;e.value&&e.from<=this.pos;e.next())if(e.to>=this.pos){let t=e.rank*102+e.value.rank,i=new no(e.from,e.to,e.value,t),s=this.wrappers.length;for(;s>0&&(this.wrappers[s-1].rank-i.rank||this.wrappers[s-1].to-i.to)<0;)s--;this.wrappers.splice(s,0,i)}this.wrapperPos=this.pos}getBlockPos(){var e;this.updateBlockWrappers();let t=this.root;for(let i of this.wrappers){let s=t.lastChild;if(i.from<this.pos&&s instanceof pt&&s.wrapper.eq(i.wrapper))t=s;else{let r=pt.of(i.wrapper,(e=this.cache.find(pt,o=>o.wrapper.eq(i.wrapper)))===null||e===void 0?void 0:e.dom);t.append(r),t=r}}return t}blockPosCovered(){let e=this.lastBlock;return e!=null&&!e.breakAfter&&(!e.isWidget()||(e.flags&160)>0)}getBuffer(e){let t=2|(e<0?16:32),i=this.cache.find(wi,void 0,1);return i&&(i.flags=t),i||new wi(t)}flushBuffer(){this.afterWidget&&!(this.afterWidget.flags&32)&&(this.afterWidget.parent.append(this.getBuffer(-1)),this.afterWidget=null)}},ro=class{constructor(e){this.skipCount=0,this.text="",this.textOff=0,this.cursor=e.iter()}skip(e){this.textOff+e<=this.text.length?this.textOff+=e:(this.skipCount+=e-(this.text.length-this.textOff),this.text="",this.textOff=0)}next(e){if(this.textOff==this.text.length){let{value:s,lineBreak:r,done:o}=this.cursor.next(this.skipCount);if(this.skipCount=0,o)throw new Error("Ran out of text content when drawing inline views");this.text=s;let l=this.textOff=Math.min(e,s.length);return r?null:s.slice(0,l)}let t=Math.min(this.text.length,this.textOff+e),i=this.text.slice(this.textOff,t);return this.textOff=t,i}},fs=[Kt,xi,Vt,Ce,wi,pt,bi];for(let n=0;n<fs.length;n++)fs[n].bucket=n;oo=class{constructor(e){this.view=e,this.buckets=fs.map(()=>[]),this.index=fs.map(()=>0),this.reused=new Map}add(e){let t=e.constructor.bucket,i=this.buckets[t];i.length<6?i.push(e):i[this.index[t]=(this.index[t]+1)%6]=e}find(e,t,i=2){let s=e.bucket,r=this.buckets[s],o=this.index[s];for(let l=0;l<r.length;l++){let a=(l+o)%r.length,h=r[a];if((!t||t(h))&&!this.reused.has(h))return r.splice(a,1),a<o&&this.index[s]--,this.reused.set(h,i),h}return null}findWidget(e,t,i){let s=this.buckets[0];if(s.length)for(let r=0,o=0;;r++){if(r==s.length){if(o)return null;o=1,r=0}let l=s[r];if(!this.reused.has(l)&&(o==0?l.widget.compare(e):l.widget.constructor==e.constructor&&e.updateDOM(l.dom,this.view,l.widget)))return s.splice(r,1),r<this.index[0]&&this.index[0]--,l.widget==e&&l.length==t&&(l.flags&497)==i?(this.reused.set(l,1),l):(this.reused.set(l,2),new Kt(l.dom,t,e,l.flags&-498|i))}}reuse(e){return this.reused.set(e,1),e}maybeReuse(e,t=2){if(!this.reused.has(e))return this.reused.set(e,t),e.dom}clear(){for(let e=0;e<this.buckets.length;e++)this.buckets[e].length=this.index[e]=0}},lo=class{constructor(e,t,i,s,r){this.view=e,this.decorations=s,this.disallowBlockEffectsFor=r,this.openWidget=!1,this.openMarks=0,this.cache=new oo(e),this.text=new ro(e.state.doc),this.builder=new so(this.cache,new bi(e,e.contentDOM),H.iter(i)),this.cache.reused.set(t,2),this.old=new io(t),this.reuseWalker={skip:(o,l,a)=>{if(this.cache.add(o),o.isComposite())return!1},enter:o=>this.cache.add(o),leave:()=>{},break:()=>{}}}run(e,t){let i=t&&this.getCompositionContext(t.text);for(let s=0,r=0,o=0;;){let l=o<e.length?e[o++]:null,a=l?l.fromA:this.old.root.length;if(a>s){let h=a-s;this.preserve(h,!o,!l),s=a,r+=h}if(!l)break;t&&l.fromA<=t.range.fromA&&l.toA>=t.range.toA?(this.forward(l.fromA,t.range.fromA,t.range.fromA<t.range.toA?1:-1),this.emit(r,t.range.fromB),this.builder.flushBuffer(),this.cache.clear(),this.builder.addComposition(t,i),this.text.skip(t.range.toB-t.range.fromB),this.forward(t.range.fromA,l.toA),this.emit(t.range.toB,l.toB)):(this.forward(l.fromA,l.toA),this.emit(r,l.toB)),r=l.toB,s=l.toA}return this.builder.curLine&&this.builder.endLine(),this.builder.root}preserve(e,t,i){let s=ep(this.old),r=this.openMarks;this.old.advance(e,i?1:-1,{skip:(o,l,a)=>{if(o.isWidget())if(this.openWidget)this.builder.continueWidget(a-l);else{let h=a>0||l<o.length?Kt.of(o.widget,this.view,a-l,o.flags&496,this.cache.maybeReuse(o)):this.cache.reuse(o);h.flags&256?(h.flags&=-2,this.builder.addBlockWidget(h)):(this.builder.ensureLine(null),this.builder.addInlineWidget(h,s,r),r=s.length)}else if(o.isText())this.builder.ensureLine(null),!l&&a==o.length&&!this.cache.reused.has(o)?this.builder.addText(o.text,s,r,this.cache.reuse(o)):(this.cache.add(o),this.builder.addText(o.text.slice(l,a),s,r)),r=s.length;else if(o.isLine())o.flags&=-2,this.cache.reused.set(o,1),this.builder.addLine(o);else if(o instanceof wi)this.cache.add(o);else if(o instanceof Ce)this.builder.ensureLine(null),this.builder.addMark(o,s,r),this.cache.reused.set(o,1),r=s.length;else return!1;this.openWidget=!1},enter:o=>{o.isLine()?this.builder.addLineStart(o.attrs,this.cache.maybeReuse(o)):(this.cache.add(o),o instanceof Ce&&s.unshift(o.mark)),this.openWidget=!1},leave:o=>{o.isLine()?s.length&&(s.length=r=0):o instanceof Ce&&(s.shift(),r=Math.min(r,s.length))},break:()=>{this.builder.addBreak(),this.openWidget=!1}}),this.text.skip(e)}emit(e,t){let i=null,s=this.builder,r=-1,o=H.spans(this.decorations,e,t,{point:(l,a,h,c,f,u)=>{if(h instanceof qt){if(this.disallowBlockEffectsFor[u]){if(h.block)throw new RangeError("Block decorations may not be specified via plugins");if(a>this.view.state.doc.lineAt(l).to)throw new RangeError("Decorations that replace line breaks may not be specified via plugins")}if(r=c.length,f>c.length)s.continueWidget(a-l);else{let d=h.widget||(h.block?kt.block:kt.inline),p=Qd(h),m=this.cache.findWidget(d,a-l,p)||Kt.of(d,this.view,a-l,p);h.block?(h.startSide>0&&s.addLineStartIfNotCovered(i),s.addBlockWidget(m)):(s.ensureLine(i),s.addInlineWidget(m,c,f))}i=null}else i=Zd(i,h);a>l&&this.text.skip(a-l)},span:(l,a,h,c)=>{for(let f=l;f<a;){let u=this.text.next(Math.min(512,a-f));u==null?(s.addLineStartIfNotCovered(i),s.addBreak(),f++):(s.ensureLine(i),s.addText(u,h,f==l?c:h.length),f+=u.length),i=null}r=h.length}});r>-1&&(this.openWidget=o>r),this.openWidget||s.addLineStartIfNotCovered(i),this.openMarks=o}forward(e,t,i=1){t-e<=10?this.old.advance(t-e,i,this.reuseWalker):(this.old.advance(5,-1,this.reuseWalker),this.old.advance(t-e-10,-1),this.old.advance(5,i,this.reuseWalker))}getCompositionContext(e){let t=[],i=null;for(let s=e.parentNode;;s=s.parentNode){let r=X.get(s);if(s==this.view.contentDOM)break;r instanceof Ce?t.push(r):r?.isLine()?i=r:r instanceof pt||(s.nodeName=="DIV"&&!i?i=new xi(s,rc):i||t.push(Ce.of(new Zi({tagName:s.nodeName.toLowerCase(),attributes:Rd(s)}),s)))}return i?{line:i,marks:t}:null}};rc={class:"cm-line"};kt=class extends we{constructor(e){super(),this.tag=e}eq(e){return e.tag==this.tag}toDOM(){return document.createElement(this.tag)}updateDOM(e){return e.nodeName.toLowerCase()==this.tag}get isHidden(){return!0}};kt.inline=new kt("span");kt.block=new kt("div");Vr=new class extends we{toDOM(){return document.createElement("br")}get isHidden(){return!0}get editable(){return!0}},us=class{constructor(e){this.view=e,this.decorations=[],this.blockWrappers=[],this.dynamicDecorationMap=[!1],this.domChanged=null,this.hasComposition=null,this.editContextFormatting=B.none,this.lastCompositionAfterCursor=!1,this.minWidth=0,this.minWidthFrom=0,this.minWidthTo=0,this.impreciseAnchor=null,this.impreciseHead=null,this.forceSelection=!1,this.lastUpdate=Date.now(),this.updateDeco(),this.tile=new bi(e,e.contentDOM),this.updateInner([new Ue(0,0,0,e.state.doc.length)],null)}update(e){var t;let i=e.changedRanges;this.minWidth>0&&i.length&&(i.every(({fromA:c,toA:f})=>f<this.minWidthFrom||c>this.minWidthTo)?(this.minWidthFrom=e.changes.mapPos(this.minWidthFrom,1),this.minWidthTo=e.changes.mapPos(this.minWidthTo,1)):this.minWidth=this.minWidthFrom=this.minWidthTo=0),this.updateEditContextFormatting(e);let s=-1;this.view.inputState.composing>=0&&!this.view.observer.editContext&&(!((t=this.domChanged)===null||t===void 0)&&t.newSel?s=this.domChanged.newSel.head:!ap(e.changes,this.hasComposition)&&!e.selectionSet&&(s=e.state.selection.main.head));let r=s>-1?ip(this.view,e.changes,s):null;if(this.domChanged=null,this.hasComposition){let{from:c,to:f}=this.hasComposition;i=new Ue(c,f,e.changes.mapPos(c,-1),e.changes.mapPos(f,1)).addToSet(i.slice())}this.hasComposition=r?{from:r.range.fromB,to:r.range.toB}:null,(D.ie||D.chrome)&&!r&&e&&e.state.doc.lines!=e.startState.doc.lines&&(this.forceSelection=!0);let o=this.decorations,l=this.blockWrappers;this.updateDeco();let a=rp(o,this.decorations,e.changes);a.length&&(i=Ue.extendWithRanges(i,a));let h=op(l,this.blockWrappers,e.changes);return h.length&&(i=Ue.extendWithRanges(i,h)),r&&!i.some(c=>c.fromA<=r.range.fromA&&c.toA>=r.range.toA)&&(i=r.range.addToSet(i.slice())),this.tile.flags&2&&i.length==0?!1:(this.updateInner(i,r),e.transactions.length&&(this.lastUpdate=Date.now()),!0)}updateInner(e,t){this.view.viewState.mustMeasureContent=!0;let{observer:i}=this.view;i.ignore(()=>{if(t||e.length){let o=this.tile,l=new lo(this.view,o,this.blockWrappers,this.decorations,this.dynamicDecorationMap);t&&X.get(t.text)&&l.cache.reused.set(X.get(t.text),2),this.tile=l.run(e,t),ao(o,l.cache.reused)}this.tile.dom.style.height=this.view.viewState.contentHeight/this.view.scaleY+"px",this.tile.dom.style.flexBasis=this.minWidth?this.minWidth+"px":"";let r=D.chrome||D.ios?{node:i.selectionRange.focusNode,written:!1}:void 0;this.tile.sync(r),r&&(r.written||i.selectionRange.focusNode!=r.node||!this.tile.dom.contains(r.node))&&(this.forceSelection=!0),this.tile.dom.style.height=""});let s=[];if(this.view.viewport.from||this.view.viewport.to<this.view.state.doc.length)for(let r of this.tile.children)r.isWidget()&&r.widget instanceof _i&&s.push(r.dom);i.updateGaps(s)}updateEditContextFormatting(e){this.editContextFormatting=this.editContextFormatting.map(e.changes);for(let t of e.transactions)for(let i of t.effects)i.is(Zh)&&(this.editContextFormatting=i.value)}updateSelection(e=!1,t=!1){(e||!this.view.observer.selectionRange.focusNode)&&this.view.observer.readSelectionRange();let{dom:i}=this.tile,s=this.view.root.activeElement,r=s==i,o=!r&&!(this.view.state.facet(dt)||i.tabIndex>-1)&&$i(i,this.view.observer.selectionRange)&&!(s&&i.contains(s));if(!(r||t||o))return;let l=this.forceSelection;this.forceSelection=!1;let a=this.view.state.selection.main,h,c;if(a.empty?c=h=this.inlineDOMNearPos(a.anchor,a.assoc||1):(c=this.inlineDOMNearPos(a.head,a.head==a.from?1:-1),h=this.inlineDOMNearPos(a.anchor,a.anchor==a.from?1:-1)),D.gecko&&a.empty&&!this.hasComposition&&tp(h)){let u=document.createTextNode("");this.view.observer.ignore(()=>h.node.insertBefore(u,h.node.childNodes[h.offset]||null)),h=c=new it(u,0),l=!0}let f=this.view.observer.selectionRange;(l||!f.focusNode||(!ji(h.node,h.offset,f.anchorNode,f.anchorOffset)||!ji(c.node,c.offset,f.focusNode,f.focusOffset))&&!this.suppressWidgetCursorChange(f,a))&&(this.view.observer.ignore(()=>{D.android&&D.chrome&&i.contains(f.focusNode)&&lp(f.focusNode,i)&&(i.blur(),i.focus({preventScroll:!0}));let u=tn(this.view.root);if(u)if(a.empty){if(D.gecko){let d=np(h.node,h.offset);if(d&&d!=3){let p=(d==1?Fh:Hh)(h.node,h.offset);p&&(h=new it(p.node,p.offset))}}u.collapse(h.node,h.offset),a.bidiLevel!=null&&u.caretBidiLevel!==void 0&&(u.caretBidiLevel=a.bidiLevel)}else if(u.extend){u.collapse(h.node,h.offset);try{u.extend(c.node,c.offset)}catch{}}else{let d=document.createRange();a.anchor>a.head&&([h,c]=[c,h]),d.setEnd(c.node,c.offset),d.setStart(h.node,h.offset),u.removeAllRanges(),u.addRange(d)}o&&this.view.root.activeElement==i&&(i.blur(),s&&s.focus())}),this.view.observer.setSelectionRange(h,c)),this.impreciseAnchor=h.precise?null:new it(f.anchorNode,f.anchorOffset),this.impreciseHead=c.precise?null:new it(f.focusNode,f.focusOffset)}suppressWidgetCursorChange(e,t){return this.hasComposition&&t.empty&&ji(e.focusNode,e.focusOffset,e.anchorNode,e.anchorOffset)&&this.posFromDOM(e.focusNode,e.focusOffset)==t.head}enforceCursorAssoc(){if(this.hasComposition)return;let{view:e}=this,t=e.state.selection.main,i=tn(e.root),{anchorNode:s,anchorOffset:r}=e.observer.selectionRange;if(!i||!t.empty||!t.assoc||!i.modify)return;let o=this.lineAt(t.head,t.assoc);if(!o)return;let l=o.posAtStart;if(t.head==l||t.head==l+o.length)return;let a=this.coordsAt(t.head,-1),h=this.coordsAt(t.head,1);if(!a||!h||a.bottom>h.top)return;let c=this.domAtPos(t.head+t.assoc,t.assoc);i.collapse(c.node,c.offset),i.modify("move",t.assoc<0?"forward":"backward","lineboundary"),e.observer.readSelectionRange();let f=e.observer.selectionRange;e.docView.posFromDOM(f.anchorNode,f.anchorOffset)!=t.from&&i.collapse(s,r)}posFromDOM(e,t){let i=this.tile.nearest(e);if(!i)return this.tile.dom.compareDocumentPosition(e)&2?0:this.view.state.doc.length;let s=i.posAtStart;if(i.isComposite()){let r;if(e==i.dom)r=i.dom.childNodes[t];else{let o=mt(e)==0?0:t==0?-1:1;for(;;){let l=e.parentNode;if(l==i.dom)break;o==0&&l.firstChild!=l.lastChild&&(e==l.firstChild?o=-1:o=1),e=l}o<0?r=e:r=e.nextSibling}if(r==i.dom.firstChild)return s;for(;r&&!X.get(r);)r=r.nextSibling;if(!r)return s+i.length;for(let o=0,l=s;;o++){let a=i.children[o];if(a.dom==r)return l;l+=a.length+a.breakAfter}}else return i.isText()?e==i.dom?s+t:s+(t?i.length:0):s}domAtPos(e,t){let{tile:i,offset:s}=this.tile.resolveBlock(e,t);return i.isWidget()?i.domPosFor(s,t):i.domIn(s,t)}inlineDOMNearPos(e,t){let i,s=-1,r=!1,o,l=-1,a=!1;return this.tile.blockTiles((h,c)=>{if(h.isWidget()){if(h.flags&32&&c>=e)return!0;h.flags&16&&(r=!0)}else{let f=c+h.length;if(c<=e&&(i=h,s=e-c,r=f<e),f>=e&&!o&&(o=h,l=e-c,a=c>e),c>e&&o)return!0}}),!i&&!o?this.domAtPos(e,t):(r&&o?i=null:a&&i&&(o=null),i&&t<0||!o?i.domIn(s,t):o.domIn(l,t))}coordsAt(e,t,i){let{tile:s,offset:r}=this.tile.resolveBlock(e,t);return s.isWidget()?s.widget instanceof _i?null:s.coordsInWidget(r,t,!0):s.coordsIn(r,t,i)}lineAt(e,t){let{tile:i}=this.tile.resolveBlock(e,t);return i.isLine()?i:null}coordsForChar(e){let{tile:t,offset:i}=this.tile.resolveBlock(e,1);if(!t.isLine())return null;function s(r,o){if(r.isComposite())for(let l of r.children){if(l.length>=o){let a=s(l,o);if(a)return a}if(o-=l.length,o<0)break}else if(r.isText()&&o<r.length){let l=ee(r.text,o);if(l==o)return null;let a=nn(r.dom,o,l).getClientRects();for(let h=0;h<a.length;h++){let c=a[h];if(h==a.length-1||c.top<c.bottom&&c.left<c.right)return c}}return null}return s(t,i)}measureVisibleLineHeights(e){let t=[],{from:i,to:s}=e,r=this.view.contentDOM.clientWidth,o=r>Math.max(this.view.scrollDOM.clientWidth,this.minWidth)+1,l=-1,a=this.view.textDirection==q.LTR,h=0,c=(f,u,d)=>{for(let p=0;p<f.children.length&&!(u>s);p++){let m=f.children[p],g=u+m.length,y=m.dom.getBoundingClientRect(),{height:k}=y;if(d&&!p&&(h+=y.top-d.top),m instanceof pt)g>i&&c(m,u,y);else if(u>=i&&(h>0&&t.push(-h),t.push(k+h),h=0,o)){let x=m.dom.lastChild,O=x?es(x):[];if(O.length){let w=O[O.length-1],S=a?w.right-y.left:y.right-w.left;S>l&&(l=S,this.minWidth=r,this.minWidthFrom=u,this.minWidthTo=g)}}d&&p==f.children.length-1&&(h+=d.bottom-y.bottom),u=g+m.breakAfter}};return c(this.tile,0,null),t}textDirectionAt(e){let{tile:t}=this.tile.resolveBlock(e,1);return getComputedStyle(t.dom).direction=="rtl"?q.RTL:q.LTR}measureTextSize(){let e=this.tile.blockTiles(o=>{if(o.isLine()&&o.children.length&&o.length<=20){let l=0,a;for(let h of o.children){if(!h.isText()||/[^ -~]/.test(h.text))return;let c=es(h.dom);if(c.length!=1)return;l+=c[0].width,a=c[0].height}if(l)return{lineHeight:o.dom.getBoundingClientRect().height,charWidth:l/o.length,textHeight:a}}});if(e)return e;let t=document.createElement("div"),i,s,r;return t.className="cm-line",t.style.width="99999px",t.style.position="absolute",t.textContent="abc def ghi jkl mno pqr stu",this.view.observer.ignore(()=>{this.tile.dom.appendChild(t);let o=es(t.firstChild)[0];i=t.getBoundingClientRect().height,s=o&&o.width?o.width/27:7,r=o&&o.height?o.height:i,t.remove()}),{lineHeight:i,charWidth:s,textHeight:r}}computeBlockGapDeco(){let e=[],t=this.view.viewState;for(let i=0,s=0;;s++){let r=s==t.viewports.length?null:t.viewports[s],o=r?r.from-1:this.view.state.doc.length;if(o>i){let l=(t.lineBlockAt(o).bottom-t.lineBlockAt(i).top)/this.view.scaleY;e.push(B.replace({widget:new _i(l),block:!0,inclusive:!0,isBlockGap:!0}).range(i,o))}if(!r)break;i=r.to+1}return B.set(e)}updateDeco(){let e=1,t=this.view.state.facet(Cs).map(r=>(this.dynamicDecorationMap[e++]=typeof r=="function")?r(this.view):r),i=!1,s=this.view.state.facet(Jo).map((r,o)=>{let l=typeof r=="function";return l&&(i=!0),l?r(this.view):r});for(s.length&&(this.dynamicDecorationMap[e++]=i,t.push(H.join(s))),this.decorations=[this.editContextFormatting,...t,this.computeBlockGapDeco(),this.view.viewState.lineGapDeco];e<this.decorations.length;)this.dynamicDecorationMap[e++]=!1;this.blockWrappers=this.view.state.facet(tc).map(r=>typeof r=="function"?r(this.view):r)}scrollIntoView(e){if(e.isSnapshot){let h=this.view.viewState.lineBlockAt(e.range.head);this.view.scrollDOM.scrollTop=h.top-e.yMargin,this.view.scrollDOM.scrollLeft=e.xMargin;return}for(let h of this.view.state.facet(Qh))try{if(h(this.view,e.range,e))return!0}catch(c){he(this.view.state,c,"scroll handler")}let{range:t}=e,i=this.coordsAt(t.head,t.assoc||(t.head>t.anchor?-1:1)),s;if(!i)return;!t.empty&&(s=this.coordsAt(t.anchor,t.anchor>t.head?-1:1))&&(i={left:Math.min(i.left,s.left),top:Math.min(i.top,s.top),right:Math.max(i.right,s.right),bottom:Math.max(i.bottom,s.bottom)});let r=Qo(this.view),o={left:i.left-r.left,top:i.top-r.top,right:i.right+r.right,bottom:i.bottom+r.bottom},{offsetWidth:l,offsetHeight:a}=this.view.scrollDOM;if(Nd(this.view.scrollDOM,o,t.head<t.anchor?-1:1,e.x,e.y,Math.max(Math.min(e.xMargin,l),-l),Math.max(Math.min(e.yMargin,a),-a),this.view.textDirection==q.LTR),window.visualViewport&&window.innerHeight-window.visualViewport.height>1&&(i.top>window.visualViewport.offsetTop+window.visualViewport.height||i.bottom<window.visualViewport.offsetTop)){let h=this.view.docView.lineAt(t.head,1);if(h){let c=Rh(h.dom);h.dom.scrollIntoView({block:"nearest"}),Ph(c,!1)}}}lineHasWidget(e){let t=i=>i.isWidget()||i.children.some(t);return t(this.tile.resolveBlock(e,1).tile)}destroy(){ao(this.tile)}};sp=class{constructor(){this.changes=[]}compareRange(e,t){di(e,t,this.changes)}comparePoint(e,t){di(e,t,this.changes)}boundChange(e){di(e,e,this.changes)}};ho=class{constructor(){this.changes=[]}compareRange(e,t){di(e,t,this.changes)}comparePoint(){}boundChange(e){di(e,e,this.changes)}};_i=class extends we{constructor(e){super(),this.height=e}toDOM(){let e=document.createElement("div");return e.className="cm-gap",this.updateDOM(e),e}eq(e){return e.height==this.height}updateDOM(e){return e.style.height=this.height+"px",!0}get editable(){return!0}get estimatedHeight(){return this.height}ignoreEvent(){return!1}};Ve=class{constructor(e,t){this.pos=e,this.assoc=t}};uo=class{constructor(e,t,i,s){this.view=e,this.x=t,this.y=i,this.baseDir=s,this.line=null,this.spans=null}bidiSpansAt(e){return(!this.line||this.line.from>e||this.line.to<e)&&(this.line=this.view.state.doc.lineAt(e),this.spans=this.view.bidiSpans(this.line)),this}baseDirAt(e,t){let{line:i,spans:s}=this.bidiSpansAt(e);return s[ze.find(s,e-i.from,-1,t)].level==this.baseDir}dirAt(e,t){let{line:i,spans:s}=this.bidiSpansAt(e);return s[ze.find(s,e-i.from,-1,t)].dir}bidiIn(e,t){let{spans:i,line:s}=this.bidiSpansAt(e);return i.length>1||i.length&&(i[0].level!=this.baseDir||i[0].to+s.from<t)}scan(e,t,i=!1){let s=0,r=e.length-1,o=new Set,l=this.bidiIn(e[0],e[r]),a,h,c=-1,f=1e9,u;e:for(;s<r;){let p=r-s,m=s+r>>1;t:if(o.has(m)){for(let k=1;k<p;k++){let x=m+k;if(x>=r&&(x-=p),!o.has(x)){m=x;break t}}break e}o.add(m);let g=t(m),y=0;if(g)for(let k=0;k<g.length;k++){let x=g[k];if(!(x.width==0&&g.length>1))if(x.bottom<this.y)(!a||a.bottom<x.bottom)&&(a=x),y=1;else if(x.top>this.y)(!h||h.top>x.top)&&(h=x),y=-1;else{let O=x.left>this.x?this.x-x.left:x.right<this.x?this.x-x.right:0,w=Math.abs(O);w<f&&(c=m,f=w,u=x),O&&(y=O<0==(this.baseDir==q.LTR)?-1:1)}}y==-1&&(!l||this.baseDirAt(e[m],1))?r=m:y==1&&(!l||this.baseDirAt(e[m+1],-1))&&(s=m+1)}if(!u){if(!h&&!a)return{i:0,after:!1};let p=a&&(!h||this.y-a.bottom<h.top-this.y)?a:h;return this.y=(p.top+p.bottom)/2,this.scan(e,t,!0)}if(f&&!i){let{top:p,bottom:m}=u;if(a&&a.bottom>(p+p+m)/3)return this.y=a.bottom-1,this.scan(e,t,!0);if(h&&h.top<(p+m+m)/3)return this.y=h.top+1,this.scan(e,t,!0)}let d=(l?this.dirAt(e[c],1):this.baseDir)==q.LTR;return{i:c,after:this.x>(u.left+u.right)/2==d}}scanText(e,t){let i=[];for(let r=0;r<e.length;r=ee(e.text,r))i.push(t+r);i.push(t+e.length);let s=this.scan(i,r=>{let o=i[r]-t,l=i[r+1]-t;return nn(e.dom,o,l).getClientRects()});return s.after?new Ve(i[s.i+1],-1):new Ve(i[s.i],1)}scanTile(e,t){if(!e.length)return new Ve(t,1);if(e.children.length==1){let l=e.children[0];if(l.isText())return this.scanText(l,t);if(l.isComposite())return this.scanTile(l,t)}let i=[t];for(let l=0,a=t;l<e.children.length;l++)i.push(a+=e.children[l].length);let s=this.scan(i,l=>{let a=e.children[l];return a.flags&48?null:(se(a.dom)?a.dom:nn(a.dom,0,a.length)).getClientRects()}),r=e.children[s.i],o=i[s.i];return r.isText()?this.scanText(r,o):r.isComposite()?this.scanTile(r,o):s.after?new Ve(i[s.i+1],-1):new Ve(o,1)}},ai="\uFFFF",po=class{constructor(e,t){this.points=e,this.view=t,this.text="",this.lineSeparator=t.state.facet(W.lineSeparator)}append(e){this.text+=e}lineBreak(){this.text+=ai}readRange(e,t){if(!e)return this;let i=e.parentNode;for(let s=e;;){this.findPointBefore(i,s);let r=this.text.length;this.readNode(s);let o=X.get(s),l=s.nextSibling;if(l==t){o?.breakAfter&&!l&&i!=this.view.contentDOM&&this.lineBreak();break}let a=X.get(l);(o&&a?o.breakAfter:(o?o.breakAfter:as(s))||as(l)&&(s.nodeName!="BR"||o?.isWidget())&&this.text.length>r)&&!mp(l,t)&&this.lineBreak(),s=l}return this.findPointBefore(i,t),this}readTextNode(e){let t=e.nodeValue;for(let i of this.points)i.node==e&&(i.pos=this.text.length+Math.min(i.offset,t.length));for(let i=0,s=this.lineSeparator?null:/\r\n?|\n/g;;){let r=-1,o=1,l;if(this.lineSeparator?(r=t.indexOf(this.lineSeparator,i),o=this.lineSeparator.length):(l=s.exec(t))&&(r=l.index,o=l[0].length),this.append(t.slice(i,r<0?t.length:r)),r<0)break;if(this.lineBreak(),o>1)for(let a of this.points)a.node==e&&a.pos>this.text.length&&(a.pos-=o-1);i=r+o}}readNode(e){let t=X.get(e),i=t&&t.overrideDOMText;if(i!=null){this.findPointInside(e,i.length);for(let s=i.iter();!s.next().done;)s.lineBreak?this.lineBreak():this.append(s.value)}else mi(e)?this.readTextNode(e):e.nodeName=="BR"?e.nextSibling&&this.lineBreak():se(e)&&this.readRange(e.firstChild,null)}findPointBefore(e,t){for(let i of this.points)i.node==e&&e.childNodes[i.offset]==t&&(i.pos=this.text.length)}findPointInside(e,t){for(let i of this.points)(mi(e)?i.node==e:e.contains(i.node))&&(i.pos=this.text.length+(pp(e,i.node,i.offset)?t:0))}};ds=class{constructor(e,t){this.node=e,this.offset=t,this.pos=-1}},mo=class{constructor(e,t,i,s){this.typeOver=s,this.bounds=null,this.text="",this.domChanged=t>-1;let{impreciseHead:r,impreciseAnchor:o}=e.docView,l=e.state.selection;if(e.state.readOnly&&t>-1)this.newSel=null;else if(t>-1&&(this.bounds=ac(e.docView.tile,t,i,0))){let a=r||o?[]:yp(e),h=new po(a,e);h.readRange(this.bounds.startDOM,this.bounds.endDOM),this.text=h.text,this.newSel=bp(a,this.bounds.from)}else{let a=e.observer.selectionRange,h=r&&r.node==a.focusNode&&r.offset==a.focusOffset||!Xr(e.contentDOM,a.focusNode)?l.main.head:e.docView.posFromDOM(a.focusNode,a.focusOffset),c=o&&o.node==a.anchorNode&&o.offset==a.anchorOffset||!Xr(e.contentDOM,a.anchorNode)?l.main.anchor:e.docView.posFromDOM(a.anchorNode,a.anchorOffset),f=e.viewport;if((D.ios||D.chrome)&&h!=c&&Math.min(h,c)<=l.main.from&&Math.max(h,c)>=l.main.to&&(f.from>0||f.to<e.state.doc.length)){let u=Math.min(h,c),d=Math.max(h,c),p=f.from-u,m=f.to-d;(p==0||p==1||u==0)&&(m==0||m==-1||d==e.state.doc.length)&&(h=0,c=e.state.doc.length)}if(e.inputState.composing>-1&&l.ranges.length>1)this.newSel=l.replaceRange(b.range(c,h));else if(e.lineWrapping&&c==h&&!(l.main.empty&&l.main.head==h)&&e.inputState.lastTouchTime>Date.now()-100){let u=e.coordsAtPos(h,-1),d=0;u&&(d=e.inputState.lastTouchY<=u.bottom?-1:1),this.newSel=b.create([b.cursor(h,d)])}else this.newSel=b.single(c,h)}}};yo=class{setSelectionOrigin(e){this.lastSelectionOrigin=e,this.lastSelectionTime=Date.now()}constructor(e){this.view=e,this.lastKeyCode=0,this.lastKeyTime=0,this.touchActive=!1,this.lastTouchTime=0,this.lastTouchX=0,this.lastTouchY=0,this.lastFocusTime=0,this.lastScrollTop=0,this.lastScrollLeft=0,this.lastWheelEvent=0,this.pendingIOSKey=void 0,this.lastIOSMomentumScroll=0,this.tabFocusMode=-1,this.lastSelectionOrigin=null,this.lastSelectionTime=0,this.lastContextMenu=0,this.scrollHandlers=[],this.handlers=Object.create(null),this.composing=-1,this.compositionFirstChange=null,this.compositionEndedAt=0,this.compositionPendingKey=!1,this.compositionPendingChange=!1,this.insertingText="",this.insertingTextAt=0,this.mouseSelection=null,this.draggedContent=null,this.handleEvent=this.handleEvent.bind(this),this.notifiedFocused=e.hasFocus,D.safari&&e.contentDOM.addEventListener("input",()=>null),D.gecko&&Rp(e.contentDOM.ownerDocument)}handleEvent(e){!Mp(this.view,e)||this.ignoreDuringComposition(e)||e.type=="keydown"&&this.keydown(e)||(this.view.updateState!=0?Promise.resolve().then(()=>this.runHandlers(e.type,e)):this.runHandlers(e.type,e))}runHandlers(e,t){let i=this.handlers[e];if(i){for(let s of i.observers)s(this.view,t);for(let s of i.handlers){if(t.defaultPrevented)break;if(s(this.view,t)){t.preventDefault();break}}}}ensureHandlers(e){let t=wp(e),i=this.handlers,s=this.view.contentDOM;for(let r in t)if(r!="scroll"){let o=!t[r].handlers.length,l=i[r];l&&o!=!l.handlers.length&&(s.removeEventListener(r,this.handleEvent),l=null),l||s.addEventListener(r,this.handleEvent,{passive:o})}for(let r in i)r!="scroll"&&!t[r]&&s.removeEventListener(r,this.handleEvent);this.handlers=t}keydown(e){if(this.lastKeyCode=e.keyCode,this.lastKeyTime=Date.now(),e.keyCode==9&&this.tabFocusMode>-1&&(!this.tabFocusMode||Date.now()<=this.tabFocusMode))return!0;if(this.tabFocusMode>0&&e.keyCode!=27&&uc.indexOf(e.keyCode)<0&&(this.tabFocusMode=-1),D.android&&D.chrome&&!e.synthetic&&(e.keyCode==13||e.keyCode==8))return this.view.observer.delayAndroidKey(e.key,e.keyCode),!0;if(D.ios&&!e.synthetic&&!e.altKey&&!e.metaKey&&(fc.some(t=>t.keyCode==e.keyCode)&&!e.ctrlKey||kp.indexOf(e.key)>-1&&e.ctrlKey)){let t={ctrlKey:e.ctrlKey,altKey:e.altKey,metaKey:e.metaKey,shiftKey:e.shiftKey};t.shiftKey&&D.ios&&!/^(off|none)$/.test(this.view.contentDOM.autocapitalize)&&xp(this.view.win)&&(t.shiftKey=!1);let i=this.pendingIOSKey={key:e.key,keyCode:e.keyCode,mods:t};return setTimeout(()=>{this.pendingIOSKey==i&&this.flushIOSKey()},50),!0}return e.keyCode!=229&&this.view.observer.forceFlush(),!1}flushIOSKey(e){let t=this.pendingIOSKey;return!t||this.view.observer.pendingRecords().length||t.key=="Enter"&&e&&e.from<e.to&&/^\S+$/.test(e.insert.toString())?!1:(this.pendingIOSKey=void 0,pi(this.view.contentDOM,t.key,t.keyCode,t.mods))}ignoreDuringComposition(e){return!/^key/.test(e.type)||e.synthetic?!1:this.composing>0?!0:D.safari&&!D.ios&&this.compositionPendingKey&&Date.now()-this.compositionEndedAt<100?(this.compositionPendingKey=!1,!0):!1}startMouseSelection(e){this.mouseSelection&&this.mouseSelection.destroy(),this.mouseSelection=e}update(e){this.view.observer.update(e),this.mouseSelection&&this.mouseSelection.update(e),this.draggedContent&&e.docChanged&&(this.draggedContent=this.draggedContent.map(e.changes)),e.transactions.length&&(this.lastKeyCode=this.lastSelectionTime=0)}destroy(){this.mouseSelection&&this.mouseSelection.destroy()}};fc=[{key:"Backspace",keyCode:8,inputType:"deleteContentBackward"},{key:"Enter",keyCode:13,inputType:"insertParagraph"},{key:"Enter",keyCode:13,inputType:"insertLineBreak"},{key:"Delete",keyCode:46,inputType:"deleteContentForward"}],kp="dthko",uc=[16,17,18,20,91,92,224,225],Un=6;bo=class{constructor(e,t,i,s){this.view=e,this.startEvent=t,this.style=i,this.mustSelect=s,this.scrollSpeed={x:0,y:0},this.scrolling=-1,this.lastEvent=t,this.scrollParents=Eh(e.contentDOM),this.atoms=e.state.facet(sn).map(o=>o(e));let r=e.contentDOM.ownerDocument;r.addEventListener("mousemove",this.move=this.move.bind(this)),r.addEventListener("mouseup",this.up=this.up.bind(this)),this.extend=t.shiftKey,this.multiple=e.state.facet(W.allowMultipleSelections)&&Sp(e,t),this.dragging=Ap(e,t)&&mc(t)==1?null:!1}start(e){this.dragging===!1&&this.select(e)}move(e){if(e.buttons==0)return this.destroy();if(this.dragging||this.dragging==null&&vp(this.startEvent,e)<10)return;this.select(this.lastEvent=e);let t=0,i=0,s=0,r=0,o=this.view.win.innerWidth,l=this.view.win.innerHeight;this.scrollParents.x&&({left:s,right:o}=this.scrollParents.x.getBoundingClientRect()),this.scrollParents.y&&({top:r,bottom:l}=this.scrollParents.y.getBoundingClientRect());let a=Qo(this.view);e.clientX-a.left<=s+Un?t=-Gn(s-e.clientX):e.clientX+a.right>=o-Un&&(t=Gn(e.clientX-o)),e.clientY-a.top<=r+Un?i=-Gn(r-e.clientY):e.clientY+a.bottom>=l-Un&&(i=Gn(e.clientY-l)),this.setScrollSpeed(t,i)}up(e){this.dragging==null&&this.select(this.lastEvent),this.dragging||e.preventDefault(),this.destroy()}destroy(){this.setScrollSpeed(0,0);let e=this.view.contentDOM.ownerDocument;e.removeEventListener("mousemove",this.move),e.removeEventListener("mouseup",this.up),this.view.inputState.mouseSelection=this.view.inputState.draggedContent=null}setScrollSpeed(e,t){this.scrollSpeed={x:e,y:t},e||t?this.scrolling<0&&(this.scrolling=setInterval(()=>this.scroll(),50)):this.scrolling>-1&&(clearInterval(this.scrolling),this.scrolling=-1)}scroll(){let{x:e,y:t}=this.scrollSpeed;e&&this.scrollParents.x&&(this.scrollParents.x.scrollLeft+=e,e=0),t&&this.scrollParents.y&&(this.scrollParents.y.scrollTop+=t,t=0),(e||t)&&this.view.win.scrollBy(e,t),this.dragging===!1&&this.select(this.lastEvent)}select(e){let{view:t}=this,i=lc(this.atoms,this.style.get(e,this.extend,this.multiple));(this.mustSelect||!i.eq(t.state.selection,this.dragging===!1))&&this.view.dispatch({selection:i,userEvent:"select.pointer"}),this.mustSelect=!1}update(e){e.transactions.some(t=>t.isUserEvent("input.type"))?this.destroy():this.style.update(e)&&setTimeout(()=>this.select(this.lastEvent),20)}};Ge=Object.create(null),ke=Object.create(null),dc=D.ie&&D.ie_version<15||D.ios&&D.webkit_version<604;ke.scroll=n=>{let e=n.inputState;e.lastScrollTop=n.scrollDOM.scrollTop,e.lastScrollLeft=n.scrollDOM.scrollLeft,D.ios&&!e.touchActive&&(e.lastIOSMomentumScroll=Date.now())};ke.wheel=ke.mousewheel=n=>{n.inputState.lastWheelEvent=Date.now()};Ge.keydown=(n,e)=>(n.inputState.setSelectionOrigin("select"),e.keyCode==27&&n.inputState.tabFocusMode!=0&&(n.inputState.tabFocusMode=Date.now()+2e3),!1);ke.touchstart=(n,e)=>{let t=n.inputState,i=e.targetTouches[0];t.touchActive=!0,t.lastTouchTime=Date.now(),i&&(t.lastTouchX=i.clientX,t.lastTouchY=i.clientY),t.setSelectionOrigin("select.pointer")};ke.touchmove=n=>{n.inputState.setSelectionOrigin("select.pointer")};ke.touchend=(n,e)=>{n.inputState.touchActive=!1};Ge.mousedown=(n,e)=>{if(n.observer.flush(),n.inputState.lastTouchTime>Date.now()-2e3)return!1;let t=null;for(let i of n.state.facet(Uh))if(t=i(n,e),t)break;if(!t&&e.button==0&&(t=Op(n,e)),t){let i=!n.hasFocus;n.inputState.startMouseSelection(new bo(n,e,t,i)),i&&n.observer.ignore(()=>{Ih(n.contentDOM);let r=n.root.activeElement;r&&!r.contains(n.contentDOM)&&r.blur()});let s=n.inputState.mouseSelection;if(s)return s.start(e),s.dragging===!1}else n.inputState.setSelectionOrigin("select.pointer");return!1};Dp=D.ie&&D.ie_version<=11,sh=null,rh=0,oh=0;Ge.dragstart=(n,e)=>{let{selection:{main:t}}=n.state;if(e.target.draggable){let s=n.docView.tile.nearest(e.target);if(s&&s.isWidget()){let r=s.posAtStart,o=r+s.length;(r>=t.to||o<=t.from)&&(t=b.undirectionalRange(r,o))}}let{inputState:i}=n;return i.mouseSelection&&(i.mouseSelection.dragging=!0),i.draggedContent=t,e.dataTransfer&&(e.dataTransfer.setData("Text",As(n.state,Yo,n.state.sliceDoc(t.from,t.to))),e.dataTransfer.effectAllowed="copyMove"),!1};Ge.dragend=n=>(n.inputState.draggedContent=null,!1);Ge.drop=(n,e)=>{if(!e.dataTransfer)return!1;if(n.state.readOnly)return!0;let t=e.dataTransfer.files;if(t&&t.length){let i=Array(t.length),s=0,r=()=>{++s==t.length&&lh(n,e,i.filter(o=>o!=null).join(n.state.lineBreak),!1)};for(let o=0;o<t.length;o++){let l=new FileReader;l.onerror=r,l.onload=()=>{/[\x00-\x08\x0e-\x1f]{2}/.test(l.result)||(i[o]=l.result),r()},l.readAsText(t[o])}return!0}else{let i=e.dataTransfer.getData("Text");if(i)return lh(n,e,i,!0),!0}return!1};Ge.paste=(n,e)=>{if(n.state.readOnly)return!0;n.observer.flush();let t=dc?null:e.clipboardData;return t?(pc(n,t.getData("text/plain")||t.getData("text/uri-list")),!0):(Tp(n),!1)};xo=null;Ge.copy=Ge.cut=(n,e)=>{if(!$i(n.contentDOM,n.observer.selectionRange))return!1;let{text:t,ranges:i,linewise:s}=Ep(n.state);if(!t&&!s)return!1;xo=s?t:null,e.type=="cut"&&!n.state.readOnly&&n.dispatch({changes:i,scrollIntoView:!0,userEvent:"delete.cut"});let r=dc?null:e.clipboardData;return r?(r.clearData(),r.setData("text/plain",t),!0):(Lp(n,t),!1)};gc=Se.define();ke.focus=n=>{n.inputState.lastFocusTime=Date.now(),!n.scrollDOM.scrollTop&&(n.inputState.lastScrollTop||n.inputState.lastScrollLeft)&&(n.scrollDOM.scrollTop=n.inputState.lastScrollTop,n.scrollDOM.scrollLeft=n.inputState.lastScrollLeft),bc(n)};ke.blur=n=>{n.observer.clearSelectionRange(),bc(n)};ke.compositionstart=ke.compositionupdate=(n,e)=>{if(!n.observer.editContext&&(n.inputState.compositionFirstChange==null&&(n.inputState.compositionFirstChange=!0),n.inputState.composing<0)){let{main:t}=n.state.selection;!t.empty&&n.lineBlockAt(t.from).from!=n.lineBlockAt(t.to).from&&!n.state.readOnly&&n.dispatch({changes:n.state.selection.ranges.filter(i=>!i.empty).map(i=>({from:i.from,to:i.to})),userEvent:"input"}),n.inputState.composing=0}};ke.compositionend=n=>{n.observer.editContext||(n.inputState.composing=-1,n.inputState.compositionEndedAt=Date.now(),n.inputState.compositionPendingKey=!0,n.inputState.compositionPendingChange=n.observer.pendingRecords().length>0,n.inputState.compositionFirstChange=null,D.chrome&&D.android?n.observer.flushSoon():n.inputState.compositionPendingChange?Promise.resolve().then(()=>n.observer.flush()):setTimeout(()=>{n.inputState.composing<0&&n.docView.hasComposition&&n.update([])},50))};ke.contextmenu=n=>{n.inputState.lastContextMenu=Date.now()};Ge.beforeinput=(n,e)=>{var t,i;if((e.inputType=="insertText"||e.inputType=="insertCompositionText")&&(n.inputState.insertingText=e.data,n.inputState.insertingTextAt=Date.now()),e.inputType=="insertReplacementText"&&n.observer.editContext){let r=(t=e.dataTransfer)===null||t===void 0?void 0:t.getData("text/plain"),o=e.getTargetRanges();if(r&&o.length){let l=o[0],a=n.posAtDOM(l.startContainer,l.startOffset),h=n.posAtDOM(l.endContainer,l.endOffset);return Zo(n,{from:a,to:h,insert:n.state.toText(r)},null),!0}}let s;if(D.chrome&&D.android&&(s=fc.find(r=>r.inputType==e.inputType))&&(n.observer.delayAndroidKey(s.key,s.keyCode),s.key=="Backspace"||s.key=="Delete")){let r=((i=window.visualViewport)===null||i===void 0?void 0:i.height)||0;setTimeout(()=>{var o;(((o=window.visualViewport)===null||o===void 0?void 0:o.height)||0)>r+10&&n.hasFocus&&(n.contentDOM.blur(),n.focus())},100)}return D.ios&&e.inputType=="deleteContentForward"&&n.observer.flushSoon(),D.safari&&e.inputType=="insertText"&&n.inputState.composing>=0&&setTimeout(()=>ke.compositionend(n,e),20),!1};ah=new Set;hh=["pre-wrap","normal","pre-line","break-spaces"],ki=!1;wo=class{constructor(e){this.lineWrapping=e,this.doc=N.empty,this.heightSamples={},this.lineHeight=14,this.charWidth=7,this.textHeight=14,this.lineLength=30}heightForGap(e,t){let i=this.doc.lineAt(t).number-this.doc.lineAt(e).number+1;return this.lineWrapping&&(i+=Math.max(0,Math.ceil((t-e-i*this.lineLength*.5)/this.lineLength))),this.lineHeight*i}heightForLine(e){return this.lineWrapping?(1+Math.max(0,Math.ceil((e-this.lineLength)/Math.max(1,this.lineLength-5))))*this.lineHeight:this.lineHeight}setDoc(e){return this.doc=e,this}mustRefreshForWrapping(e){return hh.indexOf(e)>-1!=this.lineWrapping}mustRefreshForHeights(e){let t=!1;for(let i=0;i<e.length;i++){let s=e[i];s<0?i++:this.heightSamples[Math.floor(s*10)]||(t=!0,this.heightSamples[Math.floor(s*10)]=!0)}return t}refresh(e,t,i,s,r,o){let l=hh.indexOf(e)>-1,a=Math.abs(t-this.lineHeight)>.3||this.lineWrapping!=l;if(this.lineWrapping=l,this.lineHeight=t,this.charWidth=i,this.textHeight=s,this.lineLength=r,a){this.heightSamples={};for(let h=0;h<o.length;h++){let c=o[h];c<0?h++:this.heightSamples[Math.floor(c*10)]=!0}}return a}},ko=class{constructor(e,t){this.from=e,this.heights=t,this.index=0}get more(){return this.index<this.heights.length}},je=class n{constructor(e,t,i,s,r){this.from=e,this.length=t,this.top=i,this.height=s,this._content=r}get type(){return typeof this._content=="number"?ce.Text:Array.isArray(this._content)?this._content:this._content.type}get to(){return this.from+this.length}get bottom(){return this.top+this.height}get widget(){return this._content instanceof qt?this._content.widget:null}get widgetLineBreaks(){return typeof this._content=="number"?this._content:0}join(e){let t=(Array.isArray(this._content)?this._content:[this]).concat(Array.isArray(e._content)?e._content:[e]);return new n(this.from,this.length+e.length,this.top,this.height+e.height,t)}},G=(function(n){return n[n.ByPos=0]="ByPos",n[n.ByHeight=1]="ByHeight",n[n.ByPosNoHeight=2]="ByPosNoHeight",n})(G||(G={})),ts=.001,Be=class n{constructor(e,t,i=2){this.length=e,this.height=t,this.flags=i}get outdated(){return(this.flags&2)>0}set outdated(e){this.flags=(e?2:0)|this.flags&-3}setHeight(e){this.height!=e&&(Math.abs(this.height-e)>ts&&(ki=!0),this.height=e)}replace(e,t,i){return n.of(i)}decomposeLeft(e,t){t.push(this)}decomposeRight(e,t){t.push(this)}applyChanges(e,t,i,s){let r=this,o=i.doc;for(let l=s.length-1;l>=0;l--){let{fromA:a,toA:h,fromB:c,toB:f}=s[l],u=r.lineAt(a,G.ByPosNoHeight,i.setDoc(t),0,0),d=u.to>=h?u:r.lineAt(h,G.ByPosNoHeight,i,0,0);for(f+=d.to-h,h=d.to;l>0&&u.from<=s[l-1].toA;)a=s[l-1].fromA,c=s[l-1].fromB,l--,a<u.from&&(u=r.lineAt(a,G.ByPosNoHeight,i,0,0));c+=u.from-a,a=u.from;let p=So.build(i.setDoc(o),e,c,f);r=ps(r,r.replace(a,h,p))}return r.updateHeight(i,0)}static empty(){return new We(0,0,0)}static of(e){if(e.length==1)return e[0];let t=0,i=e.length,s=0,r=0;for(;;)if(t==i)if(s>r*2){let l=e[t-1];l.break?e.splice(--t,1,l.left,null,l.right):e.splice(--t,1,l.left,l.right),i+=1+l.break,s-=l.size}else if(r>s*2){let l=e[i];l.break?e.splice(i,1,l.left,null,l.right):e.splice(i,1,l.left,l.right),i+=2+l.break,r-=l.size}else break;else if(s<r){let l=e[t++];l&&(s+=l.size)}else{let l=e[--i];l&&(r+=l.size)}let o=!1;return e[t-1]==null?(o=!0,t--):e[t]==null&&(o=!0,i++),new vo(n.of(e.slice(0,t)),o,n.of(e.slice(i)))}};Be.prototype.size=1;Pp=B.replace({}),ms=class extends Be{constructor(e,t,i){super(e,t),this.deco=i,this.spaceAbove=0}mainBlock(e,t){return new je(t,this.length,e+this.spaceAbove,this.height-this.spaceAbove,this.deco||0)}blockAt(e,t,i,s){return this.spaceAbove&&e<i+this.spaceAbove?new je(s,0,i,this.spaceAbove,Pp):this.mainBlock(i,s)}lineAt(e,t,i,s,r){let o=this.mainBlock(s,r);return this.spaceAbove?this.blockAt(0,i,s,r).join(o):o}forEachLine(e,t,i,s,r,o){e<=r+this.length&&t>=r&&o(this.lineAt(0,G.ByPos,i,s,r))}setMeasuredHeight(e){let t=e.heights[e.index++];t<0?(this.spaceAbove=-t,t=e.heights[e.index++]):this.spaceAbove=0,this.setHeight(t)}updateHeight(e,t=0,i=!1,s){return s&&s.from<=t&&s.more&&this.setMeasuredHeight(s),this.outdated=!1,this}toString(){return`block(${this.length})`}},We=class n extends ms{constructor(e,t,i){super(e,t,null),this.collapsed=0,this.widgetHeight=0,this.breaks=0,this.spaceAbove=i}mainBlock(e,t){return new je(t,this.length,e+this.spaceAbove,this.height-this.spaceAbove,this.breaks)}replace(e,t,i){let s=i[0];return i.length==1&&(s instanceof n||s instanceof xt&&s.flags&4)&&Math.abs(this.length-s.length)<10?(s instanceof xt?s=new n(s.length,this.height,this.spaceAbove):s.height=this.height,this.outdated||(s.outdated=!1),s):Be.of(i)}updateHeight(e,t=0,i=!1,s){return s&&s.from<=t&&s.more?this.setMeasuredHeight(s):(i||this.outdated)&&(this.spaceAbove=0,this.setHeight(Math.max(this.widgetHeight,e.heightForLine(this.length-this.collapsed))+this.breaks*e.lineHeight)),this.outdated=!1,this}toString(){return`line(${this.length}${this.collapsed?-this.collapsed:""}${this.widgetHeight?":"+this.widgetHeight:""})`}},xt=class n extends Be{constructor(e){super(e,0)}heightMetrics(e,t){let i=e.doc.lineAt(t).number,s=e.doc.lineAt(t+this.length).number,r=s-i+1,o,l=0;if(e.lineWrapping){let a=Math.min(this.height,e.lineHeight*r);o=a/r,this.length>r+1&&(l=(this.height-a)/(this.length-r-1))}else o=this.height/r;return{firstLine:i,lastLine:s,perLine:o,perChar:l}}blockAt(e,t,i,s){let{firstLine:r,lastLine:o,perLine:l,perChar:a}=this.heightMetrics(t,s);if(t.lineWrapping){let h=s+(e<t.lineHeight?0:Math.round(Math.max(0,Math.min(1,(e-i)/this.height))*this.length)),c=t.doc.lineAt(h),f=l+c.length*a,u=Math.max(i,e-f/2);return new je(c.from,c.length,u,f,0)}else{let h=Math.max(0,Math.min(o-r,Math.floor((e-i)/l))),{from:c,length:f}=t.doc.line(r+h);return new je(c,f,i+l*h,l,0)}}lineAt(e,t,i,s,r){if(t==G.ByHeight)return this.blockAt(e,i,s,r);if(t==G.ByPosNoHeight){let{from:d,to:p}=i.doc.lineAt(e);return new je(d,p-d,0,0,0)}let{firstLine:o,perLine:l,perChar:a}=this.heightMetrics(i,r),h=i.doc.lineAt(e),c=l+h.length*a,f=h.number-o,u=s+l*f+a*(h.from-r-f);return new je(h.from,h.length,Math.max(s,Math.min(u,s+this.height-c)),c,0)}forEachLine(e,t,i,s,r,o){e=Math.max(e,r),t=Math.min(t,r+this.length);let{firstLine:l,perLine:a,perChar:h}=this.heightMetrics(i,r);for(let c=e,f=s;c<=t;){let u=i.doc.lineAt(c);if(c==e){let p=u.number-l;f+=a*p+h*(e-r-p)}let d=a+h*u.length;o(new je(u.from,u.length,f,d,0)),f+=d,c=u.to+1}}replace(e,t,i){let s=this.length-t;if(s>0){let r=i[i.length-1];r instanceof n?i[i.length-1]=new n(r.length+s):i.push(null,new n(s-1))}if(e>0){let r=i[0];r instanceof n?i[0]=new n(e+r.length):i.unshift(new n(e-1),null)}return Be.of(i)}decomposeLeft(e,t){t.push(new n(e-1),null)}decomposeRight(e,t){t.push(null,new n(this.length-e-1))}updateHeight(e,t=0,i=!1,s){let r=t+this.length;if(s&&s.from<=t+this.length&&s.more){let o=[],l=Math.max(t,s.from),a=-1;for(s.from>t&&o.push(new n(s.from-t-1).updateHeight(e,t));l<=r&&s.more;){let c=e.doc.lineAt(l).length;o.length&&o.push(null);let f=s.heights[s.index++],u=0;f<0&&(u=-f,f=s.heights[s.index++]),a==-1?a=f:Math.abs(f-a)>=ts&&(a=-2);let d=new We(c,f,u);d.outdated=!1,o.push(d),l+=c+1}l<=r&&o.push(null,new n(r-l).updateHeight(e,l));let h=Be.of(o);return(a<0||Math.abs(h.height-this.height)>=ts||Math.abs(a-this.heightMetrics(e,t).perLine)>=ts)&&(ki=!0),ps(this,h)}else(i||this.outdated)&&(this.setHeight(e.heightForGap(t,t+this.length)),this.outdated=!1);return this}toString(){return`gap(${this.length})`}},vo=class extends Be{constructor(e,t,i){super(e.length+(t?1:0)+i.length,e.height+i.height,(t?1:0)|(e.outdated||i.outdated?2:0)),this.left=e,this.right=i,this.size=e.size+i.size}get break(){return this.flags&1}blockAt(e,t,i,s){let r=i+this.left.height;return e<r?this.left.blockAt(e,t,i,s):this.right.blockAt(e,t,r,s+this.left.length+this.break)}lineAt(e,t,i,s,r){let o=s+this.left.height,l=r+this.left.length+this.break,a=t==G.ByHeight?e<o:e<l,h=a?this.left.lineAt(e,t,i,s,r):this.right.lineAt(e,t,i,o,l);if(this.break||(a?h.to<l:h.from>l))return h;let c=t==G.ByPosNoHeight?G.ByPosNoHeight:G.ByPos;return a?h.join(this.right.lineAt(l,c,i,o,l)):this.left.lineAt(l,c,i,s,r).join(h)}forEachLine(e,t,i,s,r,o){let l=s+this.left.height,a=r+this.left.length+this.break;if(this.break)e<a&&this.left.forEachLine(e,t,i,s,r,o),t>=a&&this.right.forEachLine(e,t,i,l,a,o);else{let h=this.lineAt(a,G.ByPos,i,s,r);e<h.from&&this.left.forEachLine(e,Math.min(t,h.from-1),i,s,r,o),h.to>=e&&h.from<=t&&o(h),t>h.to&&this.right.forEachLine(Math.max(e,h.to+1),t,i,l,a,o)}}replace(e,t,i){let s=this.left.length+this.break;if(t<s)return this.balanced(this.left.replace(e,t,i),this.right);if(e>this.left.length)return this.balanced(this.left,this.right.replace(e-s,t-s,i));let r=[];e>0&&this.decomposeLeft(e,r);let o=r.length;for(let l of i)r.push(l);if(e>0&&fh(r,o-1),t<this.length){let l=r.length;this.decomposeRight(t,r),fh(r,l)}return Be.of(r)}decomposeLeft(e,t){let i=this.left.length;if(e<=i)return this.left.decomposeLeft(e,t);t.push(this.left),this.break&&(i++,e>=i&&t.push(null)),e>i&&this.right.decomposeLeft(e-i,t)}decomposeRight(e,t){let i=this.left.length,s=i+this.break;if(e>=s)return this.right.decomposeRight(e-s,t);e<i&&this.left.decomposeRight(e,t),this.break&&e<s&&t.push(null),t.push(this.right)}balanced(e,t){return e.size>2*t.size||t.size>2*e.size?Be.of(this.break?[e,null,t]:[e,t]):(this.left=ps(this.left,e),this.right=ps(this.right,t),this.setHeight(e.height+t.height),this.outdated=e.outdated||t.outdated,this.size=e.size+t.size,this.length=e.length+this.break+t.length,this)}updateHeight(e,t=0,i=!1,s){let{left:r,right:o}=this,l=t+r.length+this.break,a=null;return s&&s.from<=t+r.length&&s.more?a=r=r.updateHeight(e,t,i,s):r.updateHeight(e,t,i),s&&s.from<=l+o.length&&s.more?a=o=o.updateHeight(e,l,i,s):o.updateHeight(e,l,i),a?this.balanced(r,o):(this.height=this.left.height+this.right.height,this.outdated=!1,this)}toString(){return this.left+(this.break?" ":"-")+this.right}};Ip=5,So=class n{constructor(e,t){this.pos=e,this.oracle=t,this.nodes=[],this.lineStart=-1,this.lineEnd=-1,this.covering=null,this.writtenTo=e}get isCovered(){return this.covering&&this.nodes[this.nodes.length-1]==this.covering}span(e,t){if(this.lineStart>-1){let i=Math.min(t,this.lineEnd),s=this.nodes[this.nodes.length-1];s instanceof We?s.length+=i-this.pos:(i>this.pos||!this.isCovered)&&this.nodes.push(new We(i-this.pos,-1,0)),this.writtenTo=i,t>i&&(this.nodes.push(null),this.writtenTo++,this.lineStart=-1)}this.pos=t}point(e,t,i){if(e<t||i.heightRelevant){let s=i.widget?i.widget.estimatedHeight:0,r=i.widget?i.widget.lineBreaks:0;s<0&&(s=this.oracle.lineHeight);let o=t-e;i.block?this.addBlock(new ms(o,s,i)):(o||r||s>=Ip)&&this.addLineDeco(s,r,o)}else t>e&&this.span(e,t);this.lineEnd>-1&&this.lineEnd<this.pos&&(this.lineEnd=this.oracle.doc.lineAt(this.pos).to)}enterLine(){if(this.lineStart>-1)return;let{from:e,to:t}=this.oracle.doc.lineAt(this.pos);this.lineStart=e,this.lineEnd=t,this.writtenTo<e&&((this.writtenTo<e-1||this.nodes[this.nodes.length-1]==null)&&this.nodes.push(this.blankContent(this.writtenTo,e-1)),this.nodes.push(null)),this.pos>e&&this.nodes.push(new We(this.pos-e,-1,0)),this.writtenTo=this.pos}blankContent(e,t){let i=new xt(t-e);return this.oracle.doc.lineAt(e).to==t&&(i.flags|=4),i}ensureLine(){this.enterLine();let e=this.nodes.length?this.nodes[this.nodes.length-1]:null;if(e instanceof We)return e;let t=new We(0,-1,0);return this.nodes.push(t),t}addBlock(e){this.enterLine();let t=e.deco;t&&t.startSide>0&&!this.isCovered&&this.ensureLine(),this.nodes.push(e),this.writtenTo=this.pos=this.pos+e.length,t&&t.endSide>0&&(this.covering=e)}addLineDeco(e,t,i){let s=this.ensureLine();s.length+=i,s.collapsed+=i,s.widgetHeight=Math.max(s.widgetHeight,e),s.breaks+=t,this.writtenTo=this.pos=this.pos+i}finish(e){let t=this.nodes.length==0?null:this.nodes[this.nodes.length-1];this.lineStart>-1&&!(t instanceof We)&&!this.isCovered?this.nodes.push(new We(0,-1,0)):(this.writtenTo<this.pos||t==null)&&this.nodes.push(this.blankContent(this.writtenTo,this.pos));let i=e;for(let s of this.nodes)s instanceof We&&s.updateHeight(this.oracle,i),i+=s?s.length:1;return this.nodes}static build(e,t,i,s){let r=new n(i,e);return H.spans(t,i,s,r,0),r.finish(i)}};Co=class{constructor(){this.changes=[]}compareRange(){}comparePoint(e,t,i,s){(e<t||i&&i.heightRelevant||s&&s.heightRelevant)&&di(e,t,this.changes,5)}};Xi=class{constructor(e,t,i,s){this.from=e,this.to=t,this.size=i,this.displaySize=s}static same(e,t){if(e.length!=t.length)return!1;for(let i=0;i<e.length;i++){let s=e[i],r=t[i];if(s.from!=r.from||s.to!=r.to||s.size!=r.size)return!1}return!0}draw(e,t){return B.replace({widget:new Ao(this.displaySize*(t?e.scaleY:e.scaleX),t)}).range(this.from,this.to)}},Ao=class extends we{constructor(e,t){super(),this.size=e,this.vertical=t}eq(e){return e.size==this.size&&e.vertical==this.vertical}toDOM(){let e=document.createElement("div");return this.vertical?e.style.height=this.size+"px":(e.style.width=this.size+"px",e.style.height="2px",e.style.display="inline-block"),e}get estimatedHeight(){return this.vertical?this.size:-1}},gs=class{constructor(e,t){this.view=e,this.state=t,this.pixelViewport={left:0,right:window.innerWidth,top:0,bottom:0},this.inView=!0,this.paddingTop=0,this.paddingBottom=0,this.contentDOMWidth=0,this.contentDOMHeight=0,this.editorHeight=0,this.editorWidth=0,this.scaleX=1,this.scaleY=1,this.scrollOffset=0,this.scrolledToBottom=!1,this.scrollAnchorPos=0,this.scrollAnchorHeight=-1,this.scaler=Mo,this.scrollTarget=null,this.printing=!1,this.mustMeasureContent=!0,this.defaultTextDirection=q.LTR,this.visibleRanges=[],this.mustEnforceCursorAssoc=!1;let i=t.facet(Xo).some(s=>typeof s!="function"&&s.class=="cm-lineWrapping");this.heightOracle=new wo(i),this.stateDeco=uh(t),this.heightMap=Be.empty().applyChanges(this.stateDeco,N.empty,this.heightOracle.setDoc(t.doc),[new Ue(0,0,0,t.doc.length)]);for(let s=0;s<2&&(this.viewport=this.getViewport(0,null),!!this.updateForViewport());s++);this.updateViewportLines(),this.lineGaps=this.ensureLineGaps([]),this.lineGapDeco=B.set(this.lineGaps.map(s=>s.draw(this,!1))),this.scrollParent=e.scrollDOM,this.computeVisibleRanges()}updateForViewport(){let e=[this.viewport],{main:t}=this.state.selection;for(let i=0;i<=1;i++){let s=i?t.head:t.anchor;if(!e.some(({from:r,to:o})=>s>=r&&s<=o)){let{from:r,to:o}=this.lineBlockAt(s);e.push(new ci(r,o))}}return this.viewports=e.sort((i,s)=>i.from-s.from),this.updateScaler()}updateScaler(){let e=this.scaler;return this.scaler=this.heightMap.height<=7e6?Mo:To.get(this.heightOracle,this.heightMap,this.viewports),e.eq(this.scaler)?0:2}updateViewportLines(){this.viewportLines=[],this.heightMap.forEachLine(this.viewport.from,this.viewport.to,this.heightOracle.setDoc(this.state.doc),0,0,e=>{this.viewportLines.push(qi(e,this.scaler))})}update(e,t=null){this.state=e.state;let i=this.stateDeco;this.stateDeco=uh(this.state);let s=e.changedRanges,r=Ue.extendWithRanges(s,Np(i,this.stateDeco,e?e.changes:be.empty(this.state.doc.length))),o=this.heightMap.height,l=this.scrolledToBottom?null:this.scrollAnchorAt(this.scrollOffset);ch(),this.heightMap=this.heightMap.applyChanges(this.stateDeco,e.startState.doc,this.heightOracle.setDoc(this.state.doc),r),(this.heightMap.height!=o||ki)&&(e.flags|=2),l?(this.scrollAnchorPos=e.changes.mapPos(l.from,-1),this.scrollAnchorHeight=l.top):(this.scrollAnchorPos=-1,this.scrollAnchorHeight=o);let a=r.length?this.mapViewport(this.viewport,e.changes):this.viewport;(t&&(t.range.head<a.from||t.range.head>a.to)||!this.viewportIsAppropriate(a))&&(a=this.getViewport(0,t));let h=a.from!=this.viewport.from||a.to!=this.viewport.to;this.viewport=a,e.flags|=this.updateForViewport(),(h||!e.changes.empty||e.flags&2)&&this.updateViewportLines(),(this.lineGaps.length||this.viewport.to-this.viewport.from>4e3)&&this.updateLineGaps(this.ensureLineGaps(this.mapLineGaps(this.lineGaps,e.changes))),e.flags|=this.computeVisibleRanges(e.changes),t&&(this.scrollTarget=t),!this.mustEnforceCursorAssoc&&(e.selectionSet||e.focusChanged)&&e.view.lineWrapping&&e.state.selection.main.empty&&e.state.selection.main.assoc&&!e.state.facet(Jh)&&(this.mustEnforceCursorAssoc=!0)}measure(){let{view:e}=this,t=e.contentDOM,i=window.getComputedStyle(t),s=this.heightOracle,r=i.whiteSpace;this.defaultTextDirection=i.direction=="rtl"?q.RTL:q.LTR;let o=this.heightOracle.mustRefreshForWrapping(r)||this.mustMeasureContent==="refresh",l=t.getBoundingClientRect(),a=o||this.mustMeasureContent||this.contentDOMHeight!=l.height;this.contentDOMHeight=l.height,this.mustMeasureContent=!1;let h=0,c=0;if(l.width&&l.height){let{scaleX:w,scaleY:S}=Lh(t,l);(w>.005&&Math.abs(this.scaleX-w)>.005||S>.005&&Math.abs(this.scaleY-S)>.005)&&(this.scaleX=w,this.scaleY=S,h|=16,o=a=!0)}let f=(parseInt(i.paddingTop)||0)*this.scaleY,u=(parseInt(i.paddingBottom)||0)*this.scaleY;(this.paddingTop!=f||this.paddingBottom!=u)&&(this.paddingTop=f,this.paddingBottom=u,h|=18),this.editorWidth!=e.scrollDOM.clientWidth&&(s.lineWrapping&&(a=!0),this.editorWidth=e.scrollDOM.clientWidth,h|=16);let d=Eh(this.view.contentDOM,!1).y;d!=this.scrollParent&&(this.scrollParent=d,this.scrollAnchorHeight=-1,this.scrollOffset=0);let p=this.getScrollOffset();this.scrollOffset!=p&&(this.scrollAnchorHeight=-1,this.scrollOffset=p),this.scrolledToBottom=Nh(this.scrollParent||e.win);let m=(this.printing?Wp:Fp)(t,this.paddingTop),g=m.top-this.pixelViewport.top,y=m.bottom-this.pixelViewport.bottom;this.pixelViewport=m;let k=this.pixelViewport.bottom>this.pixelViewport.top&&this.pixelViewport.right>this.pixelViewport.left;if(k!=this.inView&&(this.inView=k,k&&(a=!0)),!this.inView&&!this.scrollTarget&&!Hp(e.dom))return 0;let x=l.width;if((this.contentDOMWidth!=x||this.editorHeight!=e.scrollDOM.clientHeight)&&(this.contentDOMWidth=l.width,this.editorHeight=e.scrollDOM.clientHeight,h|=16),a){let w=e.docView.measureVisibleLineHeights(this.viewport);if(s.mustRefreshForHeights(w)&&(o=!0),o||s.lineWrapping&&Math.abs(x-this.contentDOMWidth)>s.charWidth){let{lineHeight:S,charWidth:C,textHeight:R}=e.docView.measureTextSize();o=S>0&&s.refresh(r,S,C,R,Math.max(5,x/C),w),o&&(e.docView.minWidth=0,h|=16)}g>0&&y>0?c=Math.max(g,y):g<0&&y<0&&(c=Math.min(g,y)),ch();for(let S of this.viewports){let C=S.from==this.viewport.from?w:e.docView.measureVisibleLineHeights(S);this.heightMap=(o?Be.empty().applyChanges(this.stateDeco,N.empty,this.heightOracle,[new Ue(0,0,0,e.state.doc.length)]):this.heightMap).updateHeight(s,0,o,new ko(S.from,C))}ki&&(h|=2)}let O=!this.viewportIsAppropriate(this.viewport,c)||this.scrollTarget&&(this.scrollTarget.range.head<this.viewport.from||this.scrollTarget.range.head>this.viewport.to);return O&&(h&2&&(h|=this.updateScaler()),this.viewport=this.getViewport(c,this.scrollTarget),h|=this.updateForViewport()),(h&2||O)&&this.updateViewportLines(),(this.lineGaps.length||this.viewport.to-this.viewport.from>4e3)&&this.updateLineGaps(this.ensureLineGaps(o?[]:this.lineGaps,e)),h|=this.computeVisibleRanges(),this.mustEnforceCursorAssoc&&(this.mustEnforceCursorAssoc=!1,e.docView.enforceCursorAssoc()),h}get visibleTop(){return this.scaler.fromDOM(this.pixelViewport.top)}get visibleBottom(){return this.scaler.fromDOM(this.pixelViewport.bottom)}getViewport(e,t){let i=.5-Math.max(-.5,Math.min(.5,e/1e3/2)),s=this.heightMap,r=this.heightOracle,{visibleTop:o,visibleBottom:l}=this,a=new ci(s.lineAt(o-i*1e3,G.ByHeight,r,0,0).from,s.lineAt(l+(1-i)*1e3,G.ByHeight,r,0,0).to);if(t){let{head:h}=t.range;if(h<a.from||h>a.to){let c=Math.min(this.editorHeight,this.pixelViewport.bottom-this.pixelViewport.top),f=s.lineAt(h,G.ByPos,r,0,0),u;t.y=="center"?u=(f.top+f.bottom)/2-c/2:t.y=="start"||t.y=="nearest"&&h<a.from?u=f.top:u=f.bottom-c,a=new ci(s.lineAt(u-1e3/2,G.ByHeight,r,0,0).from,s.lineAt(u+c+1e3/2,G.ByHeight,r,0,0).to)}}return a}mapViewport(e,t){let i=t.mapPos(e.from,-1),s=t.mapPos(e.to,1);return new ci(this.heightMap.lineAt(i,G.ByPos,this.heightOracle,0,0).from,this.heightMap.lineAt(s,G.ByPos,this.heightOracle,0,0).to)}viewportIsAppropriate({from:e,to:t},i=0){if(!this.inView)return!0;let{top:s}=this.heightMap.lineAt(e,G.ByPos,this.heightOracle,0,0),{bottom:r}=this.heightMap.lineAt(t,G.ByPos,this.heightOracle,0,0),{visibleTop:o,visibleBottom:l}=this;return(e==0||s<=o-Math.max(10,Math.min(-i,250)))&&(t==this.state.doc.length||r>=l+Math.max(10,Math.min(i,250)))&&s>o-2*1e3&&r<l+2*1e3}mapLineGaps(e,t){if(!e.length||t.empty)return e;let i=[];for(let s of e)t.touchesRange(s.from,s.to)||i.push(new Xi(t.mapPos(s.from),t.mapPos(s.to),s.size,s.displaySize));return i}ensureLineGaps(e,t){let i=this.heightOracle.lineWrapping,s=i?1e4:2e3,r=s>>1,o=s<<1;if(this.defaultTextDirection!=q.LTR&&!i)return[];let l=[],a=(c,f,u,d)=>{if(f-c<r)return;let p=this.state.selection.main,m=[p.from];p.empty||m.push(p.to);for(let y of m)if(y>c&&y<f){a(c,y-10,u,d),a(y+10,f,u,d);return}let g=zp(e,y=>y.from>=u.from&&y.to<=u.to&&Math.abs(y.from-c)<r&&Math.abs(y.to-f)<r&&!m.some(k=>y.from<k&&y.to>k));if(!g){if(f<u.to&&t&&i&&t.visibleRanges.some(x=>x.from<=f&&x.to>=f)){let x=t.moveToLineBoundary(b.cursor(f),!1,!0).head;x>c&&(f=x)}let y=this.gapSize(u,c,f,d),k=i||y<2e6?y:2e6;g=new Xi(c,f,y,k)}l.push(g)},h=c=>{if(c.length<o||c.type!=ce.Text)return;let f=Vp(c.from,c.to,this.stateDeco);if(f.total<o)return;let u=this.scrollTarget?this.scrollTarget.range.head:null,d,p;if(i){let m=s/this.heightOracle.lineLength*this.heightOracle.lineHeight,g,y;if(u!=null){let k=Yn(f,u),x=((this.visibleBottom-this.visibleTop)/2+m)/c.height;g=k-x,y=k+x}else g=(this.visibleTop-c.top-m)/c.height,y=(this.visibleBottom-c.top+m)/c.height;d=_n(f,g),p=_n(f,y)}else{let m=f.total*this.heightOracle.charWidth,g=s*this.heightOracle.charWidth,y=0;if(m>2e6)for(let S of e)S.from>=c.from&&S.from<c.to&&S.size!=S.displaySize&&S.from*this.heightOracle.charWidth+y<this.pixelViewport.left&&(y=S.size-S.displaySize);let k=this.pixelViewport.left+y,x=this.pixelViewport.right+y,O,w;if(u!=null){let S=Yn(f,u),C=((x-k)/2+g)/m;O=S-C,w=S+C}else O=(k-g)/m,w=(x+g)/m;d=_n(f,O),p=_n(f,w)}d>c.from&&a(c.from,d,c,f),p<c.to&&a(p,c.to,c,f)};for(let c of this.viewportLines)Array.isArray(c.type)?c.type.forEach(h):h(c);return l}gapSize(e,t,i,s){let r=Yn(s,i)-Yn(s,t);return this.heightOracle.lineWrapping?e.height*r:s.total*this.heightOracle.charWidth*r}updateLineGaps(e){Xi.same(e,this.lineGaps)||(this.lineGaps=e,this.lineGapDeco=B.set(e.map(t=>t.draw(this,this.heightOracle.lineWrapping))))}computeVisibleRanges(e){let t=this.stateDeco;this.lineGaps.length&&(t=t.concat(this.lineGapDeco));let i=[];H.spans(t,this.viewport.from,this.viewport.to,{span(r,o){i.push({from:r,to:o})},point(){}},20);let s=0;if(i.length!=this.visibleRanges.length)s=12;else for(let r=0;r<i.length&&!(s&8);r++){let o=this.visibleRanges[r],l=i[r];(o.from!=l.from||o.to!=l.to)&&(s|=4,e&&e.mapPos(o.from,-1)==l.from&&e.mapPos(o.to,1)==l.to||(s|=8))}return this.visibleRanges=i,s}lineBlockAt(e){return e>=this.viewport.from&&e<=this.viewport.to&&this.viewportLines.find(t=>t.from<=e&&t.to>=e)||qi(this.heightMap.lineAt(e,G.ByPos,this.heightOracle,0,0),this.scaler)}lineBlockAtHeight(e){return e>=this.viewportLines[0].top&&e<=this.viewportLines[this.viewportLines.length-1].bottom&&this.viewportLines.find(t=>t.top<=e&&t.bottom>=e)||qi(this.heightMap.lineAt(this.scaler.fromDOM(e),G.ByHeight,this.heightOracle,0,0),this.scaler)}getScrollOffset(){return this.scrollParent==this.view.scrollDOM?this.scrollParent.scrollTop*this.scaleY:(this.scrollParent?this.scrollParent.getBoundingClientRect().top:0)-this.view.contentDOM.getBoundingClientRect().top}scrollAnchorAt(e){let t=this.lineBlockAtHeight(e+12-this.paddingTop);return t.from>=this.viewport.from||this.viewportLines[0].top-e>200?t:this.viewportLines[0]}elementAtHeight(e){return qi(this.heightMap.blockAt(this.scaler.fromDOM(e),this.heightOracle,0,0),this.scaler)}get docHeight(){return this.scaler.toDOM(this.heightMap.height)}get contentHeight(){return this.docHeight+this.paddingTop+this.paddingBottom}},ci=class{constructor(e,t){this.from=e,this.to=t}};Mo={toDOM(n){return n},fromDOM(n){return n},scale:1,eq(n){return n==this}};To=class n{constructor(e,t){this.scale=e,this.viewports=t}static get(e,t,i){let s=0,r=0,o=0,l=i.map(({from:h,to:c})=>{let f=t.lineAt(h,G.ByPos,e,0,0).top,u=t.lineAt(c,G.ByPos,e,0,0).bottom;return s+=u-f,{from:h,to:c,top:f,bottom:u,domTop:0,domBottom:0}});if(t.height-s<10)return Mo;let a=(7e6-s)/(t.height-s);for(let h of l)h.domTop=o+(h.top-r)*a,o=h.domBottom=h.domTop+(h.bottom-h.top),r=h.bottom;return new n(a,l)}toDOM(e){for(let t=0,i=0,s=0;;t++){let r=t<this.viewports.length?this.viewports[t]:null;if(!r||e<r.top)return s+(e-i)*this.scale;if(e<=r.bottom)return r.domTop+(e-r.top);i=r.bottom,s=r.domBottom}}fromDOM(e){for(let t=0,i=0,s=0;;t++){let r=t<this.viewports.length?this.viewports[t]:null;if(!r||e<r.domTop)return i+(e-s)/this.scale;if(e<=r.domBottom)return r.top+(e-r.domTop);i=r.bottom,s=r.domBottom}}eq(e){return e instanceof n?this.scale==e.scale&&this.viewports.length==e.viewports.length&&this.viewports.every((t,i)=>t.from==e.viewports[i].from&&t.to==e.viewports[i].to):!1}};Xn=A.define({combine:n=>n.join(" ")}),Do=A.define({combine:n=>n.indexOf(!0)>-1}),Oo=He.newName(),xc=He.newName(),wc=He.newName(),kc={"&light":"."+xc,"&dark":"."+wc};qp=Bo("."+Oo,{"&":{position:"relative !important",boxSizing:"border-box","&.cm-focused":{outline:"1px dotted #212121"},display:"flex !important",flexDirection:"column"},".cm-scroller":{display:"flex !important",alignItems:"flex-start !important",fontFamily:"monospace",lineHeight:1.4,height:"100%",overflowX:"auto",position:"relative",zIndex:0,overflowAnchor:"none"},".cm-content":{margin:0,flexGrow:2,flexShrink:0,display:"block",whiteSpace:"pre",wordWrap:"normal",boxSizing:"border-box",minHeight:"100%",padding:"4px 0",outline:"none","&[contenteditable=true]":{WebkitUserModify:"read-write-plaintext-only"}},".cm-lineWrapping":{whiteSpace_fallback:"pre-wrap",whiteSpace:"break-spaces",wordBreak:"break-word",overflowWrap:"anywhere",flexShrink:1},"&light .cm-content":{caretColor:"black"},"&dark .cm-content":{caretColor:"white"},".cm-line":{display:"block",padding:"0 2px 0 6px"},".cm-layer":{userSelect:"none",position:"absolute",left:0,top:0,contain:"size style","& > *":{position:"absolute"}},"&light .cm-selectionBackground":{background:"#d9d9d9"},"&dark .cm-selectionBackground":{background:"#222"},"&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":{background:"#d7d4f0"},"&dark.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":{background:"#233"},".cm-cursorLayer":{pointerEvents:"none"},"&.cm-focused > .cm-scroller > .cm-cursorLayer":{animation:"steps(1) cm-blink 1.2s infinite"},"@keyframes cm-blink":{"0%":{},"50%":{opacity:0},"100%":{}},"@keyframes cm-blink2":{"0%":{},"50%":{opacity:0},"100%":{}},".cm-cursor, .cm-dropCursor":{borderLeft:"1.2px solid black",marginLeft:"-0.6px",pointerEvents:"none"},".cm-cursor":{display:"none"},"&dark .cm-cursor":{borderLeftColor:"#ddd"},".cm-selectionHandle":{backgroundColor:"currentColor",width:"1.5px"},".cm-selectionHandle-start::before, .cm-selectionHandle-end::before":{content:'""',backgroundColor:"inherit",borderRadius:"50%",width:"8px",height:"8px",position:"absolute",left:"-3.25px"},".cm-selectionHandle-start::before":{top:"-8px"},".cm-selectionHandle-end::before":{bottom:"-8px"},".cm-dropCursor":{position:"absolute"},"&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-cursor":{display:"block"},".cm-iso":{unicodeBidi:"isolate"},".cm-announced":{position:"fixed",top:"-10000px"},"@media print":{".cm-announced":{display:"none"}},"&light .cm-activeLine":{backgroundColor:"#cceeff44"},"&dark .cm-activeLine":{backgroundColor:"#99eeff33"},"&light .cm-specialChar":{color:"red"},"&dark .cm-specialChar":{color:"#f78"},".cm-gutters":{flexShrink:0,display:"flex",height:"100%",boxSizing:"border-box",zIndex:200},".cm-gutters-before":{insetInlineStart:0},".cm-gutters-after":{insetInlineEnd:0},"&light .cm-gutters":{backgroundColor:"#f5f5f5",color:"#6c6c6c",border:"0px solid #ddd","&.cm-gutters-before":{borderRightWidth:"1px"},"&.cm-gutters-after":{borderLeftWidth:"1px"}},"&dark .cm-gutters":{backgroundColor:"#333338",color:"#ccc"},".cm-gutter":{display:"flex !important",flexDirection:"column",flexShrink:0,boxSizing:"border-box",minHeight:"100%",overflow:"hidden"},".cm-gutterElement":{boxSizing:"border-box"},".cm-lineNumbers .cm-gutterElement":{padding:"0 3px 0 5px",minWidth:"20px",textAlign:"right",whiteSpace:"nowrap"},"&light .cm-activeLineGutter":{backgroundColor:"#e2f2ff"},"&dark .cm-activeLineGutter":{backgroundColor:"#222227"},".cm-panels":{boxSizing:"border-box",position:"sticky",left:0,right:0,zIndex:300},"&light .cm-panels":{backgroundColor:"#f5f5f5",color:"black"},".cm-panels-top":{top:"0"},".cm-panels-bottom":{bottom:"0"},"&light .cm-panels-top":{borderBottom:"1px solid #ddd"},"&light .cm-panels-bottom":{borderTop:"1px solid #ddd"},"&dark .cm-panels":{backgroundColor:"#333338",color:"white"},".cm-dialog":{padding:"2px 19px 4px 6px",position:"relative","& label":{fontSize:"80%"}},".cm-dialog-close":{position:"absolute",top:"3px",right:"4px",backgroundColor:"inherit",border:"none",font:"inherit",fontSize:"14px",padding:"0"},".cm-tab":{display:"inline-block",overflow:"hidden",verticalAlign:"bottom"},".cm-widgetBuffer":{verticalAlign:"baseline",height:"1em",width:0,display:"inline"},".cm-placeholder":{color:"#888",display:"inline-block",verticalAlign:"top",userSelect:"none"},".cm-highlightSpace":{background:"radial-gradient(circle at 50% 55%, #aaa 20%, transparent 0) no-repeat",backgroundSize:".4em",backgroundPosition:"calc(min(50%, 0px)) center"},".cm-highlightTab":{backgroundImage:`url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="20"><path stroke="%23888" stroke-width="1" fill="none" d="M1 10H196L190 5M190 15L196 10M197 4L197 16"/></svg>')`,backgroundSize:"auto 100%",backgroundPosition:"right 90%",backgroundRepeat:"no-repeat"},".cm-trailingSpace":{backgroundColor:"#ff332255"},".cm-button":{verticalAlign:"middle",color:"inherit",fontSize:"70%",padding:".2em 1em",borderRadius:"1px"},"&light .cm-button":{backgroundImage:"linear-gradient(#eff1f5, #d9d9df)",border:"1px solid #888","&:active":{backgroundImage:"linear-gradient(#b4b4b4, #d0d3d6)"}},"&dark .cm-button":{backgroundImage:"linear-gradient(#393939, #111)",border:"1px solid #888","&:active":{backgroundImage:"linear-gradient(#111, #333)"}},".cm-textfield":{verticalAlign:"middle",color:"inherit",fontSize:"70%",border:"1px solid silver",padding:".2em .5em"},"&light .cm-textfield":{backgroundColor:"white"},"&dark .cm-textfield":{border:"1px solid #555",backgroundColor:"inherit"}},kc),Kp={childList:!0,characterData:!0,subtree:!0,attributes:!0,characterDataOldValue:!0},qr=D.ie&&D.ie_version<=11,Lo=class{constructor(e){this.view=e,this.active=!1,this.editContext=null,this.selectionRange=new Jr,this.selectionChanged=!1,this.delayedFlush=-1,this.resizeTimeout=-1,this.queue=[],this.delayedAndroidKey=null,this.flushingAndroidKey=-1,this.lastChange=0,this.scrollTargets=[],this.intersection=null,this.resizeScroll=null,this.intersecting=!1,this.gapIntersection=null,this.gaps=[],this.printQuery=null,this.parentCheck=-1,this.dom=e.contentDOM,this.observer=new MutationObserver(t=>{for(let i of t)this.queue.push(i);(D.ie&&D.ie_version<=11||D.ios&&e.composing)&&t.some(i=>i.type=="childList"&&i.removedNodes.length||i.type=="characterData"&&i.oldValue.length>i.target.nodeValue.length)?this.flushSoon():this.flush()}),window.EditContext&&D.android&&e.constructor.EDIT_CONTEXT!==!1&&!(D.chrome&&D.chrome_version<126)&&(this.editContext=new Eo(e),e.state.facet(dt)&&(e.contentDOM.editContext=this.editContext.editContext)),qr&&(this.onCharData=t=>{this.queue.push({target:t.target,type:"characterData",oldValue:t.prevValue}),this.flushSoon()}),this.onSelectionChange=this.onSelectionChange.bind(this),this.onResize=this.onResize.bind(this),this.onPrint=this.onPrint.bind(this),this.onScroll=this.onScroll.bind(this),window.matchMedia&&(this.printQuery=window.matchMedia("print")),typeof ResizeObserver=="function"&&(this.resizeScroll=new ResizeObserver(()=>{var t;((t=this.view.docView)===null||t===void 0?void 0:t.lastUpdate)<Date.now()-75&&this.onResize()}),this.resizeScroll.observe(e.scrollDOM)),this.addWindowListeners(this.win=e.win),this.start(),typeof IntersectionObserver=="function"&&(this.intersection=new IntersectionObserver(t=>{this.parentCheck<0&&(this.parentCheck=setTimeout(this.listenForScroll.bind(this),1e3)),t.length>0&&t[t.length-1].intersectionRatio>0!=this.intersecting&&(this.intersecting=!this.intersecting,this.intersecting!=this.view.inView&&this.onScrollChanged(document.createEvent("Event")))},{threshold:[0,.001]}),this.intersection.observe(this.dom),this.gapIntersection=new IntersectionObserver(t=>{t.length>0&&t[t.length-1].intersectionRatio>0&&this.onScrollChanged(document.createEvent("Event"))},{})),this.listenForScroll(),this.readSelectionRange()}onScrollChanged(e){this.view.inputState.runHandlers("scroll",e),this.intersecting&&this.view.measure()}onScroll(e){this.intersecting&&this.flush(this.pendingRecords().length>0),this.editContext&&this.view.requestMeasure(this.editContext.measureReq),this.onScrollChanged(e)}onResize(){this.resizeTimeout<0&&(this.resizeTimeout=setTimeout(()=>{this.resizeTimeout=-1,this.view.requestMeasure()},50))}onPrint(e){(e.type=="change"||!e.type)&&!e.matches||(this.view.viewState.printing=!0,this.view.measure(),setTimeout(()=>{this.view.viewState.printing=!1,this.view.requestMeasure()},500))}updateGaps(e){if(this.gapIntersection&&(e.length!=this.gaps.length||this.gaps.some((t,i)=>t!=e[i]))){this.gapIntersection.disconnect();for(let t of e)this.gapIntersection.observe(t);this.gaps=e}}onSelectionChange(e){let t=this.selectionChanged;if(!this.readSelectionRange()||this.delayedAndroidKey)return;let{view:i}=this,s=this.selectionRange;if(i.state.facet(dt)?i.root.activeElement!=this.dom:!$i(this.dom,s))return;let r=s.anchorNode&&i.docView.tile.nearest(s.anchorNode);if(r&&r.isWidget()&&r.widget.ignoreEvent(e)){t||(this.selectionChanged=!1);return}(D.ie&&D.ie_version<=11||D.android&&D.chrome)&&!i.state.selection.main.empty&&s.focusNode&&ji(s.focusNode,s.focusOffset,s.anchorNode,s.anchorOffset)?this.flushSoon():this.flush(!1)}readSelectionRange(){let{view:e}=this,t=tn(e.root);if(!t)return!1;let i=D.safari&&e.root.nodeType==11&&e.root.activeElement==this.dom&&$p(this.view,t)||t;if(!i||this.selectionRange.eq(i))return!1;let s=$i(this.dom,i);return s&&!this.selectionChanged&&e.inputState.lastFocusTime>Date.now()-200&&e.inputState.lastTouchTime<Date.now()-300&&Hd(this.dom,i)?(this.view.inputState.lastFocusTime=0,e.docView.updateSelection(),!1):(this.selectionRange.setRange(i),s&&(this.selectionChanged=!0),!0)}setSelectionRange(e,t){this.selectionRange.set(e.node,e.offset,t.node,t.offset),this.selectionChanged=!1}clearSelectionRange(){this.selectionRange.set(null,0,null,0)}listenForScroll(){this.parentCheck=-1;let e=0,t=null;for(let i=this.dom;i;)if(se(i))!t&&e<this.scrollTargets.length&&this.scrollTargets[e]==i?e++:t||(t=this.scrollTargets.slice(0,e)),t&&t.push(i),i=i.assignedSlot||i.parentNode;else if(i.nodeType==11)i=i.host;else break;if(e<this.scrollTargets.length&&!t&&(t=this.scrollTargets.slice(0,e)),t){for(let i of this.scrollTargets)i.removeEventListener("scroll",this.onScroll);for(let i of this.scrollTargets=t)i.addEventListener("scroll",this.onScroll)}}ignore(e){if(!this.active)return e();try{return this.stop(),e()}finally{this.start(),this.clear()}}start(){this.active||(this.observer.observe(this.dom,Kp),qr&&this.dom.addEventListener("DOMCharacterDataModified",this.onCharData),this.active=!0)}stop(){this.active&&(this.active=!1,this.observer.disconnect(),qr&&this.dom.removeEventListener("DOMCharacterDataModified",this.onCharData))}clear(){this.processRecords(),this.queue.length=0,this.selectionChanged=!1}delayAndroidKey(e,t){var i;if(!this.delayedAndroidKey){let s=()=>{let r=this.delayedAndroidKey;r&&(this.clearDelayedAndroidKey(),this.view.inputState.lastKeyCode=r.keyCode,this.view.inputState.lastKeyTime=Date.now(),!this.flush()&&r.force&&pi(this.dom,r.key,r.keyCode))};this.flushingAndroidKey=this.view.win.requestAnimationFrame(s)}(!this.delayedAndroidKey||e=="Enter")&&(this.delayedAndroidKey={key:e,keyCode:t,force:this.lastChange<Date.now()-50||!!(!((i=this.delayedAndroidKey)===null||i===void 0)&&i.force)})}clearDelayedAndroidKey(){this.win.cancelAnimationFrame(this.flushingAndroidKey),this.delayedAndroidKey=null,this.flushingAndroidKey=-1}flushSoon(){this.delayedFlush<0&&(this.delayedFlush=this.view.win.requestAnimationFrame(()=>{this.delayedFlush=-1,this.flush()}))}forceFlush(){this.delayedFlush>=0&&(this.view.win.cancelAnimationFrame(this.delayedFlush),this.delayedFlush=-1),this.flush()}pendingRecords(){for(let e of this.observer.takeRecords())this.queue.push(e);return this.queue}processRecords(){let e=this.pendingRecords();e.length&&(this.queue=[]);let t=-1,i=-1,s=!1;for(let r of e){let o=this.readMutation(r);o&&(o.typeOver&&(s=!0),t==-1?{from:t,to:i}=o:(t=Math.min(o.from,t),i=Math.max(o.to,i)))}return{from:t,to:i,typeOver:s}}readChange(){let{from:e,to:t,typeOver:i}=this.processRecords(),s=this.selectionChanged&&$i(this.dom,this.selectionRange);if(e<0&&!s)return null;e>-1&&(this.lastChange=Date.now()),this.view.inputState.lastFocusTime=0,this.selectionChanged=!1;let r=new mo(this.view,e,t,i);return this.view.docView.domChanged={newSel:r.newSel?r.newSel.main:null},r}flush(e=!0){if(this.delayedFlush>=0||this.delayedAndroidKey)return!1;e&&this.readSelectionRange();let t=this.selectionChanged,i=this.readChange();if(!i)return this.view.requestMeasure(),!1;let s=this.view.state,r=hc(this.view,i);return this.view.state==s&&(i.domChanged||t)&&this.view.update([]),r}readMutation(e){let t=this.view.docView.tile.nearest(e.target);if(!t||t.isWidget())return null;if(t.markDirty(e.type=="attributes"),e.type=="childList"){let i=dh(t,e.previousSibling||e.target.previousSibling,-1),s=dh(t,e.nextSibling||e.target.nextSibling,1);return{from:i?t.posAfter(i):t.posAtStart,to:s?t.posBefore(s):t.posAtEnd,typeOver:!1}}else return e.type=="characterData"?{from:t.posAtStart,to:t.posAtEnd,typeOver:e.target.nodeValue==e.oldValue}:null}setWindow(e){e!=this.win&&(this.removeWindowListeners(this.win),this.win=e,this.addWindowListeners(this.win))}addWindowListeners(e){e.addEventListener("resize",this.onResize),this.printQuery?this.printQuery.addEventListener?this.printQuery.addEventListener("change",this.onPrint):this.printQuery.addListener(this.onPrint):e.addEventListener("beforeprint",this.onPrint),e.addEventListener("scroll",this.onScroll),e.document.addEventListener("selectionchange",this.onSelectionChange)}removeWindowListeners(e){e.removeEventListener("scroll",this.onScroll),e.removeEventListener("resize",this.onResize),this.printQuery?this.printQuery.removeEventListener?this.printQuery.removeEventListener("change",this.onPrint):this.printQuery.removeListener(this.onPrint):e.removeEventListener("beforeprint",this.onPrint),e.document.removeEventListener("selectionchange",this.onSelectionChange)}update(e){this.editContext&&(this.editContext.update(e),e.startState.facet(dt)!=e.state.facet(dt)&&(e.view.contentDOM.editContext=e.state.facet(dt)?this.editContext.editContext:null))}destroy(){var e,t,i;this.stop(),(e=this.intersection)===null||e===void 0||e.disconnect(),(t=this.gapIntersection)===null||t===void 0||t.disconnect(),(i=this.resizeScroll)===null||i===void 0||i.disconnect();for(let s of this.scrollTargets)s.removeEventListener("scroll",this.onScroll);this.removeWindowListeners(this.win),clearTimeout(this.parentCheck),clearTimeout(this.resizeTimeout),this.win.cancelAnimationFrame(this.delayedFlush),this.win.cancelAnimationFrame(this.flushingAndroidKey),this.editContext&&(this.view.contentDOM.editContext=null,this.editContext.destroy())}};Eo=class{constructor(e){this.from=0,this.to=0,this.pendingContextChange=null,this.handlers=Object.create(null),this.composing=null,this.resetRange(e.state);let t=this.editContext=new window.EditContext({text:e.state.doc.sliceString(this.from,this.to),selectionStart:this.toContextPos(Math.max(this.from,Math.min(this.to,e.state.selection.main.anchor))),selectionEnd:this.toContextPos(e.state.selection.main.head)});this.handlers.textupdate=i=>{let s=e.state.selection.main,{anchor:r,head:o}=s,l=this.toEditorPos(i.updateRangeStart),a=this.toEditorPos(i.updateRangeEnd);e.inputState.composing>=0&&!this.composing&&(this.composing={contextBase:i.updateRangeStart,editorBase:l,drifted:!1});let h=a-l>i.text.length;l==this.from&&r<this.from?l=r:a==this.to&&r>this.to&&(a=r);let c=cc(e.state.sliceDoc(l,a),i.text,(h?s.from:s.to)-l,h?"end":null);if(!c){let u=b.single(this.toEditorPos(i.selectionStart),this.toEditorPos(i.selectionEnd));go(u,s)||e.dispatch({selection:u,userEvent:"select"});return}let f={from:c.from+l,to:c.toA+l,insert:N.of(i.text.slice(c.from,c.toB).split(`
`))};if((D.mac||D.android)&&f.from==o-1&&/^\. ?$/.test(i.text)&&e.contentDOM.getAttribute("autocorrect")=="off"&&(f={from:l,to:a,insert:N.of([i.text.replace("."," ")])}),this.pendingContextChange=f,!e.state.readOnly){let u=this.to-this.from+(f.to-f.from+f.insert.length);Zo(e,f,b.single(this.toEditorPos(i.selectionStart,u),this.toEditorPos(i.selectionEnd,u)))}this.pendingContextChange&&(this.revertPending(e.state),this.setSelection(e.state)),f.from<f.to&&!f.insert.length&&e.inputState.composing>=0&&!/[\\p{Alphabetic}\\p{Number}_]/.test(t.text.slice(Math.max(0,i.updateRangeStart-1),Math.min(t.text.length,i.updateRangeStart+1)))&&this.handlers.compositionend(i)},this.handlers.characterboundsupdate=i=>{let s=[],r=null;for(let o=this.toEditorPos(i.rangeStart),l=this.toEditorPos(i.rangeEnd);o<l;o++){let a=e.coordsForChar(o);r=a&&new DOMRect(a.left,a.top,a.right-a.left,a.bottom-a.top)||r||new DOMRect,s.push(r)}t.updateCharacterBounds(i.rangeStart,s)},this.handlers.textformatupdate=i=>{let s=[];for(let r of i.getTextFormats()){let o=r.underlineStyle,l=r.underlineThickness;if(!/none/i.test(o)&&!/none/i.test(l)){let a=this.toEditorPos(r.rangeStart),h=this.toEditorPos(r.rangeEnd);if(a<h){let c=`text-decoration: underline ${/^[a-z]/.test(o)?o+" ":o=="Dashed"?"dashed ":o=="Squiggle"?"wavy ":""}${/thin/i.test(l)?1:2}px`;s.push(B.mark({attributes:{style:c}}).range(a,h))}}}e.dispatch({effects:Zh.of(B.set(s))})},this.handlers.compositionstart=()=>{e.inputState.composing<0&&(e.inputState.composing=0,e.inputState.compositionFirstChange=!0)},this.handlers.compositionend=()=>{if(e.inputState.composing=-1,e.inputState.compositionFirstChange=null,this.composing){let{drifted:i}=this.composing;this.composing=null,i&&this.reset(e.state)}};for(let i in this.handlers)t.addEventListener(i,this.handlers[i]);this.measureReq={read:i=>{let s=tn(i.root);s&&s.rangeCount&&this.editContext.updateSelectionBounds(s.getRangeAt(0).getBoundingClientRect())}}}applyEdits(e){let t=0,i=!1,s=this.pendingContextChange;return e.changes.iterChanges((r,o,l,a,h)=>{if(i)return;let c=h.length-(o-r);if(s&&o>=s.to)if(s.from==r&&s.to==o&&s.insert.eq(h)){s=this.pendingContextChange=null,t+=c,this.to+=c;return}else s=null,this.revertPending(e.state);if(r+=t,o+=t,o<=this.from)this.from+=c,this.to+=c;else if(r<this.to){if(r<this.from||o>this.to||this.to-this.from+h.length>3e4){i=!0;return}this.editContext.updateText(this.toContextPos(r),this.toContextPos(o),h.toString()),this.to+=c}t+=c}),s&&!i&&this.revertPending(e.state),!i}update(e){let t=this.pendingContextChange,i=e.startState.selection.main;this.composing&&(this.composing.drifted||!e.changes.touchesRange(i.from,i.to)&&e.transactions.some(s=>!s.isUserEvent("input.type")&&s.changes.touchesRange(this.from,this.to)))?(this.composing.drifted=!0,this.composing.editorBase=e.changes.mapPos(this.composing.editorBase)):!this.applyEdits(e)||!this.rangeIsValid(e.state)?(this.pendingContextChange=null,this.reset(e.state)):(e.docChanged||e.selectionSet||t)&&this.setSelection(e.state),(e.geometryChanged||e.docChanged||e.selectionSet)&&e.view.requestMeasure(this.measureReq)}resetRange(e){let{head:t}=e.selection.main;this.from=Math.max(0,t-1e4),this.to=Math.min(e.doc.length,t+1e4)}reset(e){this.resetRange(e),this.editContext.updateText(0,this.editContext.text.length,e.doc.sliceString(this.from,this.to)),this.setSelection(e)}revertPending(e){let t=this.pendingContextChange;this.pendingContextChange=null,this.editContext.updateText(this.toContextPos(t.from),this.toContextPos(t.from+t.insert.length),e.doc.sliceString(t.from,t.to))}setSelection(e){let{main:t}=e.selection,i=this.toContextPos(Math.max(this.from,Math.min(this.to,t.anchor))),s=this.toContextPos(t.head);(this.editContext.selectionStart!=i||this.editContext.selectionEnd!=s)&&this.editContext.updateSelection(i,s)}rangeIsValid(e){let{head:t}=e.selection.main;return!(this.from>0&&t-this.from<500||this.to<e.doc.length&&this.to-t<500||this.to-this.from>1e4*3)}toEditorPos(e,t=this.to-this.from){e=Math.min(e,t);let i=this.composing;return i&&i.drifted?i.editorBase+(e-i.contextBase):e+this.from}toContextPos(e){let t=this.composing;return t&&t.drifted?t.contextBase+(e-t.editorBase):e-this.from}destroy(){for(let e in this.handlers)this.editContext.removeEventListener(e,this.handlers[e])}},M=class n{get state(){return this.viewState.state}get viewport(){return this.viewState.viewport}get visibleRanges(){return this.viewState.visibleRanges}get inView(){return this.viewState.inView}get composing(){return!!this.inputState&&this.inputState.composing>0}get compositionStarted(){return!!this.inputState&&this.inputState.composing>=0}get root(){return this._root}get win(){return this.dom.ownerDocument.defaultView||window}constructor(e={}){var t;this.plugins=[],this.pluginMap=new Map,this.editorAttrs={},this.contentAttrs={},this.bidiCache=[],this.destroyed=!1,this.updateState=2,this.measureScheduled=-1,this.measureRequests=[],this.clearAnnouncement=-1,this.contentDOM=document.createElement("div"),this.scrollDOM=document.createElement("div"),this.scrollDOM.tabIndex=-1,this.scrollDOM.className="cm-scroller",this.scrollDOM.appendChild(this.contentDOM),this.announceDOM=document.createElement("div"),this.announceDOM.className="cm-announced",this.announceDOM.setAttribute("aria-live","polite"),this.dom=document.createElement("div"),this.dom.appendChild(this.announceDOM),this.dom.appendChild(this.scrollDOM),e.parent&&e.parent.appendChild(this.dom);let{dispatch:i}=e;this.dispatchTransactions=e.dispatchTransactions||i&&(s=>s.forEach(r=>i(r,this)))||(s=>this.update(s)),this.dispatch=this.dispatch.bind(this),this._root=e.root||Fd(e.parent)||document,this.viewState=new gs(this,e.state||W.create(e)),e.scrollTo&&e.scrollTo.is(jn)&&(this.viewState.scrollTarget=e.scrollTo.value.clip(this.viewState.state)),this.plugins=this.state.facet(hi).map(s=>new Gi(s));for(let s of this.plugins)s.update(this);this.observer=new Lo(this),this.inputState=new yo(this),this.inputState.ensureHandlers(this.plugins),this.docView=new us(this),this.mountStyles(),this.updateAttrs(),this.updateState=0,this.requestMeasure(),!((t=document.fonts)===null||t===void 0)&&t.ready&&document.fonts.ready.then(()=>{this.viewState.mustMeasureContent="refresh",this.requestMeasure()})}dispatch(...e){let t=e.length==1&&e[0]instanceof te?e:e.length==1&&Array.isArray(e[0])?e[0]:[this.state.update(...e)];this.dispatchTransactions(t,this)}update(e){if(this.updateState!=0)throw new Error("Calls to EditorView.update are not allowed while an update is in progress");let t=!1,i=!1,s,r=this.state;for(let u of e){if(u.startState!=r)throw new RangeError("Trying to update state with a transaction that doesn't start from the previous state.");r=u.state}if(this.destroyed){this.viewState.state=r;return}let o=this.hasFocus,l=0,a=null;e.some(u=>u.annotation(gc))?(this.inputState.notifiedFocused=o,l=1):o!=this.inputState.notifiedFocused&&(this.inputState.notifiedFocused=o,a=yc(r,o),a||(l=1));let h=this.observer.delayedAndroidKey,c=null;if(h?(this.observer.clearDelayedAndroidKey(),c=this.observer.readChange(),(c&&!this.state.doc.eq(r.doc)||!this.state.selection.eq(r.selection))&&(c=null)):this.observer.clear(),r.facet(W.phrases)!=this.state.facet(W.phrases))return this.setState(r);s=cs.create(this,r,e),s.flags|=l;let f=this.viewState.scrollTarget;try{this.updateState=2;for(let u of e){if(f&&(f=f.map(u.changes)),u.scrollIntoView){let{main:d}=u.state.selection,{x:p,y:m}=this.state.facet(n.cursorScrollMargin);f=new Ui(d.empty?d:b.cursor(d.head,d.head>d.anchor?-1:1),"nearest","nearest",m,p)}for(let d of u.effects)d.is(jn)&&(f=d.value.clip(this.state))}this.viewState.update(s,f),this.bidiCache=ys.update(this.bidiCache,s.changes),s.empty||(this.updatePlugins(s),this.inputState.update(s)),t=this.docView.update(s),this.state.facet(zi)!=this.styleModules&&this.mountStyles(),i=this.updateAttrs(),this.showAnnouncements(e),this.docView.updateSelection(t,e.some(u=>u.isUserEvent("select.pointer")))}finally{this.updateState=0}if(s.startState.facet(Xn)!=s.state.facet(Xn)&&(this.viewState.mustMeasureContent=!0),(t||i||f||this.viewState.mustEnforceCursorAssoc||this.viewState.mustMeasureContent)&&this.requestMeasure(),t&&this.docViewUpdate(),!s.empty)for(let u of this.state.facet(to))try{u(s)}catch(d){he(this.state,d,"update listener")}(a||c)&&Promise.resolve().then(()=>{a&&this.state==a.startState&&this.dispatch(a),c&&!hc(this,c)&&h.force&&pi(this.contentDOM,h.key,h.keyCode)})}setState(e){if(this.updateState!=0)throw new Error("Calls to EditorView.setState are not allowed while an update is in progress");if(this.destroyed){this.viewState.state=e;return}this.updateState=2;let t=this.hasFocus;try{for(let i of this.plugins)i.destroy(this);this.viewState=new gs(this,e),this.plugins=e.facet(hi).map(i=>new Gi(i)),this.pluginMap.clear();for(let i of this.plugins)i.update(this);this.docView.destroy(),this.docView=new us(this),this.inputState.ensureHandlers(this.plugins),this.mountStyles(),this.updateAttrs(),this.bidiCache=[]}finally{this.updateState=0}t&&this.focus(),this.requestMeasure()}updatePlugins(e){let t=e.startState.facet(hi),i=e.state.facet(hi);if(t!=i){let s=[];for(let r of i){let o=t.indexOf(r);if(o<0)s.push(new Gi(r));else{let l=this.plugins[o];l.mustUpdate=e,s.push(l)}}for(let r of this.plugins)r.mustUpdate!=e&&r.destroy(this);this.plugins=s,this.pluginMap.clear()}else for(let s of this.plugins)s.mustUpdate=e;for(let s=0;s<this.plugins.length;s++)this.plugins[s].update(this);t!=i&&this.inputState.ensureHandlers(this.plugins)}docViewUpdate(){for(let e of this.plugins){let t=e.value;if(t&&t.docViewUpdate)try{t.docViewUpdate(this)}catch(i){he(this.state,i,"doc view update listener")}}}measure(e=!0){if(this.destroyed)return;if(this.measureScheduled>-1&&this.win.cancelAnimationFrame(this.measureScheduled),this.observer.delayedAndroidKey){this.measureScheduled=-1,this.requestMeasure();return}this.measureScheduled=0,e&&this.observer.forceFlush();let t=null,i=this.viewState.scrollParent,s=this.viewState.getScrollOffset(),{scrollAnchorPos:r,scrollAnchorHeight:o,scaleY:l}=this.viewState;Math.abs(s-this.viewState.scrollOffset)>1&&(o=-1),this.viewState.scrollAnchorHeight=-1;try{for(let a=0;;a++){if(o<0){if(Nh(i||this.win))r=-1,o=this.viewState.heightMap.height/this.viewState.scaleY;else{let p=this.viewState.scrollAnchorAt(s);r=p.from,o=p.top}l=this.viewState.scaleY}this.updateState=1;let h=this.viewState.measure();if(!h&&!this.measureRequests.length&&this.viewState.scrollTarget==null)break;if(a>5){console.warn(this.measureRequests.length?"Measure loop restarted more than 5 times":"Viewport failed to stabilize");break}let c=[];h&4||([this.measureRequests,c]=[c,this.measureRequests]);let f=c.map(p=>{try{return p.read(this)}catch(m){return he(this.state,m),mh}}),u=cs.create(this,this.state,[]),d=!1;u.flags|=h,t?t.flags|=h:t=u,this.updateState=2,u.empty||(this.updatePlugins(u),this.inputState.update(u),this.updateAttrs(),d=this.docView.update(u),d&&this.docViewUpdate());for(let p=0;p<c.length;p++)if(f[p]!=mh)try{let m=c[p];m.write&&m.write(f[p],this)}catch(m){he(this.state,m)}if(d&&this.docView.updateSelection(!0),!u.viewportChanged&&this.measureRequests.length==0){if(this.viewState.editorHeight)if(this.viewState.scrollTarget){this.docView.scrollIntoView(this.viewState.scrollTarget),this.viewState.scrollTarget=null,o=-1;continue}else{let m=(r<0?this.viewState.heightMap.height:this.viewState.lineBlockAt(r).top)/this.viewState.scaleY-o/l;if((m>1||m<-1)&&!(D.ios&&this.inputState.lastIOSMomentumScroll>Date.now()-100)&&(i==this.scrollDOM||this.hasFocus||Math.max(this.inputState.lastWheelEvent,this.inputState.lastTouchTime)>Date.now()-100)){s=s+m,i?r<0?i.scrollTop=i.scrollHeight:i.scrollTop+=m:this.win.scrollBy(0,m),o=-1;continue}}break}}}finally{this.updateState=0,this.measureScheduled=-1}if(t&&!t.empty)for(let a of this.state.facet(to))a(t)}get themeClasses(){return Oo+" "+(this.state.facet(Do)?wc:xc)+" "+this.state.facet(Xn)}updateAttrs(){let e=gh(this,ec,{class:"cm-editor"+(this.hasFocus?" cm-focused ":" ")+this.themeClasses}),t={spellcheck:"false",autocorrect:"off",autocapitalize:"off",writingsuggestions:"false",translate:"no",contenteditable:this.state.facet(dt)?"true":"false",class:"cm-content",style:`${D.tabSize}: ${this.state.tabSize}`,role:"textbox","aria-multiline":"true"};this.state.readOnly&&(t["aria-readonly"]="true"),gh(this,Xo,t);let i=this.observer.ignore(()=>{let s=Ya(this.contentDOM,this.contentAttrs,t),r=Ya(this.dom,this.editorAttrs,e);return s||r});return this.editorAttrs=e,this.contentAttrs=t,i}showAnnouncements(e){let t=!0;for(let i of e)for(let s of i.effects)if(s.is(n.announce)){t&&(this.announceDOM.textContent="",this.win.clearTimeout(this.clearAnnouncement),this.clearAnnouncement=this.win.setTimeout(()=>{this.announceDOM.textContent="\xA0"},200),t=!1);let r=this.announceDOM.appendChild(document.createElement("div"));r.textContent=s.value}}mountStyles(){this.styleModules=this.state.facet(zi);let e=this.state.facet(n.cspNonce);He.mount(this.root,this.styleModules.concat(qp).reverse(),e?{nonce:e}:void 0)}readMeasured(){if(this.updateState==2)throw new Error("Reading the editor layout isn't allowed during an update");this.updateState==0&&this.measureScheduled>-1&&this.measure(!1)}requestMeasure(e){if(this.measureScheduled<0&&(this.measureScheduled=this.win.requestAnimationFrame(()=>this.measure())),e){if(this.measureRequests.indexOf(e)>-1)return;if(e.key!=null){for(let t=0;t<this.measureRequests.length;t++)if(this.measureRequests[t].key===e.key){this.measureRequests[t]=e;return}}this.measureRequests.push(e)}}plugin(e){let t=this.pluginMap.get(e);return(t===void 0||t&&t.plugin!=e)&&this.pluginMap.set(e,t=this.plugins.find(i=>i.plugin==e)||null),t&&t.update(this).value}get documentTop(){return this.contentDOM.getBoundingClientRect().top+this.viewState.paddingTop}get documentPadding(){return{top:this.viewState.paddingTop,bottom:this.viewState.paddingBottom}}get scaleX(){return this.viewState.scaleX}get scaleY(){return this.viewState.scaleY}elementAtHeight(e){return this.readMeasured(),this.viewState.elementAtHeight(e)}lineBlockAtHeight(e){return this.readMeasured(),this.viewState.lineBlockAtHeight(e)}get viewportLineBlocks(){return this.viewState.viewportLines}lineBlockAt(e){return this.viewState.lineBlockAt(e)}get contentHeight(){return this.viewState.contentHeight}moveByChar(e,t,i){return zr(this,e,th(this,e,t,i))}moveByGroup(e,t){return zr(this,e,th(this,e,t,i=>up(this,e.head,i)))}visualLineSide(e,t){return t?b.cursor(e.to,1):b.cursor(e.from,-1)}moveToLineBoundary(e,t,i=!0){return fp(this,e,t,i)}moveVertically(e,t,i){return zr(this,e,dp(this,e,t,i))}domAtPos(e,t=1){return this.docView.domAtPos(e,t)}posAtDOM(e,t=0){return this.docView.posFromDOM(e,t)}posAtCoords(e,t=!0){this.readMeasured();let i=fo(this,e,t);return i&&i.pos}posAndSideAtCoords(e,t=!0){return this.readMeasured(),fo(this,e,t)}coordsAtPos(e,t=1){this.readMeasured();let i=this.state.doc.lineAt(e),s=this.bidiSpans(i),r=s[ze.find(s,e-i.from,-1,t)];return i.length&&(e==i.from&&t<0||e==i.to&&t>0)&&r.dir!=this.textDirectionAt(i.from)&&(e==i.to?(e=i.from+r.from,t=1):(e=i.from+r.to,t=-1)),this.docView.coordsAt(e,t,r.dir==q.RTL)}coordsForChar(e){return this.readMeasured(),this.docView.coordsForChar(e)}get defaultCharacterWidth(){return this.viewState.heightOracle.charWidth}get defaultLineHeight(){return this.viewState.heightOracle.lineHeight}get textDirection(){return this.viewState.defaultTextDirection}textDirectionAt(e){return!this.state.facet(Xh)||e<this.viewport.from||e>this.viewport.to?this.textDirection:(this.readMeasured(),this.docView.textDirectionAt(e))}get lineWrapping(){return this.viewState.heightOracle.lineWrapping}bidiSpans(e){if(e.length>jp)return qh(e.length);let t=this.textDirectionAt(e.from),i;for(let r of this.bidiCache)if(r.from==e.from&&r.dir==t&&(r.fresh||zh(r.isolates,i=Qa(this,e))))return r.order;i||(i=Qa(this,e));let s=jd(e.text,t,i);return this.bidiCache.push(new ys(e.from,e.to,t,i,!0,s)),s}get hasFocus(){var e;return(this.dom.ownerDocument.hasFocus()||D.safari&&((e=this.inputState)===null||e===void 0?void 0:e.lastContextMenu)>Date.now()-3e4)&&this.root.activeElement==this.contentDOM}focus(){this.observer.ignore(()=>{Ih(this.contentDOM),this.docView.updateSelection()})}setRoot(e){this._root!=e&&(this._root=e,this.observer.setWindow((e.nodeType==9?e:e.ownerDocument).defaultView||window),this.mountStyles())}destroy(){this.root.activeElement==this.contentDOM&&this.contentDOM.blur();for(let e of this.plugins)e.destroy(this);this.plugins=[],this.inputState.destroy(),this.docView.destroy(),this.dom.remove(),this.observer.destroy(),this.win.clearTimeout(this.clearAnnouncement),this.measureScheduled>-1&&this.win.cancelAnimationFrame(this.measureScheduled),this.destroyed=!0}static scrollIntoView(e,t={}){var i,s,r,o;return jn.of(new Ui(typeof e=="number"?b.cursor(e):e,(i=t.y)!==null&&i!==void 0?i:"nearest",(s=t.x)!==null&&s!==void 0?s:"nearest",(r=t.yMargin)!==null&&r!==void 0?r:5,(o=t.xMargin)!==null&&o!==void 0?o:5))}scrollSnapshot(){let{scrollTop:e,scrollLeft:t}=this.scrollDOM,i=this.viewState.scrollAnchorAt(e);return jn.of(new Ui(b.cursor(i.from),"start","start",i.top-e,t,!0))}setTabFocusMode(e){e==null?this.inputState.tabFocusMode=this.inputState.tabFocusMode<0?0:-1:typeof e=="boolean"?this.inputState.tabFocusMode=e?0:-1:this.inputState.tabFocusMode!=0&&(this.inputState.tabFocusMode=Date.now()+e)}static domEventHandlers(e){return _.define(()=>({}),{eventHandlers:e})}static domEventObservers(e){return _.define(()=>({}),{eventObservers:e})}static theme(e,t){let i=He.newName(),s=[Xn.of(i),zi.of(Bo(`.${i}`,e))];return t&&t.dark&&s.push(Do.of(!0)),s}static baseTheme(e){return Fe.lowest(zi.of(Bo("."+Oo,e,kc)))}static findFromDOM(e){var t;let i=e.querySelector(".cm-content"),s=i&&X.get(i)||X.get(e);return((t=s?.root)===null||t===void 0?void 0:t.view)||null}};M.styleModule=zi;M.inputHandler=_h;M.clipboardInputFilter=_o;M.clipboardOutputFilter=Yo;M.scrollHandler=Qh;M.focusChangeEffect=Yh;M.perLineTextDirection=Xh;M.exceptionSink=Gh;M.updateListener=to;M.editable=dt;M.mouseSelectionStyle=Uh;M.dragMovesSelection=jh;M.clickAddsSelectionRange=$h;M.decorations=Cs;M.blockWrappers=tc;M.outerDecorations=Jo;M.atomicRanges=sn;M.bidiIsolatedRanges=ic;M.cursorScrollMargin=A.define({combine:n=>{let e=5,t=5;for(let i of n)typeof i=="number"?e=t=i:{x:e,y:t}=i;return{x:e,y:t}}});M.scrollMargins=sc;M.darkTheme=Do;M.cspNonce=A.define({combine:n=>n.length?n[0]:""});M.contentAttributes=Xo;M.editorAttributes=ec;M.lineWrapping=M.contentAttributes.of({class:"cm-lineWrapping"});M.announce=L.define();jp=4096,mh={},ys=class n{constructor(e,t,i,s,r,o){this.from=e,this.to=t,this.dir=i,this.isolates=s,this.fresh=r,this.order=o}static update(e,t){if(t.empty&&!e.some(r=>r.fresh))return e;let i=[],s=e.length?e[e.length-1].dir:q.LTR;for(let r=Math.max(0,e.length-10);r<e.length;r++){let o=e[r];o.dir==s&&!t.touchesRange(o.from,o.to)&&i.push(new n(t.mapPos(o.from,1),t.mapPos(o.to,-1),o.dir,o.isolates,!1,o.order))}return i}};Up=D.mac?"mac":D.windows?"win":D.linux?"linux":"key";_p=Fe.default(M.domEventHandlers({keydown(n,e){return Cc(vc(e.state),n,e,"editor")}})),vt=A.define({enables:_p}),yh=new WeakMap;bt=null,Yp=4e3;Ro=null;zt=class n{constructor(e,t,i,s,r){this.className=e,this.left=t,this.top=i,this.width=s,this.height=r}draw(){let e=document.createElement("div");return e.className=this.className,this.adjust(e),e}update(e,t){return t.className!=this.className?!1:(this.adjust(e),!0)}adjust(e){e.style.left=this.left+"px",e.style.top=this.top+"px",this.width!=null&&(e.style.width=this.width+"px"),e.style.height=this.height+"px"}eq(e){return this.left==e.left&&this.top==e.top&&this.width==e.width&&this.height==e.height&&this.className==e.className}static forRange(e,t,i){if(i.empty){let s=e.coordsAtPos(i.head,i.assoc||1);if(!s)return[];let r=Ac(e);return[new n(t,s.left-r.left,s.top-r.top,null,s.bottom-s.top)]}else return Jp(e,t,i)}};Po=class{constructor(e,t){this.view=e,this.layer=t,this.drawn=[],this.scaleX=1,this.scaleY=1,this.measureReq={read:this.measure.bind(this),write:this.draw.bind(this)},this.dom=e.scrollDOM.appendChild(document.createElement("div")),this.dom.classList.add("cm-layer"),t.above&&this.dom.classList.add("cm-layer-above"),t.class&&this.dom.classList.add(t.class),this.scale(),this.dom.setAttribute("aria-hidden","true"),this.setOrder(e.state),e.requestMeasure(this.measureReq),t.mount&&t.mount(this.dom,e)}update(e){e.startState.facet(is)!=e.state.facet(is)&&this.setOrder(e.state),(this.layer.update(e,this.dom)||e.geometryChanged)&&(this.scale(),e.view.requestMeasure(this.measureReq))}docViewUpdate(e){this.layer.updateOnDocViewUpdate!==!1&&e.requestMeasure(this.measureReq)}setOrder(e){let t=0,i=e.facet(is);for(;t<i.length&&i[t]!=this.layer;)t++;this.dom.style.zIndex=String((this.layer.above?150:-1)-t)}measure(){return this.layer.markers(this.view)}scale(){let{scaleX:e,scaleY:t}=this.view;(e!=this.scaleX||t!=this.scaleY)&&(this.scaleX=e,this.scaleY=t,this.dom.style.transform=`scale(${1/e}, ${1/t})`)}draw(e){if(e.length!=this.drawn.length||e.some((t,i)=>!Qp(t,this.drawn[i]))){let t=this.dom.firstChild,i=0;for(let s of e)s.update&&t&&s.constructor&&this.drawn[i].constructor&&s.update(t,this.drawn[i])?(t=t.nextSibling,i++):this.dom.insertBefore(s.draw(),t);for(;t;){let s=t.nextSibling;t.remove(),t=s}this.drawn=e,D.webkit&&(this.dom.style.display=this.dom.firstChild?"":"none")}}destroy(){this.layer.destroy&&this.layer.destroy(this.dom,this.view),this.dom.remove()}},is=A.define();Io=!D.ios,vi=A.define({combine(n){return pe(n,{cursorBlinkRate:1200,drawRangeCursor:!0,iosSelectionHandles:!0},{cursorBlinkRate:(e,t)=>Math.min(e,t),drawRangeCursor:(e,t)=>e||t})}});Zp=Mc({above:!0,markers(n){let{state:e}=n,t=e.facet(vi),i=[];for(let s of e.selection.ranges){let r=s==e.selection.main;if(s.empty||t.drawRangeCursor&&!(r&&D.ios&&t.iosSelectionHandles)){let o=r?"cm-cursor cm-cursor-primary":"cm-cursor cm-cursor-secondary",l=s.empty?s:b.cursor(s.head,s.assoc);for(let a of zt.forRange(n,o,l))i.push(a)}}return i},update(n,e){n.transactions.some(i=>i.selection)&&(e.style.animationName=e.style.animationName=="cm-blink"?"cm-blink2":"cm-blink");let t=Dc(n);return t&&xh(n.state,e),n.docChanged||n.selectionSet||t},mount(n,e){xh(e.state,n)},class:"cm-cursorLayer"});em=Mc({above:!1,markers(n){let e=[],{main:t,ranges:i}=n.state.selection;for(let s of i)if(!s.empty&&(Io||s!=t))for(let r of zt.forRange(n,"cm-selectionBackground",s))e.push(r);if(D.ios&&!t.empty&&n.state.facet(vi).iosSelectionHandles){for(let s of zt.forRange(n,"cm-selectionHandle cm-selectionHandle-start",b.cursor(t.from,1)))e.push(s);for(let s of zt.forRange(n,"cm-selectionHandle cm-selectionHandle-end",b.cursor(t.to,1)))e.push(s)}return e},update(n,e){return n.docChanged||n.selectionSet||n.viewportChanged||Dc(n)},class:"cm-selectionLayer"}),tm=D.gecko&&D.gecko_version==153?"#ffffff01":"transparent",im=Fe.highest(M.theme({".cm-line":{...Io?{"& ::selection, &::selection":{backgroundColor:`${tm} !important`}}:{},caretColor:"transparent !important"},".cm-content":{caretColor:"transparent !important","& :focus":{caretColor:"initial !important",...Io?{"&::selection, & ::selection":{backgroundColor:"Highlight !important"}}:{}}}})),Oc=L.define({map(n,e){return n==null?null:e.mapPos(n)}}),Ki=Q.define({create(){return null},update(n,e){return n!=null&&(n=e.changes.mapPos(n)),e.effects.reduce((t,i)=>i.is(Oc)?i.value:t,n)}}),nm=_.fromClass(class{constructor(n){this.view=n,this.cursor=null,this.measureReq={read:this.readPos.bind(this),write:this.drawCursor.bind(this)}}update(n){var e;let t=n.state.field(Ki);t==null?this.cursor!=null&&((e=this.cursor)===null||e===void 0||e.remove(),this.cursor=null):(this.cursor||(this.cursor=this.view.scrollDOM.appendChild(document.createElement("div")),this.cursor.className="cm-dropCursor"),(n.startState.field(Ki)!=t||n.docChanged||n.geometryChanged)&&this.view.requestMeasure(this.measureReq))}readPos(){let{view:n}=this,e=n.state.field(Ki),t=e!=null&&n.coordsAtPos(e);if(!t)return null;let i=n.scrollDOM.getBoundingClientRect();return{left:t.left-i.left+n.scrollDOM.scrollLeft*n.scaleX,top:t.top-i.top+n.scrollDOM.scrollTop*n.scaleY,height:t.bottom-t.top}}drawCursor(n){if(this.cursor){let{scaleX:e,scaleY:t}=this.view;n?(this.cursor.style.left=n.left/e+"px",this.cursor.style.top=n.top/t+"px",this.cursor.style.height=n.height/t+"px"):this.cursor.style.left="-100000px"}}destroy(){this.cursor&&this.cursor.remove()}setDropPos(n){this.view.state.field(Ki)!=n&&this.view.dispatch({effects:Oc.of(n)})}},{eventObservers:{dragover(n){this.setDropPos(this.view.posAtCoords({x:n.clientX,y:n.clientY}))},dragleave(n){(n.target==this.view.contentDOM||!this.view.contentDOM.contains(n.relatedTarget))&&this.setDropPos(null)},dragend(){this.setDropPos(null)},drop(){this.setDropPos(null)}}});No=class{constructor(e){let{regexp:t,decoration:i,decorate:s,boundary:r,maxLength:o=1e3}=e;if(!t.global)throw new RangeError("The regular expression given to MatchDecorator should have its 'g' flag set");if(this.regexp=t,s)this.addMatch=(l,a,h,c)=>s(c,h,h+l[0].length,l,a);else if(typeof i=="function")this.addMatch=(l,a,h,c)=>{let f=i(l,a,h);f&&c(h,h+l[0].length,f)};else if(i)this.addMatch=(l,a,h,c)=>c(h,h+l[0].length,i);else throw new RangeError("Either 'decorate' or 'decoration' should be provided to MatchDecorator");this.boundary=r,this.maxLength=o}createDeco(e){let t=new de,i=t.add.bind(t);for(let{from:s,to:r}of sm(e,this.maxLength))wh(e.state.doc,this.regexp,s,r,(o,l)=>this.addMatch(l,e,o,i));return t.finish()}updateDeco(e,t){let i=1e9,s=-1;return e.docChanged&&e.changes.iterChanges((r,o,l,a)=>{a>=e.view.viewport.from&&l<=e.view.viewport.to&&(i=Math.min(l,i),s=Math.max(a,s))}),e.viewportMoved||s-i>1e3?this.createDeco(e.view):s>-1?this.updateRange(e.view,t.map(e.changes),i,s):t}updateRange(e,t,i,s){for(let r of e.visibleRanges){let o=Math.max(r.from,i),l=Math.min(r.to,s);if(l>=o){let a=e.state.doc.lineAt(o),h=a.to<l?e.state.doc.lineAt(l):a,c=Math.max(r.from,a.from),f=Math.min(r.to,h.to);if(this.boundary){for(;o>a.from;o--)if(this.boundary.test(a.text[o-1-a.from])){c=o;break}for(;l<h.to;l++)if(this.boundary.test(h.text[l-h.from])){f=l;break}}let u=[],d,p=(m,g,y)=>u.push(y.range(m,g));if(a==h)for(this.regexp.lastIndex=c-a.from;(d=this.regexp.exec(a.text))&&d.index<f-a.from;)this.addMatch(d,e,d.index+a.from,p);else wh(e.state.doc,this.regexp,c,f,(m,g)=>this.addMatch(g,e,m,p));t=t.update({filterFrom:c,filterTo:f,filter:(m,g)=>m<c||g>f,add:u})}}return t}},Fo=/x/.unicode!=null?"gu":"g",rm=new RegExp(`[\0-\b
-\x7F-\x9F\xAD\u061C\u200B\u200E\u200F\u2028\u2029\u202D\u202E\u2066\u2067\u2069\uFEFF\uFFF9-\uFFFC]`,Fo),om={0:"null",7:"bell",8:"backspace",10:"newline",11:"vertical tab",13:"carriage return",27:"escape",8203:"zero width space",8204:"zero width non-joiner",8205:"zero width joiner",8206:"left-to-right mark",8207:"right-to-left mark",8232:"line separator",8237:"left-to-right override",8238:"right-to-left override",8294:"left-to-right isolate",8295:"right-to-left isolate",8297:"pop directional isolate",8233:"paragraph separator",65279:"zero width no-break space",65532:"object replacement"},Kr=null;ns=A.define({combine(n){let e=pe(n,{render:null,specialChars:rm,addSpecialChars:null});return(e.replaceTabs=!lm())&&(e.specialChars=new RegExp("	|"+e.specialChars.source,Fo)),e.addSpecialChars&&(e.specialChars=new RegExp(e.specialChars.source+"|"+e.addSpecialChars.source,Fo)),e}});kh=null;hm="\u2022";Ho=class extends we{constructor(e,t){super(),this.options=e,this.code=t}eq(e){return e.code==this.code}toDOM(e){let t=cm(this.code),i=e.state.phrase("Control character")+" "+(om[this.code]||"0x"+this.code.toString(16)),s=this.options.render&&this.options.render(this.code,i,t);if(s)return s;let r=document.createElement("span");return r.textContent=t,r.title=i,r.setAttribute("aria-label",i),r.className="cm-specialChar",r}ignoreEvent(){return!1}},Wo=class extends we{constructor(e){super(),this.width=e}eq(e){return e.width==this.width}toDOM(){let e=document.createElement("span");return e.textContent="	",e.className="cm-tab",e.style.width=this.width+"px",e}ignoreEvent(){return!1}};fm=B.line({class:"cm-activeLine"}),um=_.fromClass(class{constructor(n){this.decorations=this.getDeco(n)}update(n){(n.docChanged||n.selectionSet)&&(this.decorations=this.getDeco(n.view))}getDeco(n){let e=-1,t=[];for(let i of n.state.selection.ranges){let s=n.lineBlockAt(i.head);s.from>e&&(t.push(fm.range(s.from)),e=s.from)}return B.set(t)}},{decorations:n=>n.decorations}),Vo=2e3;gm={Alt:[18,n=>!!n.altKey],Control:[17,n=>!!n.ctrlKey],Shift:[16,n=>!!n.shiftKey],Meta:[91,n=>!!n.metaKey]},ym={style:"cursor: crosshair"};Qn="-10000px",bs=class{constructor(e,t,i,s){this.facet=t,this.createTooltipView=i,this.removeTooltipView=s,this.input=e.state.facet(t),this.tooltips=this.input.filter(o=>o);let r=null;this.tooltipViews=this.tooltips.map(o=>r=i(o,r))}update(e,t){var i;let s=e.state.facet(this.facet),r=s.filter(a=>a);if(s===this.input){for(let a of this.tooltipViews)a.update&&a.update(e);return!1}let o=[],l=t?[]:null;for(let a=0;a<r.length;a++){let h=r[a],c=-1;if(h){for(let f=0;f<this.tooltips.length;f++){let u=this.tooltips[f];u&&u.create==h.create&&(c=f)}if(c<0)o[a]=this.createTooltipView(h,a?o[a-1]:null),l&&(l[a]=!!h.above);else{let f=o[a]=this.tooltipViews[c];l&&(l[a]=t[c]),f.update&&f.update(e)}}}for(let a of this.tooltipViews)o.indexOf(a)<0&&(this.removeTooltipView(a),(i=a.destroy)===null||i===void 0||i.call(a));return t&&(l.forEach((a,h)=>t[h]=a),t.length=l.length),this.input=s,this.tooltips=r,this.tooltipViews=o,!0}};$r=A.define({combine:n=>{var e,t,i;return{position:D.ios?"absolute":((e=n.find(s=>s.position))===null||e===void 0?void 0:e.position)||"fixed",parent:((t=n.find(s=>s.parent))===null||t===void 0?void 0:t.parent)||null,tooltipSpace:((i=n.find(s=>s.tooltipSpace))===null||i===void 0?void 0:i.tooltipSpace)||bm}}}),Sh=new WeakMap,el=_.fromClass(class{constructor(n){this.view=n,this.above=[],this.inView=!0,this.madeAbsolute=!1,this.lastTransaction=0,this.measureTimeout=-1;let e=n.state.facet($r);this.position=e.position,this.parent=e.parent,this.classes=n.themeClasses,this.createContainer(),this.measureReq={read:this.readMeasure.bind(this),write:this.writeMeasure.bind(this),key:this},this.resizeObserver=typeof ResizeObserver=="function"?new ResizeObserver(()=>this.measureSoon()):null,this.manager=new bs(n,rn,(t,i)=>this.createTooltip(t,i),t=>{this.resizeObserver&&this.resizeObserver.unobserve(t.dom),t.dom.remove()}),this.above=this.manager.tooltips.map(t=>!!t.above),this.intersectionObserver=typeof IntersectionObserver=="function"?new IntersectionObserver(t=>{Date.now()>this.lastTransaction-50&&t.length>0&&t[t.length-1].intersectionRatio<1&&this.measureSoon()},{threshold:[1]}):null,this.observeIntersection(),n.win.addEventListener("resize",this.measureSoon=this.measureSoon.bind(this)),this.maybeMeasure()}createContainer(){this.parent?(this.container=document.createElement("div"),this.container.style.position="relative",this.container.className=this.view.themeClasses,this.parent.appendChild(this.container)):this.container=this.view.dom}observeIntersection(){if(this.intersectionObserver){this.intersectionObserver.disconnect();for(let n of this.manager.tooltipViews)this.intersectionObserver.observe(n.dom)}}measureSoon(){this.measureTimeout<0&&(this.measureTimeout=setTimeout(()=>{this.measureTimeout=-1,this.maybeMeasure()},50))}update(n){n.transactions.length&&(this.lastTransaction=Date.now());let e=this.manager.update(n,this.above);e&&this.observeIntersection();let t=e||n.geometryChanged,i=n.state.facet($r);if(i.position!=this.position&&!this.madeAbsolute){this.position=i.position;for(let s of this.manager.tooltipViews)s.dom.style.position=this.position;t=!0}if(i.parent!=this.parent){this.parent&&this.container.remove(),this.parent=i.parent,this.createContainer();for(let s of this.manager.tooltipViews)this.container.appendChild(s.dom);t=!0}else this.parent&&this.view.themeClasses!=this.classes&&(this.classes=this.container.className=this.view.themeClasses);t&&this.maybeMeasure()}createTooltip(n,e){let t=n.create(this.view),i=e?e.dom:null;if(t.dom.classList.add("cm-tooltip"),n.arrow&&!t.dom.querySelector(".cm-tooltip > .cm-tooltip-arrow")){let s=document.createElement("div");s.className="cm-tooltip-arrow",t.dom.appendChild(s)}return t.dom.style.position=this.position,t.dom.style.top=Qn,t.dom.style.left="0px",this.container.insertBefore(t.dom,i),t.mount&&t.mount(this.view),this.resizeObserver&&this.resizeObserver.observe(t.dom),t}destroy(){var n,e,t;this.view.win.removeEventListener("resize",this.measureSoon);for(let i of this.manager.tooltipViews)i.dom.remove(),(n=i.destroy)===null||n===void 0||n.call(i);this.parent&&this.container.remove(),(e=this.resizeObserver)===null||e===void 0||e.disconnect(),(t=this.intersectionObserver)===null||t===void 0||t.disconnect(),clearTimeout(this.measureTimeout)}readMeasure(){let n=1,e=1,t=!1,i=0;if(this.position=="fixed"&&this.manager.tooltipViews.length){let{dom:o}=this.manager.tooltipViews[0];if(D.safari){let l=o.getBoundingClientRect();t=Math.abs(l.top+1e4)>1||Math.abs(l.left)>1}else t=!!o.offsetParent&&o.offsetParent!=this.container.ownerDocument.body}if(t||this.position=="absolute")if(this.parent){let o=this.parent.getBoundingClientRect();o.width&&o.height&&(n=o.width/this.parent.offsetWidth,e=o.height/this.parent.offsetHeight)}else({scaleX:n,scaleY:e}=this.view.viewState);else i=Ic(this.view).left;let s=this.view.scrollDOM.getBoundingClientRect(),r=Qo(this.view);return{visible:{left:s.left+r.left,top:s.top+r.top,right:s.right-r.right,bottom:s.bottom-r.bottom},parent:this.parent?this.container.getBoundingClientRect():this.view.dom.getBoundingClientRect(),pos:this.manager.tooltips.map((o,l)=>{let a=this.manager.tooltipViews[l];return a.getCoords?a.getCoords(o.pos):this.view.coordsAtPos(o.pos)}),size:this.manager.tooltipViews.map(({dom:o})=>o.getBoundingClientRect()),space:this.view.state.facet($r).tooltipSpace(this.view),scaleX:n,scaleY:e,makeAbsolute:t,fixedLeft:i}}writeMeasure(n){var e;if(n.makeAbsolute){this.madeAbsolute=!0,this.position="absolute";for(let l of this.manager.tooltipViews)l.dom.style.position="absolute"}let{visible:t,space:i,scaleX:s,scaleY:r}=n,o=[];for(let l=0;l<this.manager.tooltips.length;l++){let a=this.manager.tooltips[l],h=this.manager.tooltipViews[l],{dom:c}=h,f=n.pos[l],u=n.size[l];if(!f||a.clip!==!1&&(f.bottom<=Math.max(t.top,i.top)||f.top>=Math.min(t.bottom,i.bottom)||f.right<Math.max(t.left,i.left)-.1||f.left>Math.min(t.right,i.right)+.1)){c.style.top=Qn;continue}let d=a.arrow?h.dom.querySelector(".cm-tooltip-arrow"):null,p=d?7:0,m=u.right-u.left,g=(e=Sh.get(h))!==null&&e!==void 0?e:u.bottom-u.top,y=h.offset||wm,k=this.view.textDirection==q.LTR,x=u.width>i.right-i.left?k?i.left:i.right-u.width:k?Math.max(i.left,Math.min(f.left-(d?14:0)+y.x,i.right-m)):Math.min(Math.max(i.left,f.left-m+(d?14:0)-y.x),i.right-m),O=this.above[l];!a.strictSide&&(O?f.top-g-p-y.y<i.top:f.bottom+g+p+y.y>i.bottom)&&O==i.bottom-f.bottom>f.top-i.top&&(O=this.above[l]=!O);let w=(O?f.top-i.top:i.bottom-f.bottom)-p;if(w<g&&h.resize!==!1){if(w<this.view.defaultLineHeight){c.style.top=Qn;continue}Sh.set(h,g),c.style.height=(g=w)/r+"px"}else c.style.height&&(c.style.height="");let S=O?f.top-g-p-y.y:f.bottom+p+y.y,C=x+m;if(h.overlap!==!0)for(let R of o)R.left<C&&R.right>x&&R.top<S+g&&R.bottom>S&&(S=O?R.top-g-2-p:R.bottom+p+2);if(this.position=="absolute"?(c.style.top=(S-n.parent.top)/r+"px",Ch(c,(x-n.parent.left)/s)):(c.style.top=S/r+"px",Ch(c,(x-n.fixedLeft)/s)),d){let R=f.left+(k?y.x:-y.x)-(x+14-7);d.style.left=R/s+"px"}h.overlap!==!0&&o.push({left:x,top:S,right:C,bottom:S+g}),c.classList.toggle("cm-tooltip-above",O),c.classList.toggle("cm-tooltip-below",!O),h.positioned&&h.positioned(n.space)}}maybeMeasure(){if(this.manager.tooltips.length&&(this.view.inView&&this.view.requestMeasure(this.measureReq),this.inView!=this.view.inView&&(this.inView=this.view.inView,!this.inView)))for(let n of this.manager.tooltipViews)n.dom.style.top=Qn}},{eventObservers:{scroll(){this.maybeMeasure()}}});xm=M.baseTheme({".cm-tooltip":{zIndex:500,boxSizing:"border-box"},"&light .cm-tooltip":{border:"1px solid #bbb",backgroundColor:"#f5f5f5"},"&light .cm-tooltip-section:not(:first-child)":{borderTop:"1px solid #bbb"},"&dark .cm-tooltip":{backgroundColor:"#333338",color:"white"},".cm-tooltip-arrow":{height:"7px",width:"14px",position:"absolute",zIndex:-1,overflow:"hidden","&:before, &:after":{content:"''",position:"absolute",width:0,height:0,borderLeft:"7px solid transparent",borderRight:"7px solid transparent"},".cm-tooltip-above &":{bottom:"-7px","&:before":{borderTop:"7px solid #bbb"},"&:after":{borderTop:"7px solid #f5f5f5",bottom:"1px"}},".cm-tooltip-below &":{top:"-7px","&:before":{borderBottom:"7px solid #bbb"},"&:after":{borderBottom:"7px solid #f5f5f5",top:"1px"}}},"&dark .cm-tooltip .cm-tooltip-arrow":{"&:before":{borderTopColor:"#333338",borderBottomColor:"#333338"},"&:after":{borderTopColor:"transparent",borderBottomColor:"transparent"}}}),wm={x:0,y:0},rn=A.define({enables:[el,xm]}),xs=A.define({combine:n=>n.reduce((e,t)=>e.concat(t),[])}),ws=class n{static create(e){return new n(e)}constructor(e){this.view=e,this.mounted=!1,this.dom=document.createElement("div"),this.dom.classList.add("cm-tooltip-hover"),this.manager=new bs(e,xs,(t,i)=>this.createHostedView(t,i),t=>t.dom.remove())}createHostedView(e,t){let i=e.create(this.view);return i.dom.classList.add("cm-tooltip-section"),this.dom.insertBefore(i.dom,t?t.dom.nextSibling:this.dom.firstChild),this.mounted&&i.mount&&i.mount(this.view),i}mount(e){for(let t of this.manager.tooltipViews)t.mount&&t.mount(e);this.mounted=!0}positioned(e){for(let t of this.manager.tooltipViews)t.positioned&&t.positioned(e)}update(e){this.manager.update(e)}destroy(){var e;for(let t of this.manager.tooltipViews)(e=t.destroy)===null||e===void 0||e.call(t)}passProp(e){let t;for(let i of this.manager.tooltipViews){let s=i[e];if(s!==void 0){if(t===void 0)t=s;else if(t!==s)return}}return t}get offset(){return this.passProp("offset")}get getCoords(){return this.passProp("getCoords")}get overlap(){return this.passProp("overlap")}get resize(){return this.passProp("resize")}},km=rn.compute([xs],n=>{let e=n.facet(xs);return e.length===0?null:{pos:Math.min(...e.map(t=>t.pos)),end:Math.max(...e.map(t=>{var i;return(i=t.end)!==null&&i!==void 0?i:t.pos})),create:ws.create,above:e[0].above,arrow:e.some(t=>t.arrow)}}),Nc=A.define(),zo=class{constructor(e,t,i,s,r,o){this.view=e,this.source=t,this.field=i,this.locked=s,this.setHover=r,this.hoverTime=o,this.hoverTimeout=-1,this.restartTimeout=-1,this.pending=null,this.lastMove={x:0,y:0,target:e.dom,time:0},this.checkHover=this.checkHover.bind(this),e.dom.addEventListener("mouseleave",this.mouseleave=this.mouseleave.bind(this)),e.dom.addEventListener("mousemove",this.mousemove=this.mousemove.bind(this))}update(e){this.pending&&(this.pending=null,clearTimeout(this.restartTimeout),this.restartTimeout=setTimeout(()=>this.startHover(),20))}get active(){return this.view.state.field(this.field)}checkHover(){if(this.hoverTimeout=-1,this.active.length)return;let e=Date.now()-this.lastMove.time;e<this.hoverTime?this.hoverTimeout=setTimeout(this.checkHover,this.hoverTime-e):this.startHover()}startHover(){clearTimeout(this.restartTimeout);let{view:e,lastMove:t}=this,i=e.docView.tile.nearest(t.target);if(!i)return;let s,r=1;if(i.isWidget())s=i.posAtStart;else{if(s=e.posAtCoords(t),s==null)return;let o=e.coordsAtPos(s);if(!o||t.y<o.top||t.y>o.bottom||t.x<o.left-e.defaultCharacterWidth||t.x>o.right+e.defaultCharacterWidth)return;let l=e.bidiSpans(e.state.doc.lineAt(s)).find(h=>h.from<=s&&h.to>=s),a=l&&l.dir==q.RTL?-1:1;r=t.x<o.left?-a:a}this.activateHover(e,s,r)}activateHover(e,t,i,s){let r=this.source(e,t,i),o=l=>{if(l&&!(Array.isArray(l)&&!l.length)){let a=Array.isArray(l)?l:[l];s&&this.locked.set(a,s),e.dispatch({effects:this.setHover.of(a)})}};if(r&&"then"in r){let l=this.pending={pos:t};r.then(a=>{this.pending==l&&(this.pending=null,o(a))},a=>he(e.state,a,"hover tooltip"))}else o(r)}get tooltip(){let e=this.view.plugin(el),t=e?e.manager.tooltips.findIndex(i=>i.create==ws.create):-1;return t>-1?e.manager.tooltipViews[t]:null}mousemove(e){var t,i;this.lastMove={x:e.clientX,y:e.clientY,target:e.target,time:Date.now()},this.hoverTimeout<0&&(this.hoverTimeout=setTimeout(this.checkHover,this.hoverTime));let{active:s,tooltip:r}=this;if(s.length&&!this.locked.has(s)&&r&&!vm(r.dom,e)||this.pending){let{pos:o}=s[0]||this.pending,l=(i=(t=s[0])===null||t===void 0?void 0:t.end)!==null&&i!==void 0?i:o;(o==l?this.view.posAtCoords(this.lastMove)!=o:!Sm(this.view,o,l,e.clientX,e.clientY))&&(this.view.dispatch({effects:this.setHover.of([])}),this.pending=null)}}mouseleave(e){clearTimeout(this.hoverTimeout),this.hoverTimeout=-1;let{active:t}=this;if(t.length&&!this.locked.has(t)){let{tooltip:i}=this;i&&i.dom.contains(e.relatedTarget)?this.watchTooltipLeave(i.dom):this.view.dispatch({effects:this.setHover.of([])})}}watchTooltipLeave(e){let t=i=>{e.removeEventListener("mouseleave",t);let{active:s}=this;s.length&&!this.locked.has(s)&&!this.view.dom.contains(i.relatedTarget)&&this.view.dispatch({effects:this.setHover.of([])})};e.addEventListener("mouseleave",t)}destroy(){clearTimeout(this.hoverTimeout),clearTimeout(this.restartTimeout),this.view.dom.removeEventListener("mouseleave",this.mouseleave),this.view.dom.removeEventListener("mousemove",this.mousemove)}},Zn=4;Cm=L.define(),Ah=A.define({combine(n){let e,t;for(let i of n)e=e||i.topContainer,t=t||i.bottomContainer;return{topContainer:e,bottomContainer:t}}});Wc=_.fromClass(class{constructor(n){this.input=n.state.facet($t),this.specs=this.input.filter(t=>t),this.panels=this.specs.map(t=>t(n));let e=n.state.facet(Ah);this.top=new fi(n,!0,e.topContainer),this.bottom=new fi(n,!1,e.bottomContainer),this.top.sync(this.panels.filter(t=>t.top)),this.bottom.sync(this.panels.filter(t=>!t.top));for(let t of this.panels)t.dom.classList.add("cm-panel"),t.mount&&t.mount()}update(n){let e=n.state.facet(Ah);this.top.container!=e.topContainer&&(this.top.sync([]),this.top=new fi(n.view,!0,e.topContainer)),this.bottom.container!=e.bottomContainer&&(this.bottom.sync([]),this.bottom=new fi(n.view,!1,e.bottomContainer)),this.top.syncClasses(),this.bottom.syncClasses();let t=n.state.facet($t);if(t!=this.input){let i=t.filter(a=>a),s=[],r=[],o=[],l=[];for(let a of i){let h=this.specs.indexOf(a),c;h<0?(c=a(n.view),l.push(c)):(c=this.panels[h],c.update&&c.update(n)),s.push(c),(c.top?r:o).push(c)}this.specs=i,this.panels=s,this.top.sync(r),this.bottom.sync(o);for(let a of l)a.dom.classList.add("cm-panel"),a.mount&&a.mount()}else for(let i of this.panels)i.update&&i.update(n)}destroy(){this.top.sync([]),this.bottom.sync([])}},{provide:n=>M.scrollMargins.of(e=>{let t=e.plugin(n);return t&&{top:t.top.scrollMargin(),bottom:t.bottom.scrollMargin()}})}),fi=class{constructor(e,t,i){this.view=e,this.top=t,this.container=i,this.dom=void 0,this.classes="",this.panels=[],this.syncClasses()}sync(e){for(let t of this.panels)t.destroy&&e.indexOf(t)<0&&t.destroy();this.panels=e,this.syncDOM()}syncDOM(){if(this.panels.length==0){this.dom&&(this.dom.remove(),this.dom=void 0);return}if(!this.dom){this.dom=document.createElement("div"),this.dom.className=this.top?"cm-panels cm-panels-top":"cm-panels cm-panels-bottom";let t=this.container||this.view.dom;t.insertBefore(this.dom,this.top?t.firstChild:null)}let e=this.dom.firstChild;for(let t of this.panels)if(t.dom.parentNode==this.dom){for(;e!=t.dom;)e=Mh(e);e=e.nextSibling}else this.dom.insertBefore(t.dom,e);for(;e;)e=Mh(e)}scrollMargin(){return!this.dom||this.container?0:Math.max(0,this.top?this.dom.getBoundingClientRect().bottom-Math.max(0,this.view.scrollDOM.getBoundingClientRect().top):Math.min(innerHeight,this.view.scrollDOM.getBoundingClientRect().bottom)-this.dom.getBoundingClientRect().top)}syncClasses(){if(!(!this.container||this.classes==this.view.themeClasses)){for(let e of this.classes.split(" "))e&&this.container.classList.remove(e);for(let e of(this.classes=this.view.themeClasses).split(" "))e&&this.container.classList.add(e)}}};$t=A.define({enables:Wc});ss=Q.define({create(){return[]},update(n,e){for(let t of e.effects)t.is(qc)?n=[t.value].concat(n):t.is(Kc)&&(n=n.filter(i=>i!=t.value));return n},provide:n=>$t.computeN([n],e=>e.field(n))}),qc=L.define(),Kc=L.define();Le=class extends Ne{compare(e){return this==e||this.constructor==e.constructor&&this.eq(e)}eq(e){return!1}destroy(e){}};Le.prototype.elementClass="";Le.prototype.toDOM=void 0;Le.prototype.mapMode=ne.TrackBefore;Le.prototype.startSide=Le.prototype.endSide=-1;Le.prototype.point=!0;rs=A.define(),Mm=A.define(),Tm={class:"",renderEmptyElements:!1,elementStyle:"",markers:()=>H.empty,lineMarker:()=>null,widgetMarker:()=>null,lineMarkerChange:null,initialSpacer:null,updateSpacer:null,domEventHandlers:{},side:"before"},Ji=A.define();qo=A.define({combine:n=>n.some(e=>e)});Dm=_.fromClass(class{constructor(n){this.view=n,this.domAfter=null,this.prevViewport=n.viewport,this.dom=document.createElement("div"),this.dom.className="cm-gutters cm-gutters-before",this.dom.setAttribute("aria-hidden","true"),this.dom.style.minHeight=this.view.contentHeight/this.view.scaleY+"px",this.gutters=n.state.facet(Ji).map(e=>new ks(n,e)),this.fixed=!n.state.facet(qo);for(let e of this.gutters)e.config.side=="after"?this.getDOMAfter().appendChild(e.dom):this.dom.appendChild(e.dom);this.fixed&&(this.dom.style.position="sticky"),this.syncGutters(!1),n.scrollDOM.insertBefore(this.dom,n.contentDOM)}getDOMAfter(){return this.domAfter||(this.domAfter=document.createElement("div"),this.domAfter.className="cm-gutters cm-gutters-after",this.domAfter.setAttribute("aria-hidden","true"),this.domAfter.style.minHeight=this.view.contentHeight/this.view.scaleY+"px",this.domAfter.style.position=this.fixed?"sticky":"",this.view.scrollDOM.appendChild(this.domAfter)),this.domAfter}update(n){if(this.updateGutters(n)){let e=this.prevViewport,t=n.view.viewport,i=Math.min(e.to,t.to)-Math.max(e.from,t.from);this.syncGutters(i<(t.to-t.from)*.8)}if(n.geometryChanged){let e=this.view.contentHeight/this.view.scaleY+"px";this.dom.style.minHeight=e,this.domAfter&&(this.domAfter.style.minHeight=e)}this.view.state.facet(qo)!=!this.fixed&&(this.fixed=!this.fixed,this.dom.style.position=this.fixed?"sticky":"",this.domAfter&&(this.domAfter.style.position=this.fixed?"sticky":"")),this.prevViewport=n.view.viewport}syncGutters(n){let e=this.dom.nextSibling;n&&(this.dom.remove(),this.domAfter&&this.domAfter.remove());let t=H.iter(this.view.state.facet(rs),this.view.viewport.from),i=[],s=this.gutters.map(r=>new $o(r,this.view.viewport,-this.view.documentPadding.top));for(let r of this.view.viewportLineBlocks)if(i.length&&(i=[]),Array.isArray(r.type)){let o=!0;for(let l of r.type)if(l.type==ce.Text&&o){Ko(t,i,l.from);for(let a of s)a.line(this.view,l,i);o=!1}else if(l.widget)for(let a of s)a.widget(this.view,l)}else if(r.type==ce.Text){Ko(t,i,r.from);for(let o of s)o.line(this.view,r,i)}else if(r.widget)for(let o of s)o.widget(this.view,r);for(let r of s)r.finish();n&&(this.view.scrollDOM.insertBefore(this.dom,e),this.domAfter&&this.view.scrollDOM.appendChild(this.domAfter))}updateGutters(n){let e=n.startState.facet(Ji),t=n.state.facet(Ji),i=n.docChanged||n.heightChanged||n.viewportChanged||!H.eq(n.startState.facet(rs),n.state.facet(rs),n.view.viewport.from,n.view.viewport.to);if(e==t)for(let s of this.gutters)s.update(n)&&(i=!0);else{i=!0;let s=[];for(let r of t){let o=e.indexOf(r);o<0?s.push(new ks(this.view,r)):(this.gutters[o].update(n),s.push(this.gutters[o]))}for(let r of this.gutters)r.dom.remove(),s.indexOf(r)<0&&r.destroy();for(let r of s)r.config.side=="after"?this.getDOMAfter().appendChild(r.dom):this.dom.appendChild(r.dom);this.gutters=s}return i}destroy(){for(let n of this.gutters)n.destroy();this.dom.remove(),this.domAfter&&this.domAfter.remove()}},{provide:n=>M.scrollMargins.of(e=>{let t=e.plugin(n);if(!t||t.gutters.length==0||!t.fixed)return null;let i=t.dom.offsetWidth*e.scaleX,s=t.domAfter?t.domAfter.offsetWidth*e.scaleX:0;return e.textDirection==q.LTR?{left:i,right:s}:{right:i,left:s}})});$o=class{constructor(e,t,i){this.gutter=e,this.height=i,this.i=0,this.cursor=H.iter(e.markers,t.from)}addElement(e,t,i){let{gutter:s}=this,r=(t.top-this.height)/e.scaleY,o=t.height/e.scaleY;if(this.i==s.elements.length){let l=new vs(e,o,r,i);s.elements.push(l),s.dom.appendChild(l.dom)}else s.elements[this.i].update(e,o,r,i);this.height=t.bottom,this.i++}line(e,t,i){let s=[];Ko(this.cursor,s,t.from),i.length&&(s=s.concat(i));let r=this.gutter.config.lineMarker(e,t,s);r&&s.unshift(r);let o=this.gutter;s.length==0&&!o.config.renderEmptyElements||this.addElement(e,t,s)}widget(e,t){let i=this.gutter.config.widgetMarker(e,t.widget,t),s=i?[i]:null;for(let r of e.state.facet(Mm)){let o=r(e,t.widget,t);o&&(s||(s=[])).push(o)}s&&this.addElement(e,t,s)}finish(){let e=this.gutter;for(;e.elements.length>this.i;){let t=e.elements.pop();e.dom.removeChild(t.dom),t.destroy()}}},ks=class{constructor(e,t){this.view=e,this.config=t,this.elements=[],this.spacer=null,this.dom=document.createElement("div"),this.dom.className="cm-gutter"+(this.config.class?" "+this.config.class:"");for(let i in t.domEventHandlers)this.dom.addEventListener(i,s=>{let r=s.target,o;if(r!=this.dom&&this.dom.contains(r)){for(;r.parentNode!=this.dom;)r=r.parentNode;let a=r.getBoundingClientRect();o=(a.top+a.bottom)/2}else o=s.clientY;let l=e.lineBlockAtHeight(o-e.documentTop);t.domEventHandlers[i](e,l,s)&&s.preventDefault()});this.markers=Th(t.markers(e)),t.initialSpacer&&(this.spacer=new vs(e,0,0,[t.initialSpacer(e)]),this.dom.appendChild(this.spacer.dom),this.spacer.dom.style.cssText+="visibility: hidden; pointer-events: none")}update(e){let t=this.markers;if(this.markers=Th(this.config.markers(e.view)),this.spacer&&this.config.updateSpacer){let s=this.config.updateSpacer(this.spacer.markers[0],e);s!=this.spacer.markers[0]&&this.spacer.update(e.view,0,0,[s])}let i=e.view.viewport;return!H.eq(this.markers,t,i.from,i.to)||(this.config.lineMarkerChange?this.config.lineMarkerChange(e):!1)}destroy(){for(let e of this.elements)e.destroy()}},vs=class{constructor(e,t,i,s){this.height=-1,this.above=0,this.markers=[],this.dom=document.createElement("div"),this.dom.className="cm-gutterElement",this.update(e,t,i,s)}update(e,t,i,s){this.height!=t&&(this.height=t,this.dom.style.height=t+"px"),this.above!=i&&(this.dom.style.marginTop=(this.above=i)?i+"px":""),Om(this.markers,s)||this.setMarkers(e,s)}setMarkers(e,t){let i="cm-gutterElement",s=this.dom.firstChild;for(let r=0,o=0;;){let l=o,a=r<t.length?t[r++]:null,h=!1;if(a){let c=a.elementClass;c&&(i+=" "+c);for(let f=o;f<this.markers.length;f++)if(this.markers[f].compare(a)){l=f,h=!0;break}}else l=this.markers.length;for(;o<l;){let c=this.markers[o++];if(c.toDOM){c.destroy(s);let f=s.nextSibling;s.remove(),s=f}}if(!a)break;a.toDOM&&(h?s=s.nextSibling:this.dom.insertBefore(a.toDOM(e),s)),h&&o++}this.dom.className=i,this.markers=t}destroy(){this.setMarkers(null,[])}};Bm=A.define(),Lm=A.define(),ui=A.define({combine(n){return pe(n,{formatNumber:String,domEventHandlers:{}},{domEventHandlers(e,t){let i=Object.assign({},e);for(let s in t){let r=i[s],o=t[s];i[s]=r?(l,a,h)=>r(l,a,h)||o(l,a,h):o}return i}})}}),Qi=class extends Le{constructor(e){super(),this.number=e}eq(e){return this.number==e.number}toDOM(){return document.createTextNode(this.number)}};Em=Ji.compute([ui],n=>({class:"cm-lineNumbers",renderEmptyElements:!1,markers(e){return e.state.facet(Bm)},lineMarker(e,t,i){return i.some(s=>s.toDOM)?null:new Qi(jr(e,e.state.doc.lineAt(t.from).number))},widgetMarker:(e,t,i)=>{for(let s of e.state.facet(Lm)){let r=s(e,t,i);if(r)return r}return null},lineMarkerChange:e=>e.startState.facet(ui)!=e.state.facet(ui),initialSpacer(e){return new Qi(jr(e,Dh(e.state.doc.lines)))},updateSpacer(e,t){let i=jr(t.view,Dh(t.view.state.doc.lines));return i==e.number?e:new Qi(i)},domEventHandlers:n.facet(ui).domEventHandlers,side:"before"}));Rm=new class extends Le{constructor(){super(...arguments),this.elementClass="cm-activeLineGutter"}},Pm=rs.compute(["selection"],n=>{let e=[],t=-1;for(let i of n.selection.ranges){let s=n.doc.lineAt(i.head).from;s>t&&(t=s,e.push(Rm.range(s)))}return H.of(e)})});function Xc(n,e,t,i){switch(n){case-2:return t<e;case-1:return i>=e&&t<e;case 0:return t<e&&i>e;case 1:return t<=e&&i>e;case 2:return i>e;case 4:return!0}}function ln(n,e,t,i){for(var s;n.from==n.to||(t<1?n.from>=e:n.from>e)||(t>-1?n.to<=e:n.to<e);){let o=!i&&n instanceof nt&&n.index<0?null:n.parent;if(!o)return n;n=o}let r=i?0:Z.IgnoreOverlays;if(i)for(let o=n,l=o.parent;l;o=l,l=o.parent)o instanceof nt&&o.index<0&&((s=l.enter(e,t,r))===null||s===void 0?void 0:s.from)!=o.from&&(n=l);for(;;){let o=n.enter(e,t,r);if(!o)return n;n=o}}function _c(n,e,t,i){let s=n.cursor(),r=[];if(!s.firstChild())return r;if(t!=null){for(let o=!1;!o;)if(o=s.type.is(t),!s.nextSibling())return r}for(;;){if(i!=null&&s.type.is(i))return r;if(s.type.is(e)&&r.push(s.node),!s.nextSibling())return i==null?r:[]}}function sl(n,e,t=e.length-1){for(let i=n;t>=0;i=i.parent){if(!i)return!1;if(!i.type.isAnonymous){if(e[t]&&e[t]!=i.name)return!1;t--}}return!0}function Jc(n){if(!n.length)return null;let e=0,t=n[0];for(let r=1;r<n.length;r++){let o=n[r];(o.from>t.from||o.to<t.to)&&(t=o,e=r)}let i=t instanceof nt&&t.index<0?null:t.parent,s=n.slice();return i?s[e]=i:s.splice(e,1),new ol(s,t)}function Fm(n,e,t){let i=n.resolveInner(e,t),s=null;for(let r=i instanceof nt?i:i.context.parent;r;r=r.parent)if(r.index<0){let o=r.parent;(s||(s=[i])).push(o.resolve(e,t)),r=o}else{let o=jt.get(r.tree);if(o&&o.overlay&&o.overlay[0].from<=e&&o.overlay[o.overlay.length-1].to>=e){let l=new nt(o.tree,o.overlay[0].from+r.from,-1,r);(s||(s=[i])).push(ln(l,e,t,!1))}}return s?Jc(s):i}function al(n){return n.children.some(e=>e instanceof Ct||!e.type.isAnonymous||al(e))}function Hm(n){var e;let{buffer:t,nodeSet:i,maxBufferLength:s=1024,reused:r=[],minRepeatType:o=i.types.length}=n,l=Array.isArray(t)?new nl(t,t.length):t,a=i.types,h=0,c=0;function f(w,S,C,R,F,j){let{id:I,start:E,end:K,size:z}=l,Y=c,fe=h;if(z<0)if(l.next(),z==-1){let lt=r[I];C.push(lt),R.push(E-w);return}else if(z==-3){h=I;return}else if(z==-4){c=I;return}else throw new RangeError(`Unrecognized record size: ${z}`);let Te=a[I],Ze,le,Ie=E-w;if(K-E<=s&&(le=g(l.pos-S,F))){let lt=new Uint16Array(le.size-le.skip),ge=l.pos-le.size,$e=lt.length;for(;l.pos>ge;)$e=y(le.start,lt,$e);Ze=new Ct(lt,K-le.start,i),Ie=le.start-w}else{let lt=l.pos-z;l.next();let ge=[],$e=[],et=I>=o?I:-1,at=0,ti=K,Pi=Y;for(;l.pos>lt;)et>=0&&l.id==et&&l.size>=0?(l.end<=ti-s&&(p(ge,$e,E,at,l.end,ti,et,Pi,fe),at=ge.length,ti=l.end,Pi=c),l.next()):j>2500?u(E,lt,ge,$e):(et>=0&&l.size==-1&&r[l.id].type==i.types[et]&&(at<ge.length&&p(ge,$e,E,at,l.end,ti,et,Pi,fe),at=ge.length+1,ti=l.start,Pi=c),f(E,lt,ge,$e,et,j+1));if(et>=0&&at>0&&at<ge.length&&p(ge,$e,E,at,E,ti,et,Pi,fe),ge.reverse(),$e.reverse(),et>-1&&at>0){let ma=d(Te,fe);Ze=hl(Te,ge,$e,0,ge.length,0,K-E,ma,ma)}else Ze=m(Te,ge,$e,K-E,Y-K,fe)}C.push(Ze),R.push(Ie)}function u(w,S,C,R){let F=[],j=0,I=-1;for(;l.pos>S;){let{id:E,start:K,end:z,size:Y}=l;if(Y>4)l.next();else{if(I>-1&&K<I)break;I<0&&(I=z-s),F.push(E,K,z),j++,l.next()}}if(j){let E=new Uint16Array(j*4),K=F[F.length-2];for(let z=F.length-3,Y=0;z>=0;z-=3)E[Y++]=F[z],E[Y++]=F[z+1]-K,E[Y++]=F[z+2]-K,E[Y++]=Y;C.push(new Ct(E,F[2]-K,i)),R.push(K-w)}}function d(w,S){return(C,R,F)=>{let j=0,I=C.length-1,E,K;if(I>=0&&(E=C[I])instanceof J){if(!I&&E.type==w&&E.length==F)return E;(K=E.prop(P.lookAhead))&&(j=R[I]+E.length+K-F)}return m(w,C,R,F,j,S)}}function p(w,S,C,R,F,j,I,E,K){let z=[],Y=[];for(;w.length>R;)z.push(w.pop()),Y.push(S.pop()+C-F);w.push(m(i.types[I],z,Y,j-F,E-j,K)),S.push(F-C)}function m(w,S,C,R,F,j,I){if(j){let E=[P.contextHash,j];I=I?[E].concat(I):[E]}if(F>25){let E=[P.lookAhead,F];I=I?[E].concat(I):[E]}return new J(w,S,C,R,I)}function g(w,S){let C=l.fork(),R=0,F=0,j=0,I=C.end-s,E={size:0,start:0,skip:0};e:for(let K=C.pos-w;C.pos>K;){let z=C.size;if(C.id==S&&z>=0){E.size=R,E.start=F,E.skip=j,j+=4,R+=4,C.next();continue}let Y=C.pos-z;if(z<0||Y<K||C.start<I)break;let fe=C.id>=o?4:0,Te=C.start;for(C.next();C.pos>Y;){if(C.size<0)if(C.size==-3||C.size==-4)fe+=4;else break e;else C.id>=o&&(fe+=4);C.next()}F=Te,R+=z,j+=fe}return(S<0||R==w)&&(E.size=R,E.start=F,E.skip=j),E.size>4?E:void 0}function y(w,S,C){let{id:R,start:F,end:j,size:I}=l;if(l.next(),I>=0&&R<o){let E=C;if(I>4){let K=l.pos-(I-4);for(;l.pos>K;)C=y(w,S,C)}S[--C]=E,S[--C]=j-w,S[--C]=F-w,S[--C]=R}else I==-3?h=R:I==-4&&(c=R);return C}let k=[],x=[];for(;l.pos>0;)f(n.start||0,n.bufferStart||0,k,x,-1,0);let O=(e=n.length)!==null&&e!==void 0?e:k.length?x[0]+k[0].length:0;return new J(a[n.topID],k.reverse(),x.reverse(),O)}function Ts(n,e){if(!n.isAnonymous||e instanceof Ct||e.type!=n)return 1;let t=Yc.get(e);if(t==null){t=1;for(let i of e.children){if(i.type!=n||!(i instanceof J)){t=1;break}t+=Ts(n,i)}Yc.set(e,t)}return t}function hl(n,e,t,i,s,r,o,l,a){let h=0;for(let p=i;p<s;p++)h+=Ts(n,e[p]);let c=Math.ceil(h*1.5/8),f=[],u=[];function d(p,m,g,y,k){for(let x=g;x<y;){let O=x,w=m[x],S=Ts(n,p[x]);for(x++;x<y;x++){let C=Ts(n,p[x]);if(S+C>=c)break;S+=C}if(x==O+1){if(S>c){let C=p[O];d(C.children,C.positions,0,C.children.length,m[O]+k);continue}f.push(p[O])}else{let C=m[x-1]+p[x-1].length-w;f.push(hl(n,p,m,O,x,w,C,null,a))}u.push(w+k-r)}}return d(e,t,i,s,0),(l||a)(f,u,o)}var Im,on,P,jt,Nm,ve,Ds,Ms,Gc,Z,J,nl,Ct,Os,nt,rl,an,ol,hn,Yc,Ut,cn,ll,Qb,Bs=ye(()=>{Im=0,on=class{constructor(e,t){this.from=e,this.to=t}},P=class{constructor(e={}){this.id=Im++,this.perNode=!!e.perNode,this.deserialize=e.deserialize||(()=>{throw new Error("This node type doesn't define a deserialize function")}),this.combine=e.combine||null}add(e){if(this.perNode)throw new RangeError("Can't add per-node props to node types");return typeof e!="function"&&(e=ve.match(e)),t=>{let i=e(t);return i===void 0?null:[this,i]}}};P.closedBy=new P({deserialize:n=>n.split(" ")});P.openedBy=new P({deserialize:n=>n.split(" ")});P.group=new P({deserialize:n=>n.split(" ")});P.isolate=new P({deserialize:n=>{if(n&&n!="rtl"&&n!="ltr"&&n!="auto")throw new RangeError("Invalid value for isolate: "+n);return n||"auto"}});P.contextHash=new P({perNode:!0});P.lookAhead=new P({perNode:!0});P.mounted=new P({perNode:!0});jt=class{constructor(e,t,i,s=!1){this.tree=e,this.overlay=t,this.parser=i,this.bracketed=s}static get(e){return e&&e.props&&e.props[P.mounted.id]}},Nm=Object.create(null),ve=class n{constructor(e,t,i,s=0){this.name=e,this.props=t,this.id=i,this.flags=s}static define(e){let t=e.props&&e.props.length?Object.create(null):Nm,i=(e.top?1:0)|(e.skipped?2:0)|(e.error?4:0)|(e.name==null?8:0),s=new n(e.name||"",t,e.id,i);if(e.props){for(let r of e.props)if(Array.isArray(r)||(r=r(s)),r){if(r[0].perNode)throw new RangeError("Can't store a per-node prop on a node type");t[r[0].id]=r[1]}}return s}prop(e){return this.props[e.id]}get isTop(){return(this.flags&1)>0}get isSkipped(){return(this.flags&2)>0}get isError(){return(this.flags&4)>0}get isAnonymous(){return(this.flags&8)>0}is(e){if(typeof e=="string"){if(this.name==e)return!0;let t=this.prop(P.group);return t?t.indexOf(e)>-1:!1}return this.id==e}static match(e){let t=Object.create(null);for(let i in e)for(let s of i.split(" "))t[s]=e[i];return i=>{for(let s=i.prop(P.group),r=-1;r<(s?s.length:0);r++){let o=t[r<0?i.name:s[r]];if(o)return o}}}};ve.none=new ve("",Object.create(null),0,8);Ds=class n{constructor(e){this.types=e;for(let t=0;t<e.length;t++)if(e[t].id!=t)throw new RangeError("Node type ids should correspond to array positions when creating a node set")}extend(...e){let t=[];for(let i of this.types){let s=null;for(let r of e){let o=r(i);if(o){s||(s=Object.assign({},i.props));let l=o[1],a=o[0];a.combine&&a.id in s&&(l=a.combine(s[a.id],l)),s[a.id]=l}}t.push(s?new ve(i.name,s,i.id,i.flags):i)}return new n(t)}},Ms=new WeakMap,Gc=new WeakMap;(function(n){n[n.ExcludeBuffers=1]="ExcludeBuffers",n[n.IncludeAnonymous=2]="IncludeAnonymous",n[n.IgnoreMounts=4]="IgnoreMounts",n[n.IgnoreOverlays=8]="IgnoreOverlays",n[n.EnterBracketed=16]="EnterBracketed"})(Z||(Z={}));J=class n{constructor(e,t,i,s,r){if(this.type=e,this.children=t,this.positions=i,this.length=s,this.props=null,r&&r.length){this.props=Object.create(null);for(let[o,l]of r)this.props[typeof o=="number"?o:o.id]=l}}toString(){let e=jt.get(this);if(e&&!e.overlay)return e.tree.toString();let t="";for(let i of this.children){let s=i.toString();s&&(t&&(t+=","),t+=s)}return this.type.name?(/\W/.test(this.type.name)&&!this.type.isError?JSON.stringify(this.type.name):this.type.name)+(t.length?"("+t+")":""):t}cursor(e=0){return new hn(this.topNode,e)}cursorAt(e,t=0,i=0){let s=Ms.get(this)||this.topNode,r=new hn(s);return r.moveTo(e,t),Ms.set(this,r._tree),r}get topNode(){return new nt(this,0,0,null)}resolve(e,t=0){let i=ln(Ms.get(this)||this.topNode,e,t,!1);return Ms.set(this,i),i}resolveInner(e,t=0){let i=ln(Gc.get(this)||this.topNode,e,t,!0);return Gc.set(this,i),i}resolveStack(e,t=0){return Fm(this,e,t)}iterate(e){let{enter:t,leave:i,from:s=0,to:r=this.length}=e,o=e.mode||0,l=(o&Z.IncludeAnonymous)>0;for(let a=this.cursor(o|Z.IncludeAnonymous);;){let h=!1;if(a.from<=r&&a.to>=s&&(!l&&a.type.isAnonymous||t(a)!==!1)){if(a.firstChild())continue;h=!0}for(;h&&i&&(l||!a.type.isAnonymous)&&i(a),!a.nextSibling();){if(!a.parent())return;h=!0}}}prop(e){return e.perNode?this.props?this.props[e.id]:void 0:this.type.prop(e)}get propValues(){let e=[];if(this.props)for(let t in this.props)e.push([+t,this.props[t]]);return e}balance(e={}){return this.children.length<=8?this:hl(ve.none,this.children,this.positions,0,this.children.length,0,this.length,(t,i,s)=>new n(this.type,t,i,s,this.propValues),e.makeTree||((t,i,s)=>new n(ve.none,t,i,s)))}static build(e){return Hm(e)}};J.empty=new J(ve.none,[],[],0);nl=class n{constructor(e,t){this.buffer=e,this.index=t}get id(){return this.buffer[this.index-4]}get start(){return this.buffer[this.index-3]}get end(){return this.buffer[this.index-2]}get size(){return this.buffer[this.index-1]}get pos(){return this.index}next(){this.index-=4}fork(){return new n(this.buffer,this.index)}},Ct=class n{constructor(e,t,i){this.buffer=e,this.length=t,this.set=i}get type(){return ve.none}toString(){let e=[];for(let t=0;t<this.buffer.length;)e.push(this.childString(t)),t=this.buffer[t+3];return e.join(",")}childString(e){let t=this.buffer[e],i=this.buffer[e+3],s=this.set.types[t],r=s.name;if(/\W/.test(r)&&!s.isError&&(r=JSON.stringify(r)),e+=4,i==e)return r;let o=[];for(;e<i;)o.push(this.childString(e)),e=this.buffer[e+3];return r+"("+o.join(",")+")"}findChild(e,t,i,s,r){let{buffer:o}=this,l=-1;for(let a=e;a!=t&&!(Xc(r,s,o[a+1],o[a+2])&&(l=a,i>0));a=o[a+3]);return l}slice(e,t,i){let s=this.buffer,r=new Uint16Array(t-e),o=0;for(let l=e,a=0;l<t;){r[a++]=s[l++],r[a++]=s[l++]-i;let h=r[a++]=s[l++]-i;r[a++]=s[l++]-e,o=Math.max(o,h)}return new n(r,o,this.set)}};Os=class{cursor(e=0){return new hn(this,e)}getChild(e,t=null,i=null){let s=_c(this,e,t,i);return s.length?s[0]:null}getChildren(e,t=null,i=null){return _c(this,e,t,i)}resolve(e,t=0){return ln(this,e,t,!1)}resolveInner(e,t=0){return ln(this,e,t,!0)}matchContext(e){return sl(this.parent,e)}enterUnfinishedNodesBefore(e){let t=this.childBefore(e),i=this;for(;t;){let s=t.lastChild;if(!s||s.to!=t.to)break;s.type.isError&&s.from==s.to?(i=t,t=s.prevSibling):t=s}return i}get node(){return this}get next(){return this.parent}},nt=class n extends Os{constructor(e,t,i,s){super(),this._tree=e,this.from=t,this.index=i,this._parent=s}get type(){return this._tree.type}get name(){return this._tree.type.name}get to(){return this.from+this._tree.length}nextChild(e,t,i,s,r=0){for(let o=this;;){for(let{children:l,positions:a}=o._tree,h=t>0?l.length:-1;e!=h;e+=t){let c=l[e],f=a[e]+o.from,u;if(!(!(r&Z.EnterBracketed&&c instanceof J&&(u=jt.get(c))&&!u.overlay&&u.bracketed&&i>=f&&i<=f+c.length)&&!Xc(s,i,f,f+c.length))){if(c instanceof Ct){if(r&Z.ExcludeBuffers)continue;let d=c.findChild(0,c.buffer.length,t,i-f,s);if(d>-1)return new an(new rl(o,c,e,f),null,d)}else if(r&Z.IncludeAnonymous||!c.type.isAnonymous||al(c)){let d;if(!(r&Z.IgnoreMounts)&&(d=jt.get(c))&&!d.overlay)return new n(d.tree,f,e,o);let p=new n(c,f,e,o);return r&Z.IncludeAnonymous||!p.type.isAnonymous?p:p.nextChild(t<0?c.children.length-1:0,t,i,s,r)}}}if(r&Z.IncludeAnonymous||!o.type.isAnonymous||(o.index>=0?e=o.index+t:e=t<0?-1:o._parent._tree.children.length,o=o._parent,!o))return null}}get firstChild(){return this.nextChild(0,1,0,4)}get lastChild(){return this.nextChild(this._tree.children.length-1,-1,0,4)}childAfter(e){return this.nextChild(0,1,e,2)}childBefore(e){return this.nextChild(this._tree.children.length-1,-1,e,-2)}prop(e){return this._tree.prop(e)}enter(e,t,i=0){let s;if(!(i&Z.IgnoreOverlays)&&(s=jt.get(this._tree))&&s.overlay){let r=e-this.from,o=i&Z.EnterBracketed&&s.bracketed;for(let{from:l,to:a}of s.overlay)if((t>0||o?l<=r:l<r)&&(t<0||o?a>=r:a>r))return new n(s.tree,s.overlay[0].from+this.from,-1,this)}return this.nextChild(0,1,e,t,i)}nextSignificantParent(){let e=this;for(;e.type.isAnonymous&&e._parent;)e=e._parent;return e}get parent(){return this._parent?this._parent.nextSignificantParent():null}get nextSibling(){return this._parent&&this.index>=0?this._parent.nextChild(this.index+1,1,0,4):null}get prevSibling(){return this._parent&&this.index>=0?this._parent.nextChild(this.index-1,-1,0,4):null}get tree(){return this._tree}toTree(){return this._tree}toString(){return this._tree.toString()}};rl=class{constructor(e,t,i,s){this.parent=e,this.buffer=t,this.index=i,this.start=s}},an=class n extends Os{get name(){return this.type.name}get from(){return this.context.start+this.context.buffer.buffer[this.index+1]}get to(){return this.context.start+this.context.buffer.buffer[this.index+2]}constructor(e,t,i){super(),this.context=e,this._parent=t,this.index=i,this.type=e.buffer.set.types[e.buffer.buffer[i]]}child(e,t,i){let{buffer:s}=this.context,r=s.findChild(this.index+4,s.buffer[this.index+3],e,t-this.context.start,i);return r<0?null:new n(this.context,this,r)}get firstChild(){return this.child(1,0,4)}get lastChild(){return this.child(-1,0,4)}childAfter(e){return this.child(1,e,2)}childBefore(e){return this.child(-1,e,-2)}prop(e){return this.type.prop(e)}enter(e,t,i=0){if(i&Z.ExcludeBuffers)return null;let{buffer:s}=this.context,r=s.findChild(this.index+4,s.buffer[this.index+3],t>0?1:-1,e-this.context.start,t);return r<0?null:new n(this.context,this,r)}get parent(){return this._parent||this.context.parent.nextSignificantParent()}externalSibling(e){return this._parent?null:this.context.parent.nextChild(this.context.index+e,e,0,4)}get nextSibling(){let{buffer:e}=this.context,t=e.buffer[this.index+3];return t<(this._parent?e.buffer[this._parent.index+3]:e.buffer.length)?new n(this.context,this._parent,t):this.externalSibling(1)}get prevSibling(){let{buffer:e}=this.context,t=this._parent?this._parent.index+4:0;return this.index==t?this.externalSibling(-1):new n(this.context,this._parent,e.findChild(t,this.index,-1,0,4))}get tree(){return null}toTree(){let e=[],t=[],{buffer:i}=this.context,s=this.index+4,r=i.buffer[this.index+3];if(r>s){let o=i.buffer[this.index+1];e.push(i.slice(s,r,o)),t.push(0)}return new J(this.type,e,t,this.to-this.from)}toString(){return this.context.buffer.childString(this.index)}};ol=class{constructor(e,t){this.heads=e,this.node=t}get next(){return Jc(this.heads)}};hn=class{get name(){return this.type.name}constructor(e,t=0){if(this.buffer=null,this.stack=[],this.index=0,this.bufferNode=null,this.mode=t&~Z.EnterBracketed,e instanceof nt)this.yieldNode(e);else{this._tree=e.context.parent,this.buffer=e.context;for(let i=e._parent;i;i=i._parent)this.stack.unshift(i.index);this.bufferNode=e,this.yieldBuf(e.index)}}yieldNode(e){return e?(this._tree=e,this.type=e.type,this.from=e.from,this.to=e.to,!0):!1}yieldBuf(e,t){this.index=e;let{start:i,buffer:s}=this.buffer;return this.type=t||s.set.types[s.buffer[e]],this.from=i+s.buffer[e+1],this.to=i+s.buffer[e+2],!0}yield(e){return e?e instanceof nt?(this.buffer=null,this.yieldNode(e)):(this.buffer=e.context,this.yieldBuf(e.index,e.type)):!1}toString(){return this.buffer?this.buffer.buffer.childString(this.index):this._tree.toString()}enterChild(e,t,i){if(!this.buffer)return this.yield(this._tree.nextChild(e<0?this._tree._tree.children.length-1:0,e,t,i,this.mode));let{buffer:s}=this.buffer,r=s.findChild(this.index+4,s.buffer[this.index+3],e,t-this.buffer.start,i);return r<0?!1:(this.stack.push(this.index),this.yieldBuf(r))}firstChild(){return this.enterChild(1,0,4)}lastChild(){return this.enterChild(-1,0,4)}childAfter(e){return this.enterChild(1,e,2)}childBefore(e){return this.enterChild(-1,e,-2)}enter(e,t,i=this.mode){return this.buffer?i&Z.ExcludeBuffers?!1:this.enterChild(1,e,t):this.yield(this._tree.enter(e,t,i))}parent(){if(!this.buffer)return this.yieldNode(this.mode&Z.IncludeAnonymous?this._tree._parent:this._tree.parent);if(this.stack.length)return this.yieldBuf(this.stack.pop());let e=this.mode&Z.IncludeAnonymous?this.buffer.parent:this.buffer.parent.nextSignificantParent();return this.buffer=null,this.yieldNode(e)}sibling(e){if(!this.buffer)return this._tree._parent?this.yield(this._tree.index<0?null:this._tree._parent.nextChild(this._tree.index+e,e,0,4,this.mode)):!1;let{buffer:t}=this.buffer,i=this.stack.length-1;if(e<0){let s=i<0?0:this.stack[i]+4;if(this.index!=s)return this.yieldBuf(t.findChild(s,this.index,-1,0,4))}else{let s=t.buffer[this.index+3];if(s<(i<0?t.buffer.length:t.buffer[this.stack[i]+3]))return this.yieldBuf(s)}return i<0?this.yield(this.buffer.parent.nextChild(this.buffer.index+e,e,0,4,this.mode)):!1}nextSibling(){return this.sibling(1)}prevSibling(){return this.sibling(-1)}atLastNode(e){let t,i,{buffer:s}=this;if(s){if(e>0){if(this.index<s.buffer.buffer.length)return!1}else for(let r=0;r<this.index;r++)if(s.buffer.buffer[r+3]<this.index)return!1;({index:t,parent:i}=s)}else({index:t,_parent:i}=this._tree);for(;i;{index:t,_parent:i}=i)if(t>-1)for(let r=t+e,o=e<0?-1:i._tree.children.length;r!=o;r+=e){let l=i._tree.children[r];if(this.mode&Z.IncludeAnonymous||l instanceof Ct||!l.type.isAnonymous||al(l))return!1}return!0}move(e,t){if(t&&this.enterChild(e,0,4))return!0;for(;;){if(this.sibling(e))return!0;if(this.atLastNode(e)||!this.parent())return!1}}next(e=!0){return this.move(1,e)}prev(e=!0){return this.move(-1,e)}moveTo(e,t=0){for(;(this.from==this.to||(t<1?this.from>=e:this.from>e)||(t>-1?this.to<=e:this.to<e))&&this.parent(););for(;this.enterChild(1,e,t););return this}get node(){if(!this.buffer)return this._tree;let e=this.bufferNode,t=null,i=0;if(e&&e.context==this.buffer)e:for(let s=this.index,r=this.stack.length;r>=0;){for(let o=e;o;o=o._parent)if(o.index==s){if(s==this.index)return o;t=o,i=r+1;break e}s=this.stack[--r]}for(let s=i;s<this.stack.length;s++)t=new an(this.buffer,t,this.stack[s]);return this.bufferNode=new an(this.buffer,t,this.index)}get tree(){return this.buffer?null:this._tree._tree}iterate(e,t){for(let i=0;;){let s=!1;if(this.type.isAnonymous||e(this)!==!1){if(this.firstChild()){i++;continue}this.type.isAnonymous||(s=!0)}for(;;){if(s&&t&&t(this),s=this.type.isAnonymous,!i)return;if(this.nextSibling())break;this.parent(),i--,s=!0}}}matchContext(e){if(!this.buffer)return sl(this.node.parent,e);let{buffer:t}=this.buffer,{types:i}=t.set;for(let s=e.length-1,r=this.stack.length-1;s>=0;r--){if(r<0)return sl(this._tree,e,s);let o=i[t.buffer[this.stack[r]]];if(!o.isAnonymous){if(e[s]&&e[s]!=o.name)return!1;s--}}return!0}};Yc=new WeakMap;Ut=class n{constructor(e,t,i,s,r=!1,o=!1){this.from=e,this.to=t,this.tree=i,this.offset=s,this.open=(r?1:0)|(o?2:0)}get openStart(){return(this.open&1)>0}get openEnd(){return(this.open&2)>0}static addTree(e,t=[],i=!1){let s=[new n(0,e.length,e,0,!1,i)];for(let r of t)r.to>e.length&&s.push(r);return s}static applyChanges(e,t,i=128){if(!t.length)return e;let s=[],r=1,o=e.length?e[0]:null;for(let l=0,a=0,h=0;;l++){let c=l<t.length?t[l]:null,f=c?c.fromA:1e9;if(f-a>=i)for(;o&&o.from<f;){let u=o;if(a>=u.from||f<=u.to||h){let d=Math.max(u.from,a)-h,p=Math.min(u.to,f)-h;u=d>=p?null:new n(d,p,u.tree,u.offset+h,l>0,!!c)}if(u&&s.push(u),o.to>f)break;o=r<e.length?e[r++]:null}if(!c)break;a=c.toA,h=c.toA-c.toB}return s}},cn=class{startParse(e,t,i){return typeof e=="string"&&(e=new ll(e)),i=i?i.length?i.map(s=>new on(s.from,s.to)):[new on(0,0)]:[new on(0,e.length)],this.createParse(e,t||[],i)}parse(e,t,i){let s=this.startParse(e,t,i);for(;;){let r=s.advance();if(r)return r}}},ll=class{constructor(e){this.string=e}get length(){return this.string.length}chunk(e){return this.string.slice(e)}get lineChunks(){return!1}read(e,t){return this.string.slice(e,t)}},Qb=new P({perNode:!0})});function zm(n,e){return n.length==e.length&&n.every((t,i)=>t==e[i])}function qm(n){let e=[[]];for(let t=0;t<n.length;t++)for(let i=0,s=e.length;i<s;i++)e.push(e[i].concat(n[t]));return e.sort((t,i)=>i.length-t.length)}function ef(n){let e=Object.create(null);for(let t in n){let i=n[t];Array.isArray(i)||(i=[i]);for(let s of t.split(" "))if(s){let r=[],o=2,l=s;for(let f=0;;){if(l=="..."&&f>0&&f+3==s.length){o=1;break}let u=/^"(?:[^"\\]|\\.)*?"|[^\/!]+/.exec(l);if(!u)throw new RangeError("Invalid path: "+s);if(r.push(u[0]=="*"?"":u[0][0]=='"'?JSON.parse(u[0]):u[0]),f+=u[0].length,f==s.length)break;let d=s[f++];if(f==s.length&&d=="!"){o=0;break}if(d!="/")throw new RangeError("Invalid path: "+s);l=s.slice(f)}let a=r.length-1,h=r[a];if(!h)throw new RangeError("Invalid path: "+s);let c=new _t(i,o,a>0?r.slice(0,a):null);e[h]=c.sort(e[h])}}return tf.add(e)}function dl(n,e){let t=Object.create(null);for(let r of n)if(!Array.isArray(r.tag))t[r.tag.id]=r.class;else for(let o of r.tag)t[o.id]=r.class;let{scope:i,all:s=null}=e||{};return{style:r=>{let o=s;for(let l of r)for(let a of l.set){let h=t[a.id];if(h){o=o?o+" "+h:h;break}}return o},scope:i}}function Km(n,e){let t=null;for(let i of n){let s=i.style(e);s&&(t=t?t+" "+s:s)}return t}function nf(n,e,t,i=0,s=n.length){let r=new fl(i,Array.isArray(e)?e:[e],t);r.highlightRange(n.cursor(),i,s,"",r.highlighters),r.flush(s)}function $m(n){let e=n.type.prop(tf);for(;e&&e.context&&!n.matchContext(e.context);)e=e.next;return e||null}var Wm,_e,Vm,Ps,tf,_t,fl,T,Ls,At,Qc,Zc,Mt,Es,cl,ot,Gt,st,rt,ul,fn,Rs,v,t1,pl=ye(()=>{Bs();Wm=0,_e=class n{constructor(e,t,i,s){this.name=e,this.set=t,this.base=i,this.modified=s,this.id=Wm++}toString(){let{name:e}=this;for(let t of this.modified)t.name&&(e=`${t.name}(${e})`);return e}static define(e,t){let i=typeof e=="string"?e:"?";if(e instanceof n&&(t=e),t?.base)throw new Error("Can not derive from a modified tag");let s=new n(i,[],null,[]);if(s.set.push(s),t)for(let r of t.set)s.set.push(r);return s}static defineModifier(e){let t=new Ps(e);return i=>i.modified.indexOf(t)>-1?i:Ps.get(i.base||i,i.modified.concat(t).sort((s,r)=>s.id-r.id))}},Vm=0,Ps=class n{constructor(e){this.name=e,this.instances=[],this.id=Vm++}static get(e,t){if(!t.length)return e;let i=t[0].instances.find(l=>l.base==e&&zm(t,l.modified));if(i)return i;let s=[],r=new _e(e.name,s,e,t);for(let l of t)l.instances.push(r);let o=qm(t);for(let l of e.set)if(!l.modified.length)for(let a of o)s.push(n.get(l,a));return r}};tf=new P({combine(n,e){let t,i,s;for(;n||e;){if(!n||e&&n.depth<=e.depth?(s=e,e=e.next):(s=n,n=n.next),t&&t.mode==s.mode&&!s.context&&!t.context)continue;let r=new _t(s.tags,s.mode,s.context);t?t.next=r:i=r,t=r}return i}}),_t=class{constructor(e,t,i,s){this.tags=e,this.mode=t,this.context=i,this.next=s}get opaque(){return this.mode==0}get inherit(){return this.mode==1}sort(e){return!e||e.depth<this.depth?(this.next=e,this):(e.next=this.sort(e.next),e)}get depth(){return this.context?this.context.length:0}};_t.empty=new _t([],2,null);fl=class{constructor(e,t,i){this.at=e,this.highlighters=t,this.span=i,this.class=""}startSpan(e,t){t!=this.class&&(this.flush(e),e>this.at&&(this.at=e),this.class=t)}flush(e){e>this.at&&this.class&&this.span(this.at,e,this.class)}highlightRange(e,t,i,s,r){let{type:o,from:l,to:a}=e;if(l>=i||a<=t)return;o.isTop&&(r=this.highlighters.filter(d=>!d.scope||d.scope(o)));let h=s,c=$m(e)||_t.empty,f=Km(r,c.tags);if(f&&(h&&(h+=" "),h+=f,c.mode==1&&(s+=(s?" ":"")+f)),this.startSpan(Math.max(t,l),h),c.opaque)return;let u=e.tree&&e.tree.prop(P.mounted);if(u&&u.overlay){let d=e.node.enter(u.overlay[0].from+l,1),p=this.highlighters.filter(g=>!g.scope||g.scope(u.tree.type)),m=e.firstChild();for(let g=0,y=l;;g++){let k=g<u.overlay.length?u.overlay[g]:null,x=k?k.from+l:a,O=Math.max(t,y),w=Math.min(i,x);if(O<w&&m)for(;e.from<w&&(this.highlightRange(e,O,w,s,r),this.startSpan(Math.min(w,e.to),h),!(e.to>=x||!e.nextSibling())););if(!k||x>i)break;y=k.to+l,y>t&&(this.highlightRange(d.cursor(),Math.max(t,k.from+l),Math.min(i,y),"",p),this.startSpan(Math.min(i,y),h))}m&&e.parent()}else if(e.firstChild()){u&&(s="");do if(!(e.to<=t)){if(e.from>=i)break;this.highlightRange(e,t,i,s,r),this.startSpan(Math.min(i,e.to),h)}while(e.nextSibling());e.parent()}}};T=_e.define,Ls=T(),At=T(),Qc=T(At),Zc=T(At),Mt=T(),Es=T(Mt),cl=T(Mt),ot=T(),Gt=T(ot),st=T(),rt=T(),ul=T(),fn=T(ul),Rs=T(),v={comment:Ls,lineComment:T(Ls),blockComment:T(Ls),docComment:T(Ls),name:At,variableName:T(At),typeName:Qc,tagName:T(Qc),propertyName:Zc,attributeName:T(Zc),className:T(At),labelName:T(At),namespace:T(At),macroName:T(At),literal:Mt,string:Es,docString:T(Es),character:T(Es),attributeValue:T(Es),number:cl,integer:T(cl),float:T(cl),bool:T(Mt),regexp:T(Mt),escape:T(Mt),color:T(Mt),url:T(Mt),keyword:st,self:T(st),null:T(st),atom:T(st),unit:T(st),modifier:T(st),operatorKeyword:T(st),controlKeyword:T(st),definitionKeyword:T(st),moduleKeyword:T(st),operator:rt,derefOperator:T(rt),arithmeticOperator:T(rt),logicOperator:T(rt),bitwiseOperator:T(rt),compareOperator:T(rt),updateOperator:T(rt),definitionOperator:T(rt),typeOperator:T(rt),controlOperator:T(rt),punctuation:ul,separator:T(ul),bracket:fn,angleBracket:T(fn),squareBracket:T(fn),paren:T(fn),brace:T(fn),content:ot,heading:Gt,heading1:T(Gt),heading2:T(Gt),heading3:T(Gt),heading4:T(Gt),heading5:T(Gt),heading6:T(Gt),contentSeparator:T(ot),list:T(ot),quote:T(ot),emphasis:T(ot),strong:T(ot),link:T(ot),monospace:T(ot),strikethrough:T(ot),inserted:T(),deleted:T(),changed:T(),invalid:T(),meta:Rs,documentMeta:T(Rs),annotation:T(Rs),processingInstruction:T(Rs),definition:_e.defineModifier("definition"),constant:_e.defineModifier("constant"),function:_e.defineModifier("function"),standard:_e.defineModifier("standard"),local:_e.defineModifier("local"),special:_e.defineModifier("special")};for(let n in v){let e=v[n];e instanceof _e&&(e.name=n)}t1=dl([{tag:v.link,class:"tok-link"},{tag:v.heading,class:"tok-heading"},{tag:v.emphasis,class:"tok-emphasis"},{tag:v.strong,class:"tok-strong"},{tag:v.keyword,class:"tok-keyword"},{tag:v.atom,class:"tok-atom"},{tag:v.bool,class:"tok-bool"},{tag:v.url,class:"tok-url"},{tag:v.labelName,class:"tok-labelName"},{tag:v.inserted,class:"tok-inserted"},{tag:v.deleted,class:"tok-deleted"},{tag:v.literal,class:"tok-literal"},{tag:v.string,class:"tok-string"},{tag:v.number,class:"tok-number"},{tag:[v.regexp,v.escape,v.special(v.string)],class:"tok-string2"},{tag:v.variableName,class:"tok-variableName"},{tag:v.local(v.variableName),class:"tok-variableName tok-local"},{tag:v.definition(v.variableName),class:"tok-variableName tok-definition"},{tag:v.special(v.variableName),class:"tok-variableName2"},{tag:v.definition(v.propertyName),class:"tok-propertyName tok-definition"},{tag:v.typeName,class:"tok-typeName"},{tag:v.namespace,class:"tok-namespace"},{tag:v.className,class:"tok-className"},{tag:v.macroName,class:"tok-macroName"},{tag:v.propertyName,class:"tok-propertyName"},{tag:v.operator,class:"tok-operator"},{tag:v.comment,class:"tok-comment"},{tag:v.meta,class:"tok-meta"},{tag:v.invalid,class:"tok-invalid"},{tag:v.punctuation,class:"tok-punctuation"}])});function sf(n,e,t,i=0,s=0){e==null&&(e=n.search(/[^\s\u00a0]/),e==-1&&(e=n.length));let r=s;for(let o=i;o<e;o++)n.charCodeAt(o)==9?r+=t-r%t:r++;return r}var un,rf=ye(()=>{un=class{constructor(e,t,i,s){this.string=e,this.tabSize=t,this.indentUnit=i,this.overrideIndent=s,this.pos=0,this.start=0,this.lastColumnPos=0,this.lastColumnValue=0}eol(){return this.pos>=this.string.length}sol(){return this.pos==0}peek(){return this.string.charAt(this.pos)||void 0}next(){if(this.pos<this.string.length)return this.string.charAt(this.pos++)}eat(e){let t=this.string.charAt(this.pos),i;if(typeof e=="string"?i=t==e:i=t&&(e instanceof RegExp?e.test(t):e(t)),i)return++this.pos,t}eatWhile(e){let t=this.pos;for(;this.eat(e););return this.pos>t}eatSpace(){let e=this.pos;for(;/[\s\u00a0]/.test(this.string.charAt(this.pos));)++this.pos;return this.pos>e}skipToEnd(){this.pos=this.string.length}skipTo(e){let t=this.string.indexOf(e,this.pos);if(t>-1)return this.pos=t,!0}backUp(e){this.pos-=e}column(){return this.lastColumnPos<this.start&&(this.lastColumnValue=sf(this.string,this.start,this.tabSize,this.lastColumnPos,this.lastColumnValue),this.lastColumnPos=this.start),this.lastColumnValue}indentation(){var e;return(e=this.overrideIndent)!==null&&e!==void 0?e:sf(this.string,null,this.tabSize)}match(e,t,i){if(typeof e=="string"){let s=o=>i?o.toLowerCase():o,r=this.string.substr(this.pos,e.length);return s(r)==s(e)?(t!==!1&&(this.pos+=e.length),!0):null}else{let s=this.string.slice(this.pos).match(e);return s&&s.index>0?null:(s&&t!==!1&&(this.pos+=s[0].length),s)}}current(){return this.string.slice(this.start,this.pos)}}});function jm(n){return A.define({combine:n?e=>e.concat(n):void 0})}function of(n,e,t){let i=n.facet(Tt),s=re(n).topNode;if(!i||i.allowsNesting)for(let r=s;r;r=r.enter(e,t,Z.ExcludeBuffers|Z.EnterBracketed))r.type.isTop&&(s=r);return s}function re(n){let e=n.field(Ee.state,!1);return e?e.tree:J.empty}function lf(n,e,t){return Ut.applyChanges(n,[{fromA:e,toA:t,fromB:e,toB:t}])}function Dt(n){let e=n.facet(Mi);return e.charCodeAt(0)==9?n.tabSize*e.length:e.length}function Ti(n,e){let t="",i=n.tabSize,s=n.facet(Mi)[0];if(s=="	"){for(;e>=i;)t+="	",e-=i;s=" "}for(let r=0;r<e;r++)t+=s;return t}function Ws(n,e){n instanceof W&&(n=new Yt(n));for(let i of n.state.facet(_m)){let s=i(n,e);if(s!==void 0)return s}let t=re(n.state);return t.length>=e?Ym(n,t,e):null}function Ym(n,e,t){let i=e.resolveStack(t),s=e.resolveInner(t,-1).resolve(t,0).enterUnfinishedNodesBefore(t);if(s!=i.node){let r=[];for(let o=s;o&&!(o.from<i.node.from||o.to>i.node.to||o.from==i.node.from&&o.type==i.node.type);o=o.parent)r.push(o);for(let o=r.length-1;o>=0;o--)i={node:r[o],next:i}}return gf(i,n,t)}function gf(n,e,t){for(let i=n;i;i=i.next){let s=Jm(i.node);if(s)return s(wl.create(e,t,i))}return 0}function Xm(n){return n.pos==n.options.simulateBreak&&n.options.simulateDoubleBreak}function Jm(n){let e=n.type.prop(mf);if(e)return e;let t=n.firstChild,i;if(t&&(i=t.type.prop(P.closedBy))){let s=n.lastChild,r=s&&i.indexOf(s.name)>-1;return o=>tg(o,!0,1,void 0,r&&!Xm(o)?s.from:void 0)}return n.parent==null?Qm:null}function Qm(){return 0}function Zm(n,e){for(let t=e;t;t=t.parent)if(n==t)return!0;return!1}function eg(n){let e=n.node,t=e.childAfter(e.from),i=e.lastChild;if(!t)return null;let s=n.options.simulateBreak,r=n.state.doc.lineAt(t.from),o=s==null||s<=r.from?r.to:Math.min(r.to,s);for(let l=t.to;;){let a=e.childAfter(l);if(!a||a==i)return null;if(!a.type.isSkipped){if(a.from>=o)return null;let h=/^ */.exec(r.text.slice(t.to-r.from))[0].length;return{from:t.from,to:t.to+h}}l=a.to}}function tg(n,e,t,i,s){let r=n.textAfter,o=r.match(/^\s*/)[0].length,l=i&&r.slice(o,o+i.length)==i||s==n.pos+o,a=e?eg(n):null;return a?l?n.column(a.from):n.column(a.to):n.baseIndent+(l?0:n.unit*t)}function Vs(){return W.transactionFilter.of(n=>{if(!n.docChanged||!n.isUserEvent("input.type")&&!n.isUserEvent("input.complete"))return n;let e=n.startState.languageDataAt("indentOnInput",n.startState.selection.main.head);if(!e.length)return n;let t=n.newDoc,{head:i}=n.newSelection.main,s=t.lineAt(i);if(i>s.from+ig)return n;let r=t.sliceString(s.from,i);if(!e.some(h=>h.test(r)))return n;let{state:o}=n,l=-1,a=[];for(let{head:h}of o.selection.ranges){let c=o.doc.lineAt(h);if(c.from==l)continue;l=c.from;let f=Ws(o,c.from);if(f==null)continue;let u=/^\s*/.exec(c.text)[0],d=Ti(o,f);u!=d&&a.push({from:c.from,to:c.from+u.length,insert:d})}return a.length?[n,{changes:a,sequential:!0}]:n})}function rg(n,e,t){let i=re(n);if(i.length<t)return null;let s=i.resolveStack(t,1),r=null;for(let o=s;o;o=o.next){let l=o.node;if(l.to<=t||l.from>t)continue;if(r&&l.from<e)break;let a=l.type.prop(sg);if(a&&(l.to<i.length-50||i.length==n.doc.length||!og(l))){let h=a(l,n);h&&h.from<=t&&h.from>=e&&h.to>t&&(r=h)}}return r}function og(n){let e=n.lastChild;return e&&e.to==n.to&&e.type.isError}function Is(n,e,t){for(let i of n.facet(ng)){let s=i(n,e,t);if(s)return s}return rg(n,e,t)}function yf(n,e){let t=e.mapPos(n.from,1),i=e.mapPos(n.to,-1);return t>=i?void 0:{from:t,to:i}}function bf(n){let e=[];for(let{head:t}of n.state.selection.ranges)e.some(i=>i.from<=t&&i.to>=t)||e.push(n.lineBlockAt(t));return e}function af(n,e,t=e){let i=!1;return n.between(e,t,(s,r)=>{s<t&&r>e&&(i=!0)}),i?n.update({filterFrom:e,filterTo:t,filter:(s,r)=>s>=t||r<=e}):n}function Ns(n,e,t){var i;let s=null;return(i=n.field(Xt,!1))===null||i===void 0||i.between(e,t,(r,o)=>{(!s||s.from>r)&&(s={from:r,to:o})}),s}function lg(n,e,t){let i=!1;return n.between(e,e,(s,r)=>{s==e&&r==t&&(i=!0)}),i}function xf(n,e){return n.field(Xt,!1)?e:e.concat(L.appendConfig.of(vf()))}function wf(n,e,t=!0){let i=n.state.doc.lineAt(e.from).number,s=n.state.doc.lineAt(e.to).number;return M.announce.of(`${n.state.phrase(t?"Folded lines":"Unfolded lines")} ${i} ${n.state.phrase("to")} ${s}.`)}function vf(n){let e=[Xt,pg];return n&&e.push(Tl.of(n)),e}function Sf(n,e){let{state:t}=n,i=t.facet(Tl),s=o=>{let l=n.lineBlockAt(n.posAtDOM(o.target)),a=Ns(n.state,l.from,l.to);a&&n.dispatch({effects:bn.of(a)}),o.preventDefault()};if(i.placeholderDOM)return i.placeholderDOM(n,s,e);let r=document.createElement("span");return r.textContent=i.placeholderText,r.setAttribute("aria-label",t.phrase("folded code")),r.title=t.phrase("unfold"),r.className="cm-foldPlaceholder",r.onclick=s,r}function Cf(n={}){let e={...dg,...n},t=new pn(e,!0),i=new pn(e,!1),s=_.fromClass(class{constructor(o){this.from=o.viewport.from,this.markers=this.buildMarkers(o)}update(o){(o.docChanged||o.viewportChanged||o.startState.facet(Tt)!=o.state.facet(Tt)||o.startState.field(Xt,!1)!=o.state.field(Xt,!1)||re(o.startState)!=re(o.state)||e.foldingChanged(o))&&(this.markers=this.buildMarkers(o.view))}buildMarkers(o){let l=new de;for(let a of o.viewportLineBlocks){let h=Ns(o.state,a.from,a.to)?i:Is(o.state,a.from,a.to)?t:null;h&&l.add(a.from,a.from,h)}return l.finish()}}),{domEventHandlers:r}=e;return[s,il({class:"cm-foldGutter",markers(o){var l;return((l=o.plugin(s))===null||l===void 0?void 0:l.markers)||H.empty},initialSpacer(){return new pn(e,!1)},domEventHandlers:{...r,click:(o,l,a)=>{if(r.click&&r.click(o,l,a))return!0;let h=Ns(o.state,l.from,l.to);if(h)return o.dispatch({effects:bn.of(h)}),!0;let c=Is(o.state,l.from,l.to);return c?(o.dispatch({effects:zs.of(c)}),!0):!1}}}),vf()]}function yl(n){let e=n.facet(vl);return e.length?e:n.facet(Af)}function qs(n,e){let t=[mg],i;return n instanceof Ai&&(n.module&&t.push(M.styleModule.of(n.module)),i=n.themeType),e?.fallback?t.push(Af.of(n)):i?t.push(vl.computeN([M.darkTheme],s=>s.facet(M.darkTheme)==(i=="dark")?[n]:[])):t.push(vl.of(n)),t}function xg(n){let e=[],t=n.matched?yg:bg;return e.push(t.range(n.start.from,n.start.to)),n.end&&e.push(t.range(n.end.from,n.end.to)),e}function cf(n){let e=[],t=n.facet(Of);for(let i of n.selection.ranges){if(!i.empty)continue;let s=Ye(n,i.head,-1,t)||i.head>0&&Ye(n,i.head-1,1,t)||t.afterCursor&&(Ye(n,i.head,1,t)||i.head<n.doc.length&&Ye(n,i.head+1,-1,t));s&&(e=e.concat(t.renderMatch(s,n)))}return B.set(e,!0)}function Bf(n={}){return[Of.of(n),kg]}function Cl(n,e,t){let i=n.prop(e<0?P.openedBy:P.closedBy);if(i)return i;if(n.name.length==1){let s=t.indexOf(n.name);if(s>-1&&s%2==(e<0?1:0))return[t[s+e]]}return null}function Al(n){let e=n.type.prop(vg);return e?e(n.node):n}function Ye(n,e,t,i={}){let s=i.maxScanDistance||Tf,r=i.brackets||Df,o=re(n),l=o.resolveInner(e,t);for(let a=l;a;a=a.parent){let h=Cl(a.type,t,r);if(h&&a.from<a.to){let c=Al(a);if(c&&(t>0?e>=c.from&&e<c.to:e>c.from&&e<=c.to))return Sg(n,e,t,a,c,h,r)}}return Cg(n,e,t,o,l.type,s,r)}function Sg(n,e,t,i,s,r,o){let l=i.parent,a={from:s.from,to:s.to},h=0,c=l?.cursor();if(c&&(t<0?c.childBefore(i.from):c.childAfter(i.to)))do if(t<0?c.to<=i.from:c.from>=i.to){if(h==0&&r.indexOf(c.type.name)>-1&&c.from<c.to){let f=Al(c);return{start:a,end:f?{from:f.from,to:f.to}:void 0,matched:!0}}else if(Cl(c.type,t,o))h++;else if(Cl(c.type,-t,o)){if(h==0){let f=Al(c);return{start:a,end:f&&f.from<f.to?{from:f.from,to:f.to}:void 0,matched:!1}}h--}}while(t<0?c.prevSibling():c.nextSibling());return{start:a,matched:!1}}function Cg(n,e,t,i,s,r,o){if(t<0?!e:e==n.doc.length)return null;let l=t<0?n.sliceDoc(e-1,e):n.sliceDoc(e,e+1),a=o.indexOf(l);if(a<0||a%2==0!=t>0)return null;let h={from:t<0?e-1:e,to:t>0?e+1:e},c=n.doc.iterRange(e,t>0?n.doc.length:0),f=0;for(let u=0;!c.next().done&&u<=r;){let d=c.value;t<0&&(u+=d.length);let p=e+u*t;for(let m=t>0?0:d.length-1,g=t>0?d.length:-1;m!=g;m+=t){let y=o.indexOf(d[m]);if(!(y<0||i.resolveInner(p+m,1).type!=s))if(y%2==0==t>0)f++;else{if(f==1)return{start:h,end:{from:p+m,to:p+m+1},matched:y>>1==a>>1};f--}}t>0&&(u+=d.length)}return c.done?{start:h,matched:!1}:null}function Ag(n){return{name:n.name||"",token:n.token,blankLine:n.blankLine||(()=>{}),startState:n.startState||(()=>!0),copyState:n.copyState||Mg,indent:n.indent||(()=>null),languageData:n.languageData||{},tokenTable:n.tokenTable||Ol,mergeTokens:n.mergeTokens!==!1}}function Mg(n){if(typeof n!="object")return n;let e={};for(let t in n){let i=n[t];e[t]=i instanceof Array?i.slice():i}return e}function Dl(n,e,t,i,s){let r=t>=i&&t+e.length<=s&&e.prop(n.stateAfter);if(r)return{state:n.streamParser.copyState(r),pos:t+e.length};for(let o=e.children.length-1;o>=0;o--){let l=e.children[o],a=t+e.positions[o],h=l instanceof J&&a<s&&Dl(n,l,a,i,s);if(h)return h}return null}function Lf(n,e,t,i,s){if(s&&t<=0&&i>=e.length)return e;!s&&t==0&&e.type==n.topNode&&(s=!0);for(let r=e.children.length-1;r>=0;r--){let o=e.positions[r],l=e.children[r],a;if(o<i&&l instanceof J){if(!(a=Lf(n,l,t-o,i-o,s)))break;return s?new J(e.type,e.children.slice(0,r).concat(a),e.positions.slice(0,r+1),o+a.length):a}}return null}function Tg(n,e,t,i,s){for(let r of e){let o=r.from+(r.openStart?25:0),l=r.to-(r.openEnd?25:0),a=o<=t&&l>t&&Dl(n,r.tree,0-r.offset,t,l),h;if(a&&a.pos<=i&&(h=Lf(n,r.tree,t+r.offset,a.pos+r.offset,!1)))return{state:a.state,tree:h}}return{state:n.streamParser.startState(s?Dt(s):4),tree:J.empty}}function Ef(n,e,t){e.start=e.pos;for(let i=0;i<10;i++){let s=n(e,t);if(e.pos>e.start)return s}throw new Error("Stream parser failed to advance stream.")}function bl(n,e){uf.indexOf(n)>-1||(uf.push(n),console.warn(e))}function Pf(n,e){let t=[];for(let l of e.split(" ")){let a=[];for(let h of l.split(".")){let c=n[h]||v[h];c?typeof c=="function"?a.length?a=a.map(c):bl(h,`Modifier ${h} used at start of tag`):a.length?bl(h,`Tag ${h} used as modifier`):a=Array.isArray(c)?c:[c]:bl(h,`Unknown highlighting tag ${h}`)}for(let h of a)t.push(h)}if(!t.length)return 0;let i=e.replace(/ /g,"_"),s=i+" "+t.map(l=>l.id),r=df[s];if(r)return r.id;let o=df[s]=ve.define({id:yn.length,name:i,props:[ef({[i]:t})]});return yn.push(o),o.id}function Bg(n,e){let t=ve.define({id:yn.length,name:"Document",props:[Ci.add(()=>n),mf.add(()=>i=>e.getIndent(i))],top:!0});return yn.push(t),t}var ml,Ci,Um,Ee,xl,dn,mn,gn,pf,gl,Gm,Tt,_m,Mi,Yt,mf,wl,ig,ng,sg,zs,bn,Xt,ag,hg,cg,fg,kf,ug,Tl,hf,kl,dg,pn,pg,Ai,vl,Af,Sl,mg,Mf,gg,Tf,Df,Of,yg,bg,wg,kg,vg,ff,Fs,Ml,Ol,yn,Dg,uf,df,Rf,Hs,Og,f1,xn=ye(()=>{Bs();ft();St();pl();Fr();rf();Ci=new P;Um=new P,Ee=class{constructor(e,t,i=[],s=""){this.data=e,this.name=s,W.prototype.hasOwnProperty("tree")||Object.defineProperty(W.prototype,"tree",{get(){return re(this)}}),this.parser=t,this.extension=[Tt.of(this),W.languageData.of((r,o,l)=>{let a=of(r,o,l),h=a.type.prop(Ci);if(!h)return[];let c=r.facet(h),f=a.type.prop(Um);if(f){let u=a.resolve(o-a.from,l);for(let d of f)if(d.test(u,r)){let p=r.facet(d.facet);return d.type=="replace"?p:p.concat(c)}}return c})].concat(i)}isActiveAt(e,t,i=-1){return of(e,t,i).type.prop(Ci)==this.data}findRegions(e){let t=e.facet(Tt);if(t?.data==this.data)return[{from:0,to:e.doc.length}];if(!t||!t.allowsNesting)return[];let i=[],s=(r,o)=>{if(r.prop(Ci)==this.data){i.push({from:o,to:o+r.length});return}let l=r.prop(P.mounted);if(l){if(l.tree.prop(Ci)==this.data){if(l.overlay)for(let a of l.overlay)i.push({from:a.from+o,to:a.to+o});else i.push({from:o,to:o+r.length});return}else if(l.overlay){let a=i.length;if(s(l.tree,l.overlay[0].from+o),i.length>a)return}}for(let a=0;a<r.children.length;a++){let h=r.children[a];h instanceof J&&s(h,r.positions[a]+o)}};return s(re(e),0),i}get allowsNesting(){return!0}};Ee.setState=L.define();xl=class{constructor(e){this.doc=e,this.cursorPos=0,this.string="",this.cursor=e.iter()}get length(){return this.doc.length}syncTo(e){return this.string=this.cursor.next(e-this.cursorPos).value,this.cursorPos=e+this.string.length,this.cursorPos-this.string.length}chunk(e){return this.syncTo(e),this.string}get lineChunks(){return!0}read(e,t){let i=this.cursorPos-this.string.length;return e<i||t>=this.cursorPos?this.doc.sliceString(e,t):this.string.slice(e-i,t-i)}},dn=null,mn=class n{constructor(e,t,i=[],s,r,o,l,a){this.parser=e,this.state=t,this.fragments=i,this.tree=s,this.treeLen=r,this.viewport=o,this.skipped=l,this.scheduleOn=a,this.parse=null,this.tempSkipped=[]}static create(e,t,i){return new n(e,t,[],J.empty,0,i,[],null)}startParse(){return this.parser.startParse(new xl(this.state.doc),this.fragments)}work(e,t){return t!=null&&t>=this.state.doc.length&&(t=void 0),this.tree!=J.empty&&this.isDone(t??this.state.doc.length)?(this.takeTree(),!0):this.withContext(()=>{var i;if(typeof e=="number"){let s=Date.now()+e;e=()=>Date.now()>s}for(this.parse||(this.parse=this.startParse()),t!=null&&(this.parse.stoppedAt==null||this.parse.stoppedAt>t)&&t<this.state.doc.length&&this.parse.stopAt(t);;){let s=this.parse.advance();if(s)if(this.fragments=this.withoutTempSkipped(Ut.addTree(s,this.fragments,this.parse.stoppedAt!=null)),this.treeLen=(i=this.parse.stoppedAt)!==null&&i!==void 0?i:this.state.doc.length,this.tree=s,this.parse=null,this.treeLen<(t??this.state.doc.length))this.parse=this.startParse();else return!0;if(e())return!1}})}takeTree(){let e,t;this.parse&&(e=this.parse.parsedPos)>=this.treeLen&&((this.parse.stoppedAt==null||this.parse.stoppedAt>e)&&this.parse.stopAt(e),this.withContext(()=>{for(;!(t=this.parse.advance()););}),this.treeLen=e,this.tree=t,this.fragments=this.withoutTempSkipped(Ut.addTree(this.tree,this.fragments,!0)),this.parse=null)}withContext(e){let t=dn;dn=this;try{return e()}finally{dn=t}}withoutTempSkipped(e){for(let t;t=this.tempSkipped.pop();)e=lf(e,t.from,t.to);return e}changes(e,t){let{fragments:i,tree:s,treeLen:r,viewport:o,skipped:l}=this;if(this.takeTree(),!e.empty){let a=[];if(e.iterChangedRanges((h,c,f,u)=>a.push({fromA:h,toA:c,fromB:f,toB:u})),i=Ut.applyChanges(i,a),s=J.empty,r=0,o={from:e.mapPos(o.from,-1),to:e.mapPos(o.to,1)},this.skipped.length){l=[];for(let h of this.skipped){let c=e.mapPos(h.from,1),f=e.mapPos(h.to,-1);c<f&&l.push({from:c,to:f})}}}return new n(this.parser,t,i,s,r,o,l,this.scheduleOn)}updateViewport(e){if(this.viewport.from==e.from&&this.viewport.to==e.to)return!1;this.viewport=e;let t=this.skipped.length;for(let i=0;i<this.skipped.length;i++){let{from:s,to:r}=this.skipped[i];s<e.to&&r>e.from&&(this.fragments=lf(this.fragments,s,r),this.skipped.splice(i--,1))}return this.skipped.length>=t?!1:(this.reset(),!0)}reset(){this.parse&&(this.takeTree(),this.parse=null)}skipUntilInView(e,t){this.skipped.push({from:e,to:t})}static getSkippingParser(e){return new class extends cn{createParse(t,i,s){let r=s[0].from,o=s[s.length-1].to;return{parsedPos:r,advance(){let a=dn;if(a){for(let h of s)a.tempSkipped.push(h);e&&(a.scheduleOn=a.scheduleOn?Promise.all([a.scheduleOn,e]):e)}return this.parsedPos=o,new J(ve.none,[],[],o-r)},stoppedAt:null,stopAt(){}}}}}isDone(e){e=Math.min(e,this.state.doc.length);let t=this.fragments;return this.treeLen>=e&&t.length&&t[0].from==0&&t[0].to>=e}static get(){return dn}};gn=class n{constructor(e){this.context=e,this.tree=e.tree}apply(e){if(!e.docChanged&&this.tree==this.context.tree)return this;let t=this.context.changes(e.changes,e.state),i=this.context.treeLen==e.startState.doc.length?void 0:Math.max(e.changes.mapPos(this.context.treeLen),t.viewport.to);return t.work(20,i)||t.takeTree(),new n(t)}static init(e){let t=Math.min(3e3,e.doc.length),i=mn.create(e.facet(Tt).parser,e,{from:0,to:t});return i.work(20,t)||i.takeTree(),new n(i)}};Ee.state=Q.define({create:gn.init,update(n,e){for(let t of e.effects)if(t.is(Ee.setState))return t.value;return e.startState.facet(Tt)!=e.state.facet(Tt)?gn.init(e.state):n.apply(e)}});pf=n=>{let e=setTimeout(()=>n(),500);return()=>clearTimeout(e)};typeof requestIdleCallback<"u"&&(pf=n=>{let e=-1,t=setTimeout(()=>{e=requestIdleCallback(n,{timeout:400})},100);return()=>e<0?clearTimeout(t):cancelIdleCallback(e)});gl=typeof navigator<"u"&&(!((ml=navigator.scheduling)===null||ml===void 0)&&ml.isInputPending)?()=>navigator.scheduling.isInputPending():null,Gm=_.fromClass(class{constructor(e){this.view=e,this.working=null,this.workScheduled=0,this.chunkEnd=-1,this.chunkBudget=-1,this.work=this.work.bind(this),this.scheduleWork()}update(e){let t=this.view.state.field(Ee.state).context;(t.updateViewport(e.view.viewport)||this.view.viewport.to>t.treeLen)&&this.scheduleWork(),(e.docChanged||e.selectionSet)&&(this.view.hasFocus&&(this.chunkBudget+=50),this.scheduleWork()),this.checkAsyncSchedule(t)}scheduleWork(){if(this.working)return;let{state:e}=this.view,t=e.field(Ee.state);(t.tree!=t.context.tree||!t.context.isDone(e.doc.length))&&(this.working=pf(this.work))}work(e){this.working=null;let t=Date.now();if(this.chunkEnd<t&&(this.chunkEnd<0||this.view.hasFocus)&&(this.chunkEnd=t+3e4,this.chunkBudget=3e3),this.chunkBudget<=0)return;let{state:i,viewport:{to:s}}=this.view,r=i.field(Ee.state);if(r.tree==r.context.tree&&r.context.isDone(s+1e5))return;let o=Date.now()+Math.min(this.chunkBudget,100,e&&!gl?Math.max(25,e.timeRemaining()-5):1e9),l=r.context.treeLen<s&&i.doc.length>s+1e3,a=r.context.work(()=>gl&&gl()||Date.now()>o,s+(l?0:1e5));this.chunkBudget-=Date.now()-t,(a||this.chunkBudget<=0)&&(r.context.takeTree(),this.view.dispatch({effects:Ee.setState.of(new gn(r.context))})),this.chunkBudget>0&&!(a&&!l)&&this.scheduleWork(),this.checkAsyncSchedule(r.context)}checkAsyncSchedule(e){e.scheduleOn&&(this.workScheduled++,e.scheduleOn.then(()=>this.scheduleWork()).catch(t=>he(this.view.state,t)).then(()=>this.workScheduled--),e.scheduleOn=null)}destroy(){this.working&&this.working()}isWorking(){return!!(this.working||this.workScheduled>0)}},{eventHandlers:{focus(){this.scheduleWork()}}}),Tt=A.define({combine(n){return n.length?n[0]:null},enables:n=>[Ee.state,Gm,M.contentAttributes.compute([n],e=>{let t=e.facet(n);return t&&t.name?{"data-language":t.name}:{}})]}),_m=A.define(),Mi=A.define({combine:n=>{if(!n.length)return"  ";let e=n[0];if(!e||/\S/.test(e)||Array.from(e).some(t=>t!=e[0]))throw new Error("Invalid indent unit: "+JSON.stringify(n[0]));return e}});Yt=class{constructor(e,t={}){this.state=e,this.options=t,this.unit=Dt(e)}lineAt(e,t=1){let i=this.state.doc.lineAt(e),{simulateBreak:s,simulateDoubleBreak:r}=this.options;return s!=null&&s>=i.from&&s<=i.to?r&&s==e?{text:"",from:e}:(t<0?s<e:s<=e)?{text:i.text.slice(s-i.from),from:s}:{text:i.text.slice(0,s-i.from),from:i.from}:i}textAfterPos(e,t=1){if(this.options.simulateDoubleBreak&&e==this.options.simulateBreak)return"";let{text:i,from:s}=this.lineAt(e,t);return i.slice(e-s,Math.min(i.length,e+100-s))}column(e,t=1){let{text:i,from:s}=this.lineAt(e,t),r=this.countColumn(i,e-s),o=this.options.overrideIndentation?this.options.overrideIndentation(s):-1;return o>-1&&(r+=o-this.countColumn(i,i.search(/\S|$/))),r}countColumn(e,t=e.length){return ct(e,this.state.tabSize,t)}lineIndent(e,t=1){let{text:i,from:s}=this.lineAt(e,t),r=this.options.overrideIndentation;if(r){let o=r(s);if(o>-1)return o}return this.countColumn(i,i.search(/\S|$/))}get simulatedBreak(){return this.options.simulateBreak||null}},mf=new P;wl=class n extends Yt{constructor(e,t,i){super(e.state,e.options),this.base=e,this.pos=t,this.context=i}get node(){return this.context.node}static create(e,t,i){return new n(e,t,i)}get textAfter(){return this.textAfterPos(this.pos)}get baseIndent(){return this.baseIndentFor(this.node)}baseIndentFor(e){let t=this.state.doc.lineAt(e.from);for(;;){let i=e.resolve(t.from);for(;i.parent&&i.parent.from==i.from;)i=i.parent;if(Zm(i,e))break;t=this.state.doc.lineAt(i.from)}return this.lineIndent(t.from)}continue(){return gf(this.context.next,this.base,this.pos)}};ig=200;ng=A.define(),sg=new P;zs=L.define({map:yf}),bn=L.define({map:yf});Xt=Q.define({create(){return B.none},update(n,e){e.isUserEvent("delete")&&e.changes.iterChangedRanges((i,s)=>n=af(n,i,s)),n=n.map(e.changes);let t=[];for(let i of e.effects)i.is(zs)&&!lg(n,i.value.from,i.value.to)?t.push(i.value):i.is(bn)&&(n=n.update({filter:(s,r)=>i.value.from!=s||i.value.to!=r,filterFrom:i.value.from,filterTo:i.value.to}));if(t.length){let{preparePlaceholder:i}=e.state.facet(Tl),s=t.map(r=>(i?B.replace({widget:new kl(i(e.state,r))}):hf).range(r.from,r.to));n=n.update({add:s})}return e.selection&&(n=af(n,e.selection.main.head)),n},provide:n=>M.decorations.from(n),toJSON(n,e){let t=[];return n.between(0,e.doc.length,(i,s)=>{t.push(i,s)}),t},fromJSON(n){if(!Array.isArray(n)||n.length%2)throw new RangeError("Invalid JSON for fold state");let e=[];for(let t=0;t<n.length;){let i=n[t++],s=n[t++];if(typeof i!="number"||typeof s!="number")throw new RangeError("Invalid JSON for fold state");e.push(hf.range(i,s))}return B.set(e,!0)}});ag=n=>{for(let e of bf(n)){let t=Is(n.state,e.from,e.to);if(t)return n.dispatch({effects:xf(n.state,[zs.of(t),wf(n,t)])}),!0}return!1},hg=n=>{if(!n.state.field(Xt,!1))return!1;let e=[];for(let t of bf(n)){let i=Ns(n.state,t.from,t.to);i&&e.push(bn.of(i),wf(n,i,!1))}return e.length&&n.dispatch({effects:e}),e.length>0};cg=n=>{let{state:e}=n,t=[];for(let i=0;i<e.doc.length;){let s=n.lineBlockAt(i),r=Is(e,s.from,s.to);r&&t.push(zs.of(r)),i=(r?n.lineBlockAt(r.to):s).to+1}return t.length&&n.dispatch({effects:xf(n.state,t)}),!!t.length},fg=n=>{let e=n.state.field(Xt,!1);if(!e||!e.size)return!1;let t=[];return e.between(0,n.state.doc.length,(i,s)=>{t.push(bn.of({from:i,to:s}))}),n.dispatch({effects:t}),!0},kf=[{key:"Ctrl-Shift-[",mac:"Cmd-Alt-[",run:ag},{key:"Ctrl-Shift-]",mac:"Cmd-Alt-]",run:hg},{key:"Ctrl-Alt-[",run:cg},{key:"Ctrl-Alt-]",run:fg}],ug={placeholderDOM:null,preparePlaceholder:null,placeholderText:"\u2026"},Tl=A.define({combine(n){return pe(n,ug)}});hf=B.replace({widget:new class extends we{toDOM(n){return Sf(n,null)}}}),kl=class extends we{constructor(e){super(),this.value=e}eq(e){return this.value==e.value}toDOM(e){return Sf(e,this.value)}},dg={openText:"\u2304",closedText:"\u203A",markerDOM:null,domEventHandlers:{},foldingChanged:()=>!1},pn=class extends Le{constructor(e,t){super(),this.config=e,this.open=t}eq(e){return this.config==e.config&&this.open==e.open}toDOM(e){if(this.config.markerDOM)return this.config.markerDOM(this.open);let t=document.createElement("span");return t.textContent=this.open?this.config.openText:this.config.closedText,t.title=e.state.phrase(this.open?"Fold line":"Unfold line"),t}};pg=M.baseTheme({".cm-foldPlaceholder":{backgroundColor:"#eee",border:"1px solid #ddd",color:"#888",borderRadius:".2em",margin:"0 1px",padding:"0 1px",cursor:"pointer"},".cm-foldGutter span":{padding:"0 1px",cursor:"pointer"}}),Ai=class n{constructor(e,t){this.specs=e;let i;function s(l){let a=He.newName();return(i||(i=Object.create(null)))["."+a]=l,a}let r=typeof t.all=="string"?t.all:t.all?s(t.all):void 0,o=t.scope;this.scope=o instanceof Ee?l=>l.prop(Ci)==o.data:o?l=>l==o:void 0,this.style=dl(e.map(l=>({tag:l.tag,class:l.class||s(Object.assign({},l,{tag:null}))})),{all:r}).style,this.module=i?new He(i):null,this.themeType=t.themeType}static define(e,t){return new n(e,t||{})}},vl=A.define(),Af=A.define({combine(n){return n.length?[n[0]]:null}});Sl=class{constructor(e){this.markCache=Object.create(null),this.tree=re(e.state),this.decorations=this.buildDeco(e,yl(e.state)),this.decoratedTo=e.viewport.to}update(e){let t=re(e.state),i=yl(e.state),s=i!=yl(e.startState),{viewport:r}=e.view,o=e.changes.mapPos(this.decoratedTo,1);t.length<r.to&&!s&&t.type==this.tree.type&&o>=r.to?(this.decorations=this.decorations.map(e.changes),this.decoratedTo=o):(t!=this.tree||e.viewportChanged||s)&&(this.tree=t,this.decorations=this.buildDeco(e.view,i),this.decoratedTo=r.to)}buildDeco(e,t){if(!t||!this.tree.length)return B.none;let i=new de;for(let{from:s,to:r}of e.visibleRanges)nf(this.tree,t,(o,l,a)=>{i.add(o,l,this.markCache[a]||(this.markCache[a]=B.mark({class:a})))},s,r);return i.finish()}},mg=Fe.high(_.fromClass(Sl,{decorations:n=>n.decorations})),Mf=Ai.define([{tag:v.meta,color:"#404740"},{tag:v.link,textDecoration:"underline"},{tag:v.heading,textDecoration:"underline",fontWeight:"bold"},{tag:v.emphasis,fontStyle:"italic"},{tag:v.strong,fontWeight:"bold"},{tag:v.strikethrough,textDecoration:"line-through"},{tag:v.keyword,color:"#708"},{tag:[v.atom,v.bool,v.url,v.contentSeparator,v.labelName],color:"#219"},{tag:[v.literal,v.inserted],color:"#164"},{tag:[v.string,v.deleted],color:"#a11"},{tag:[v.regexp,v.escape,v.special(v.string)],color:"#e40"},{tag:v.definition(v.variableName),color:"#00f"},{tag:v.local(v.variableName),color:"#30a"},{tag:[v.typeName,v.namespace],color:"#085"},{tag:v.className,color:"#167"},{tag:[v.special(v.variableName),v.macroName],color:"#256"},{tag:v.definition(v.propertyName),color:"#00c"},{tag:v.comment,color:"#940"},{tag:v.invalid,color:"#f00"}]),gg=M.baseTheme({"&.cm-focused .cm-matchingBracket":{backgroundColor:"#328c8252"},"&.cm-focused .cm-nonmatchingBracket":{backgroundColor:"#bb555544"}}),Tf=1e4,Df="()[]{}",Of=A.define({combine(n){return pe(n,{afterCursor:!0,brackets:Df,maxScanDistance:Tf,renderMatch:xg})}}),yg=B.mark({class:"cm-matchingBracket"}),bg=B.mark({class:"cm-nonmatchingBracket"});wg=_.fromClass(class{constructor(n){this.paused=!1,this.decorations=cf(n.state)}update(n){(n.docChanged||n.selectionSet||this.paused)&&(n.view.composing?(this.decorations=this.decorations.map(n.changes),this.paused=!0):(this.decorations=cf(n.state),this.paused=!1))}},{decorations:n=>n.decorations}),kg=[wg,gg];vg=new P;ff=new WeakMap,Fs=class n extends Ee{constructor(e){let t=jm(e.languageData),i=Ag(e),s,r=new class extends cn{createParse(o,l,a){return new Ml(s,o,l,a)}};super(t,r,[],e.name),this.topNode=Bg(t,this),s=this,this.streamParser=i,this.stateAfter=new P({perNode:!0}),this.tokenTable=e.tokenTable?new Hs(i.tokenTable):Og}static define(e){return new n(e)}getIndent(e){let t,{overrideIndentation:i}=e.options;i&&(t=ff.get(e.state),t!=null&&t<e.pos-1e4&&(t=void 0));let s=Dl(this,e.node.tree,e.node.from,e.node.from,t??e.pos),r,o;if(s?(o=s.state,r=s.pos+1):(o=this.streamParser.startState(e.unit),r=e.node.from),e.pos-r>1e4)return null;for(;r<e.pos;){let a=e.state.doc.lineAt(r),h=Math.min(e.pos,a.to);if(a.length){let c=i?i(a.from):-1,f=new un(a.text,e.state.tabSize,e.unit,c<0?void 0:c);for(;f.pos<h-a.from;)Ef(this.streamParser.token,f,o)}else this.streamParser.blankLine(o,e.unit);if(h==e.pos)break;r=a.to+1}let l=e.lineAt(e.pos);return i&&t==null&&ff.set(e.state,l.from),this.streamParser.indent(o,/^\s*(.*)/.exec(l.text)[1],e)}get allowsNesting(){return!1}};Ml=class{constructor(e,t,i,s){this.lang=e,this.input=t,this.fragments=i,this.ranges=s,this.stoppedAt=null,this.chunks=[],this.chunkPos=[],this.chunk=[],this.chunkReused=void 0,this.rangeIndex=0,this.to=s[s.length-1].to;let r=mn.get(),o=s[0].from,{state:l,tree:a}=Tg(e,i,o,this.to,r?.state);this.state=l,this.parsedPos=this.chunkStart=o+a.length;for(let h=0;h<a.children.length;h++)this.chunks.push(a.children[h]),this.chunkPos.push(a.positions[h]);r&&this.parsedPos<r.viewport.from-1e5&&s.some(h=>h.from<=r.viewport.from&&h.to>=r.viewport.from)&&(this.state=this.lang.streamParser.startState(Dt(r.state)),r.skipUntilInView(this.parsedPos,r.viewport.from),this.parsedPos=r.viewport.from),this.moveRangeIndex()}advance(){let e=mn.get(),t=this.stoppedAt==null?this.to:Math.min(this.to,this.stoppedAt),i=Math.min(t,this.chunkStart+512);for(e&&(i=Math.min(i,e.viewport.to));this.parsedPos<i;)this.parseLine(e);return this.chunkStart<this.parsedPos&&this.finishChunk(),this.parsedPos>=t?this.finish():e&&this.parsedPos>=e.viewport.to?(e.skipUntilInView(this.parsedPos,t),this.finish()):null}stopAt(e){this.stoppedAt=e}lineAfter(e){let t=this.input.chunk(e);if(this.input.lineChunks)t==`
`&&(t="");else{let i=t.indexOf(`
`);i>-1&&(t=t.slice(0,i))}return e+t.length<=this.to?t:t.slice(0,this.to-e)}nextLine(){let e=this.parsedPos,t=this.lineAfter(e),i=e+t.length;for(let s=this.rangeIndex;;){let r=this.ranges[s].to;if(r>=i||(t=t.slice(0,r-(i-t.length)),s++,s==this.ranges.length))break;let o=this.ranges[s].from,l=this.lineAfter(o);t+=l,i=o+l.length}return{line:t,end:i}}skipGapsTo(e,t,i){for(;;){let s=this.ranges[this.rangeIndex].to,r=e+t;if(i>0?s>r:s>=r)break;let o=this.ranges[++this.rangeIndex].from;t+=o-s}return t}moveRangeIndex(){for(;this.ranges[this.rangeIndex].to<this.parsedPos;)this.rangeIndex++}emitToken(e,t,i,s){let r=4;if(this.ranges.length>1){s=this.skipGapsTo(t,s,1),t+=s;let l=this.chunk.length;s=this.skipGapsTo(i,s,-1),i+=s,r+=this.chunk.length-l}let o=this.chunk.length-4;return this.lang.streamParser.mergeTokens&&r==4&&o>=0&&this.chunk[o]==e&&this.chunk[o+2]==t?this.chunk[o+2]=i:this.chunk.push(e,t,i,r),s}parseLine(e){let{line:t,end:i}=this.nextLine(),s=0,{streamParser:r}=this.lang,o=new un(t,e?e.state.tabSize:4,e?Dt(e.state):2);if(o.eol())r.blankLine(this.state,o.indentUnit);else for(;!o.eol();){let l=Ef(r.token,o,this.state);if(l&&(s=this.emitToken(this.lang.tokenTable.resolve(l),this.parsedPos+o.start,this.parsedPos+o.pos,s)),o.start>1e4)break}this.parsedPos=i,this.moveRangeIndex(),this.parsedPos<this.to&&this.parsedPos++}finishChunk(){let e=J.build({buffer:this.chunk,start:this.chunkStart,length:this.parsedPos-this.chunkStart,nodeSet:Dg,topID:0,maxBufferLength:512,reused:this.chunkReused});e=new J(e.type,e.children,e.positions,e.length,[[this.lang.stateAfter,this.lang.streamParser.copyState(this.state)]]),this.chunks.push(e),this.chunkPos.push(this.chunkStart-this.ranges[0].from),this.chunk=[],this.chunkReused=void 0,this.chunkStart=this.parsedPos}finish(){return new J(this.lang.topNode,this.chunks,this.chunkPos,this.parsedPos-this.ranges[0].from).balance()}};Ol=Object.create(null),yn=[ve.none],Dg=new Ds(yn),uf=[],df=Object.create(null),Rf=Object.create(null);for(let[n,e]of[["variable","variableName"],["variable-2","variableName.special"],["string-2","string.special"],["def","variableName.definition"],["tag","tagName"],["attribute","attributeName"],["type","typeName"],["builtin","variableName.standard"],["qualifier","modifier"],["error","invalid"],["header","heading"],["property","propertyName"]])Rf[n]=Pf(Ol,e);Hs=class{constructor(e){this.extra=e,this.table=Object.assign(Object.create(null),Rf)}resolve(e){return e?this.table[e]||(this.table[e]=Pf(this.extra,e)):0}},Og=new Hs(Ol);f1={rtl:B.mark({class:"cm-iso",inclusive:!0,attributes:{dir:"rtl"},bidiIsolate:q.RTL}),ltr:B.mark({class:"cm-iso",inclusive:!0,attributes:{dir:"ltr"},bidiIsolate:q.LTR}),auto:B.mark({class:"cm-iso",inclusive:!0,attributes:{dir:"auto"},bidiIsolate:null})}});function If(n){let e=Object.keys(n).join(""),t=/\w/.test(e);return t&&(e=e.replace(/\w/g,"")),`[${t?"\\w":""}${e.replace(/[^\w\s]/g,"\\$&")}]`}function Lg(n){let e=Object.create(null),t=Object.create(null);for(let{label:s}of n){e[s[0]]=!0;for(let r=1;r<s.length;r++)t[s[r]]=!0}let i=If(e)+If(t)+"*$";return[new RegExp("^"+i),new RegExp(i)]}function Eg(n){let e=n.map(s=>typeof s=="string"?{label:s}:s),[t,i]=e.every(s=>/^\w+$/.test(s.label))?[/\w*$/,/\w+$/]:Lg(e);return s=>{let r=s.matchBefore(i);return r||s.explicit?{from:r?r.from:s.pos,options:e,validFor:t}:null}}function Qt(n){return n.selection.main.from}function Kf(n,e){var t;let{source:i}=n,s=e&&i[0]!="^",r=i[i.length-1]!="$";return!s&&!r?n:new RegExp(`${s?"^":""}(?:${i})${r?"$":""}`,(t=n.flags)!==null&&t!==void 0?t:n.ignoreCase?"i":"")}function Rg(n,e,t,i){let{main:s}=n.selection,r=t-s.from,o=i-s.from;return{...n.changeByRange(l=>{if(l!=s&&t!=i&&n.sliceDoc(l.from+r,l.from+o)!=n.sliceDoc(t,i))return{range:l};let a=n.toText(e);return{changes:{from:l.from+r,to:i==s.from?l.to:l.from+o,insert:a},range:b.cursor(l.from+r+a.length)}}),scrollIntoView:!0,userEvent:"input.complete"}}function Pg(n){if(!Array.isArray(n))return n;let e=Nf.get(n);return e||Nf.set(n,e=Eg(n)),e}function Ff(n,e){return n?e?n+" "+e:n:e}function Ig(n,e,t,i,s,r){let o=n.textDirection==q.RTL,l=o,a=!1,h="top",c,f,u=e.left-s.left,d=s.right-e.right,p=i.right-i.left,m=i.bottom-i.top;if(l&&u<Math.min(p,d)?l=!1:!l&&d<Math.min(p,u)&&(l=!0),p<=(l?u:d))c=Math.max(s.top,Math.min(t.top,s.bottom-m))-e.top,f=Math.min(400,l?u:d);else{a=!0,f=Math.min(400,(o?e.right:s.right-e.left)-30);let k=s.bottom-e.bottom;k>=m||k>e.top?c=t.bottom-e.top:(h="bottom",c=e.bottom-t.top)}let g=(e.bottom-e.top)/r.offsetHeight,y=(e.right-e.left)/r.offsetWidth;return{style:`${h}: ${c/g}px; max-width: ${f/y}px`,class:"cm-completionInfo-"+(a?o?"left-narrow":"right-narrow":l?"left":"right")}}function Ng(n){let e=n.addToOptions.slice();return n.icons&&e.push({render(t){let i=document.createElement("div");return i.classList.add("cm-completionIcon"),t.type&&i.classList.add(...t.type.split(/\s+/g).map(s=>"cm-completionIcon-"+s)),i.setAttribute("aria-hidden","true"),i},position:20}),e.push({render(t,i,s,r){let o=document.createElement("span");o.className="cm-completionLabel";let l=t.displayLabel||t.label,a=0;for(let h=0;h<r.length;){let c=r[h++],f=r[h++];c>a&&o.appendChild(document.createTextNode(l.slice(a,c)));let u=o.appendChild(document.createElement("span"));u.appendChild(document.createTextNode(l.slice(c,f))),u.className="cm-completionMatchedText",a=f}return a<l.length&&o.appendChild(document.createTextNode(l.slice(a))),o},position:50},{render(t){if(!t.detail)return null;let i=document.createElement("span");return i.className="cm-completionDetail",i.textContent=t.detail,i},position:80}),e.sort((t,i)=>t.position-i.position).map(t=>t.render)}function Bl(n,e,t){if(n<=t)return{from:0,to:n};if(e<0&&(e=0),e<=n>>1){let s=Math.floor(e/t);return{from:s*t,to:(s+1)*t}}let i=Math.ceil((n-e)/t);return{from:n-i*t,to:n-(i-1)*t}}function Fg(n,e){return t=>new Il(t,n,e)}function Hg(n,e){let t=n.getBoundingClientRect(),i=e.getBoundingClientRect(),s=t.height/n.offsetHeight;i.top<t.top?n.scrollTop-=(t.top-i.top)/s:i.bottom>t.bottom&&(n.scrollTop+=(i.bottom-t.bottom)/s)}function Hf(n){return(n.boost||0)*100+(n.apply?10:0)+(n.info?5:0)+(n.type?1:0)}function Wg(n,e){let t=[],i=null,s=null,r=c=>{t.push(c);let{section:f}=c.completion;if(f){i||(i=[]);let u=typeof f=="string"?f:f.name;i.some(d=>d.name==u)||i.push(typeof f=="string"?{name:u}:f)}},o=e.facet(oe);for(let c of n)if(c.hasResult()){let f=c.result.getMatch;if(c.result.filter===!1)for(let u of c.result.options)r(new js(u,c.source,f?f(u):[],1e9-t.length));else{let u=e.sliceDoc(c.from,c.to),d,p=o.filterStrict?new Pl(u):new Rl(u);for(let m of c.result.options)if(d=p.match(m.label)){let g=m.displayLabel?f?f(m,d.matched):[]:d.matched,y=d.score+(m.boost||0);if(r(new js(m,c.source,g,y)),typeof m.section=="object"&&m.section.rank==="dynamic"){let{name:k}=m.section;s||(s=Object.create(null)),s[k]=Math.max(y,s[k]||-1e9)}}}}if(i){let c=Object.create(null),f=0,u=(d,p)=>(d.rank==="dynamic"&&p.rank==="dynamic"?s[p.name]-s[d.name]:0)||(typeof d.rank=="number"?d.rank:1e9)-(typeof p.rank=="number"?p.rank:1e9)||(d.name<p.name?-1:1);for(let d of i.sort(u))f-=1e5,c[d.name]=f;for(let d of t){let{section:p}=d.completion;p&&(d.score+=c[typeof p=="string"?p:p.name])}}let l=[],a=null,h=o.compareCompletions;for(let c of t.sort((f,u)=>u.score-f.score||h(f.completion,u.completion))){let f=c.completion;!a||a.label!=f.label||a.detail!=f.detail||a.type!=null&&f.type!=null&&a.type!=f.type||a.apply!=f.apply||a.boost!=f.boost?l.push(c):Hf(c.completion)>Hf(a)&&(l[l.length-1]=c),a=c.completion}return l}function Vg(n,e){if(n==e)return!0;for(let t=0,i=0;;){for(;t<n.length&&!n[t].hasResult();)t++;for(;i<e.length&&!e[i].hasResult();)i++;let s=t==n.length,r=i==e.length;if(s||r)return s==r;if(n[t++].result!=e[i++].result)return!1}}function Wf(n,e){let t={"aria-autocomplete":"list","aria-haspopup":"listbox","aria-controls":n};return e>-1&&(t["aria-activedescendant"]=n+"-"+e),t}function $f(n,e){if(n.isUserEvent("input.complete")){let i=n.annotation(ql);if(i&&e.activateOnCompletion(i))return 12}let t=n.isUserEvent("input.type");return t&&e.activateOnTyping?5:t?1:n.isUserEvent("delete.backward")?2:n.selection?8:n.docChanged?16:0}function $g(n,e,t,i){if(!n)return!1;let s=e.sliceDoc(t,i);return typeof n=="function"?n(s,t,i,e):Kf(n,!0).test(s)}function jl(n,e){let t=e.completion.apply||e.completion.label,i=n.state.field(Ae).active.find(s=>s.source==e.source);return i instanceof Gs?(typeof t=="string"?n.dispatch({...Rg(n.state,t,i.from,i.to),annotations:ql.of(e.completion)}):t(n,e.completion,i.from,i.to),!0):!1}function Ks(n,e="option"){return t=>{let i=t.state.field(Ae,!1);if(!i||!i.open||i.open.disabled||Date.now()-i.open.timestamp<t.state.facet(oe).interactionDelay)return!1;let s=1,r;e=="page"&&(r=tl(t,i.open.tooltip))&&(s=Math.max(2,Math.floor(r.dom.offsetHeight/r.dom.querySelector("li").offsetHeight)-1));let{length:o}=i.open.options,l=i.open.selected>-1?i.open.selected+s*(n?1:-1):n?0:o-1;return l<0?l=e=="page"?0:o-1:l>=o&&(l=e=="page"?o-1:0),t.dispatch({effects:Kl.of(l)}),!0}}function Ul(n,e){return b.create(n.filter(t=>t.field==e).map(t=>b.range(t.from,t.to)))}function i0(n){let e=zl.parse(n);return(t,i,s,r)=>{let{text:o,ranges:l}=e.instantiate(t.state,s),{main:a}=t.state.selection,h={changes:{from:s,to:r==a.from?a.to:r,insert:N.of(o)},scrollIntoView:!0,annotations:i?[ql.of(i),te.userEvent.of("input.complete")]:void 0};if(l.length&&(h.selection=Ul(l,0)),l.some(c=>c.field>0)){let c=new Di(l,0),f=h.effects=[Sn.of(c)];t.state.field(kn,!1)===void 0&&f.push(L.appendConfig.of([kn,l0,a0,jf]))}t.dispatch(t.state.update(h))}}function Uf(n){return({state:e,dispatch:t})=>{let i=e.field(kn,!1);if(!i||n<0&&i.active==0)return!1;let s=i.active+n,r=n>0&&!i.ranges.some(o=>o.field==s+n);return t(e.update({selection:Ul(i.ranges,s),effects:Sn.of(r?null:new Di(i.ranges,s)),scrollIntoView:!0})),!0}}function Gf(n,e){return{...e,apply:i0(n)}}function Yf(){return[c0,_f]}function Xf(n){for(let e=0;e<El.length;e+=2)if(El.charCodeAt(e)==n)return El.charAt(e+1);return Vi(n<128?n:n+1)}function Jf(n,e){return n.languageDataAt("closeBrackets",e)[0]||vn}function u0(n,e){let t=Jf(n,n.selection.main.head),i=t.brackets||vn.brackets;for(let s of i){let r=Xf(ae(s,0));if(e==s)return r==s?g0(n,s,i.indexOf(s+s+s)>-1,t):p0(n,s,r,t.before||vn.before);if(e==r&&Zf(n,n.selection.main.from))return m0(n,s,r)}return null}function Zf(n,e){let t=!1;return n.field(_f).between(0,n.doc.length,i=>{i==e&&(t=!0)}),t}function _s(n,e){let t=n.sliceString(e,e+2);return t.slice(0,Oe(ae(t,0)))}function d0(n,e){let t=n.sliceString(e-2,e);return Oe(ae(t,0))==t.length?t:t.slice(1)}function p0(n,e,t,i){let s=null,r=n.changeByRange(o=>{if(!o.empty)return{changes:[{insert:e,from:o.from},{insert:t,from:o.to}],effects:Jt.of(o.to+e.length),range:b.range(o.anchor+e.length,o.head+e.length)};let l=_s(n.doc,o.head);return!l||/\s/.test(l)||i.indexOf(l)>-1?{changes:{insert:e+t,from:o.head},effects:Jt.of(o.head+e.length),range:b.cursor(o.head+e.length)}:{range:s=o}});return s?null:n.update(r,{scrollIntoView:!0,userEvent:"input.type"})}function m0(n,e,t){let i=null,s=n.changeByRange(r=>r.empty&&_s(n.doc,r.head)==t?{changes:{from:r.head,to:r.head+t.length,insert:t},range:b.cursor(r.head+t.length)}:i={range:r});return i?null:n.update(s,{scrollIntoView:!0,userEvent:"input.type"})}function g0(n,e,t,i){let s=i.stringPrefixes||vn.stringPrefixes,r=null,o=n.changeByRange(l=>{if(!l.empty)return{changes:[{insert:e,from:l.from},{insert:e,from:l.to}],effects:Jt.of(l.to+e.length),range:b.range(l.anchor+e.length,l.head+e.length)};let a=l.head,h=_s(n.doc,a),c;if(h==e){if(zf(n,a))return{changes:{insert:e+e,from:a},effects:Jt.of(a+e.length),range:b.cursor(a+e.length)};if(Zf(n,a)){let u=t&&n.sliceDoc(a,a+e.length*3)==e+e+e?e+e+e:e;return{changes:{from:a,to:a+u.length,insert:u},range:b.cursor(a+u.length)}}}else{if(t&&n.sliceDoc(a-2*e.length,a)==e+e&&(c=qf(n,a-2*e.length,s))>-1&&zf(n,c))return{changes:{insert:e+e+e+e,from:a},effects:Jt.of(a+e.length),range:b.cursor(a+e.length)};if(n.charCategorizer(a)(h)!=$.Word&&qf(n,a,s)>-1&&!y0(n,a,e,s))return{changes:{insert:e+e,from:a},effects:Jt.of(a+e.length),range:b.cursor(a+e.length)}}return{range:r=l}});return r?null:n.update(o,{scrollIntoView:!0,userEvent:"input.type"})}function zf(n,e){let t=re(n).resolveInner(e+1);return t.parent&&t.from==e}function y0(n,e,t,i){let s=re(n).resolveInner(e,-1),r=i.reduce((o,l)=>Math.max(o,l.length),0);for(let o=0;o<5;o++){let l=n.sliceDoc(s.from,Math.min(s.to,s.from+t.length+r)),a=l.indexOf(t);if(!a||a>-1&&i.indexOf(l.slice(0,a))>-1){let c=s.firstChild;for(;c&&c.from==s.from&&c.to-c.from>t.length+a;){if(n.sliceDoc(c.to-t.length,c.to)==t)return!1;c=c.firstChild}return!0}let h=s.to==e&&s.parent;if(!h)break;s=h}return!1}function qf(n,e,t){let i=n.charCategorizer(e);if(i(n.sliceDoc(e-1,e))!=$.Word)return e;for(let s of t){let r=e-s.length;if(n.sliceDoc(r,e)==s&&i(n.sliceDoc(r-1,r))!=$.Word)return r}return-1}function eu(n={}){return[Qg,Ae,oe.of(n),Xg,b0,jf]}var $s,js,ql,Nf,Us,wn,Rl,Pl,oe,Kl,Il,Nl,Fl,zg,qg,Kg,gt,Gs,$l,Ae,jg,Ug,Ll,Gg,Hl,_g,Yg,Xg,Jg,Qg,jf,Wl,Vl,zl,Zg,e0,Di,Sn,t0,kn,n0,s0,r0,o0,Vf,l0,a0,vn,Jt,Gl,_f,El,h0,c0,f0,Qf,_l,b0,Yl=ye(()=>{ft();St();xn();$s=class{constructor(e,t,i,s){this.state=e,this.pos=t,this.explicit=i,this.view=s,this.abortListeners=[],this.abortOnDocChange=!1}tokenBefore(e){let t=re(this.state).resolveInner(this.pos,-1);for(;t&&e.indexOf(t.name)<0;)t=t.parent;return t?{from:t.from,to:this.pos,text:this.state.sliceDoc(t.from,this.pos),type:t.type}:null}matchBefore(e){let t=this.state.doc.lineAt(this.pos),i=Math.max(t.from,this.pos-250),s=t.text.slice(i-t.from,this.pos-t.from),r=s.search(Kf(e,!1));return r<0?null:{from:i+r,to:this.pos,text:s.slice(r)}}get aborted(){return this.abortListeners==null}addEventListener(e,t,i){e=="abort"&&this.abortListeners&&(this.abortListeners.push(t),i&&i.onDocChange&&(this.abortOnDocChange=!0))}};js=class{constructor(e,t,i,s){this.completion=e,this.source=t,this.match=i,this.score=s}};ql=Se.define();Nf=new WeakMap;Us=L.define(),wn=L.define(),Rl=class{constructor(e){this.pattern=e,this.chars=[],this.folded=[],this.any=[],this.precise=[],this.byWord=[],this.score=0,this.matched=[];for(let t=0;t<e.length;){let i=ae(e,t),s=Oe(i);this.chars.push(i);let r=e.slice(t,t+s),o=r.toUpperCase();this.folded.push(ae(o==r?r.toLowerCase():o,0)),t+=s}this.astral=e.length!=this.chars.length}ret(e,t){return this.score=e,this.matched=t,this}match(e){if(this.pattern.length==0)return this.ret(-100,[]);if(e.length<this.pattern.length)return null;let{chars:t,folded:i,any:s,precise:r,byWord:o}=this;if(t.length==1){let k=ae(e,0),x=Oe(k),O=x==e.length?0:-100;if(k!=t[0])if(k==i[0])O+=-200;else return null;return this.ret(O,[0,x])}let l=e.indexOf(this.pattern);if(l==0)return this.ret(e.length==this.pattern.length?0:-100,[0,this.pattern.length]);let a=t.length,h=0;if(l<0){for(let k=0,x=Math.min(e.length,200);k<x&&h<a;){let O=ae(e,k);(O==t[h]||O==i[h])&&(s[h++]=k),k+=Oe(O)}if(h<a)return null}let c=0,f=0,u=!1,d=0,p=-1,m=-1,g=/[a-z]/.test(e),y=!0;for(let k=0,x=Math.min(e.length,200),O=0;k<x&&f<a;){let w=ae(e,k);l<0&&(c<a&&w==t[c]&&(r[c++]=k),d<a&&(w==t[d]||w==i[d]?(d==0&&(p=k),m=k+1,d++):d=0));let S,C=w<255?w>=48&&w<=57||w>=97&&w<=122?2:w>=65&&w<=90?1:0:(S=Vi(w))!=S.toLowerCase()?1:S!=S.toUpperCase()?2:0;(!k||C==1&&g||O==0&&C!=0)&&(t[f]==w||i[f]==w&&(u=!0)?o[f++]=k:o.length&&(y=!1)),O=C,k+=Oe(w)}return f==a&&o[0]==0&&y?this.result(-100+(u?-200:0),o,e):d==a&&p==0?this.ret(-200-e.length+(m==e.length?0:-100),[0,m]):l>-1?this.ret(-700-e.length,[l,l+this.pattern.length]):d==a?this.ret(-900-e.length,[p,m]):f==a?this.result(-100+(u?-200:0)+-700+(y?0:-1100),o,e):t.length==2?null:this.result((s[0]?-700:0)+-200+-1100,s,e)}result(e,t,i){let s=[],r=0;for(let o of t){let l=o+(this.astral?Oe(ae(i,o)):1);r&&s[r-1]==o?s[r-1]=l:(s[r++]=o,s[r++]=l)}return this.ret(e-i.length,s)}},Pl=class{constructor(e){this.pattern=e,this.matched=[],this.score=0,this.folded=e.toLowerCase()}match(e){if(e.length<this.pattern.length)return null;let t=e.slice(0,this.pattern.length),i=t==this.pattern?0:t.toLowerCase()==this.folded?-200:null;return i==null?null:(this.matched=[0,t.length],this.score=i+(e.length==this.pattern.length?0:-100),this)}},oe=A.define({combine(n){return pe(n,{activateOnTyping:!0,activateOnCompletion:()=>!1,activateOnTypingDelay:100,selectOnOpen:!0,override:null,closeOnBlur:!0,maxRenderedOptions:100,defaultKeymap:!0,tooltipClass:()=>"",optionClass:()=>"",aboveCursor:!1,icons:!0,addToOptions:[],positionInfo:Ig,filterStrict:!1,compareCompletions:(e,t)=>(e.sortText||e.label).localeCompare(t.sortText||t.label),interactionDelay:75,updateSyncTime:100},{defaultKeymap:(e,t)=>e&&t,closeOnBlur:(e,t)=>e&&t,icons:(e,t)=>e&&t,tooltipClass:(e,t)=>i=>Ff(e(i),t(i)),optionClass:(e,t)=>i=>Ff(e(i),t(i)),addToOptions:(e,t)=>e.concat(t),filterStrict:(e,t)=>e||t})}});Kl=L.define();Il=class{constructor(e,t,i){this.view=e,this.stateField=t,this.applyCompletion=i,this.info=null,this.infoDestroy=null,this.placeInfoReq={read:()=>this.measureInfo(),write:a=>this.placeInfo(a),key:this},this.space=null,this.currentClass="";let s=e.state.field(t),{options:r,selected:o}=s.open,l=e.state.facet(oe);this.optionContent=Ng(l),this.optionClass=l.optionClass,this.tooltipClass=l.tooltipClass,this.range=Bl(r.length,o,l.maxRenderedOptions),this.dom=document.createElement("div"),this.dom.className="cm-tooltip-autocomplete",this.updateTooltipClass(e.state),this.dom.addEventListener("mousedown",a=>{let{options:h}=e.state.field(t).open;for(let c=a.target,f;c&&c!=this.dom;c=c.parentNode)if(c.nodeName=="LI"&&(f=/-(\d+)$/.exec(c.id))&&+f[1]<h.length){this.applyCompletion(e,h[+f[1]]),a.preventDefault();return}if(a.target==this.list){let c=this.list.classList.contains("cm-completionListIncompleteTop")&&a.clientY<this.list.firstChild.getBoundingClientRect().top?this.range.from-1:this.list.classList.contains("cm-completionListIncompleteBottom")&&a.clientY>this.list.lastChild.getBoundingClientRect().bottom?this.range.to:null;c!=null&&(e.dispatch({effects:Kl.of(c)}),a.preventDefault())}}),this.dom.addEventListener("focusout",a=>{let h=e.state.field(this.stateField,!1);h&&h.tooltip&&e.state.facet(oe).closeOnBlur&&a.relatedTarget!=e.contentDOM&&e.dispatch({effects:wn.of(null)})}),this.showOptions(r,s.id)}mount(){this.updateSel()}showOptions(e,t){this.list&&this.list.remove(),this.list=this.dom.appendChild(this.createListBox(e,t,this.range)),this.list.addEventListener("scroll",()=>{this.info&&this.view.requestMeasure(this.placeInfoReq)})}update(e){var t;let i=e.state.field(this.stateField),s=e.startState.field(this.stateField);if(this.updateTooltipClass(e.state),i!=s){let{options:r,selected:o,disabled:l}=i.open;(!s.open||s.open.options!=r)&&(this.range=Bl(r.length,o,e.state.facet(oe).maxRenderedOptions),this.showOptions(r,i.id)),this.updateSel(),l!=((t=s.open)===null||t===void 0?void 0:t.disabled)&&this.dom.classList.toggle("cm-tooltip-autocomplete-disabled",!!l)}}updateTooltipClass(e){let t=this.tooltipClass(e);if(t!=this.currentClass){for(let i of this.currentClass.split(" "))i&&this.dom.classList.remove(i);for(let i of t.split(" "))i&&this.dom.classList.add(i);this.currentClass=t}}positioned(e){this.space=e,this.info&&this.view.requestMeasure(this.placeInfoReq)}updateSel(){let e=this.view.state.field(this.stateField),t=e.open;(t.selected>-1&&t.selected<this.range.from||t.selected>=this.range.to)&&(this.range=Bl(t.options.length,t.selected,this.view.state.facet(oe).maxRenderedOptions),this.showOptions(t.options,e.id));let i=this.updateSelectedOption(t.selected);if(i){this.destroyInfo();let{completion:s}=t.options[t.selected],{info:r}=s;if(!r)return;let o=typeof r=="string"?document.createTextNode(r):r(s);if(!o)return;"then"in o?o.then(l=>{l&&this.view.state.field(this.stateField,!1)==e&&this.addInfoPane(l,s)}).catch(l=>he(this.view.state,l,"completion info")):(this.addInfoPane(o,s),i.setAttribute("aria-describedby",this.info.id))}}addInfoPane(e,t){this.destroyInfo();let i=this.info=document.createElement("div");if(i.className="cm-tooltip cm-completionInfo",i.id="cm-completionInfo-"+Math.floor(Math.random()*65535).toString(16),e.nodeType!=null)i.appendChild(e),this.infoDestroy=null;else{let{dom:s,destroy:r}=e;i.appendChild(s),this.infoDestroy=r||null}this.dom.appendChild(i),this.view.requestMeasure(this.placeInfoReq)}updateSelectedOption(e){let t=null;for(let i=this.list.firstChild,s=this.range.from;i;i=i.nextSibling,s++)i.nodeName!="LI"||!i.id?s--:s==e?i.hasAttribute("aria-selected")||(i.setAttribute("aria-selected","true"),t=i):i.hasAttribute("aria-selected")&&(i.removeAttribute("aria-selected"),i.removeAttribute("aria-describedby"));return t&&Hg(this.list,t),t}measureInfo(){let e=this.dom.querySelector("[aria-selected]");if(!e||!this.info)return null;let t=this.dom.getBoundingClientRect(),i=this.info.getBoundingClientRect(),s=e.getBoundingClientRect(),r=this.space;if(!r){let o=this.dom.ownerDocument.documentElement;r={left:0,top:0,right:o.clientWidth,bottom:o.clientHeight}}return s.top>Math.min(r.bottom,t.bottom)-10||s.bottom<Math.max(r.top,t.top)+10?null:this.view.state.facet(oe).positionInfo(this.view,t,s,i,r,this.dom)}placeInfo(e){this.info&&(e?(e.style&&(this.info.style.cssText=e.style),this.info.className="cm-tooltip cm-completionInfo "+(e.class||"")):this.info.style.cssText="top: -1e6px")}createListBox(e,t,i){let s=document.createElement("ul");s.id=t,s.setAttribute("role","listbox"),s.setAttribute("aria-expanded","true"),s.setAttribute("aria-label",this.view.state.phrase("Completions")),s.addEventListener("mousedown",o=>{o.target==s&&o.preventDefault()});let r=null;for(let o=i.from;o<i.to;o++){let{completion:l,match:a}=e[o],{section:h}=l;if(h){let u=typeof h=="string"?h:h.name;if(u!=r&&(o>i.from||i.from==0))if(r=u,typeof h!="string"&&h.header)s.appendChild(h.header(h));else{let d=s.appendChild(document.createElement("completion-section"));d.textContent=u}}let c=s.appendChild(document.createElement("li"));c.id=t+"-"+o,c.setAttribute("role","option");let f=this.optionClass(l);f&&(c.className=f);for(let u of this.optionContent){let d=u(l,this.view.state,this.view,a);d&&c.appendChild(d)}}return i.from&&s.classList.add("cm-completionListIncompleteTop"),i.to<e.length&&s.classList.add("cm-completionListIncompleteBottom"),s}destroyInfo(){this.info&&(this.infoDestroy&&this.infoDestroy(),this.info.remove(),this.info=null)}destroy(){this.destroyInfo()}};Nl=class n{constructor(e,t,i,s,r,o){this.options=e,this.attrs=t,this.tooltip=i,this.timestamp=s,this.selected=r,this.disabled=o}setSelected(e,t){return e==this.selected||e>=this.options.length?this:new n(this.options,Wf(t,e),this.tooltip,this.timestamp,e,this.disabled)}static build(e,t,i,s,r,o){if(s&&!o&&e.some(h=>h.isPending))return s.setDisabled();let l=Wg(e,t);if(!l.length)return s&&e.some(h=>h.isPending)?s.setDisabled():null;let a=t.facet(oe).selectOnOpen?0:-1;if(s&&s.selected!=a&&s.selected!=-1){let h=s.options[s.selected].completion;for(let c=0;c<l.length;c++)if(l[c].completion==h){a=c;break}}return new n(l,Wf(i,a),{pos:e.reduce((h,c)=>c.hasResult()?Math.min(h,c.from):h,1e8),create:jg,above:r.aboveCursor},s?s.timestamp:Date.now(),a,!1)}map(e){return new n(this.options,this.attrs,{...this.tooltip,pos:e.mapPos(this.tooltip.pos)},this.timestamp,this.selected,this.disabled)}setDisabled(){return new n(this.options,this.attrs,this.tooltip,this.timestamp,this.selected,!0)}},Fl=class n{constructor(e,t,i){this.active=e,this.id=t,this.open=i}static start(){return new n(Kg,"cm-ac-"+Math.floor(Math.random()*2e6).toString(36),null)}update(e){let{state:t}=e,i=t.facet(oe),r=(i.override||t.languageDataAt("autocomplete",Qt(t)).map(Pg)).map(a=>(this.active.find(c=>c.source==a)||new gt(a,this.active.some(c=>c.state!=0)?1:0)).update(e,i));r.length==this.active.length&&r.every((a,h)=>a==this.active[h])&&(r=this.active);let o=this.open,l=e.effects.some(a=>a.is($l));o&&e.docChanged&&(o=o.map(e.changes)),e.selection||r.some(a=>a.hasResult()&&e.changes.touchesRange(a.from,a.to))||!Vg(r,this.active)||l?o=Nl.build(r,t,this.id,o,i,l):o&&o.disabled&&!r.some(a=>a.isPending)&&(o=null),!o&&r.every(a=>!a.isPending)&&r.some(a=>a.hasResult())&&(r=r.map(a=>a.hasResult()?new gt(a.source,0):a));for(let a of e.effects)a.is(Kl)&&(o=o&&o.setSelected(a.value,this.id));return r==this.active&&o==this.open?this:new n(r,this.id,o)}get tooltip(){return this.open?this.open.tooltip:null}get attrs(){return this.open?this.open.attrs:this.active.length?zg:qg}};zg={"aria-autocomplete":"list"},qg={};Kg=[];gt=class n{constructor(e,t,i=!1){this.source=e,this.state=t,this.explicit=i}hasResult(){return!1}get isPending(){return this.state==1}update(e,t){let i=$f(e,t),s=this;(i&8||i&16&&this.touches(e))&&(s=new n(s.source,0)),i&4&&s.state==0&&(s=new n(this.source,1)),s=s.updateFor(e,i);for(let r of e.effects)if(r.is(Us))s=new n(s.source,1,r.value);else if(r.is(wn))s=new n(s.source,0);else if(r.is($l))for(let o of r.value)o.source==s.source&&(s=o);return s}updateFor(e,t){return this.map(e.changes)}map(e){return this}touches(e){return e.changes.touchesRange(Qt(e.state))}},Gs=class n extends gt{constructor(e,t,i,s,r,o){super(e,3,t),this.limit=i,this.result=s,this.from=r,this.to=o}hasResult(){return!0}updateFor(e,t){var i;if(!(t&3))return this.map(e.changes);let s=this.result;s.map&&!e.changes.empty&&(s=s.map(s,e.changes));let r=e.changes.mapPos(this.from),o=e.changes.mapPos(this.to,1),l=Qt(e.state);if(l>o||!s||t&2&&(Qt(e.startState)==this.from||l<this.limit))return new gt(this.source,t&4?1:0);let a=e.changes.mapPos(this.limit);return $g(s.validFor,e.state,r,o)?new n(this.source,this.explicit,a,s,r,o):s.update&&(s=s.update(s,r,o,new $s(e.state,l,!1)))?new n(this.source,this.explicit,a,s,s.from,(i=s.to)!==null&&i!==void 0?i:Qt(e.state)):new gt(this.source,1,this.explicit)}map(e){if(e.empty)return this;let t=this.result.map?this.result.map(this.result,e):this.result;return t?new n(this.source,this.explicit,e.mapPos(this.limit),t,e.mapPos(this.from),e.mapPos(this.to,1)):new gt(this.source,0)}touches(e){return e.changes.touchesRange(this.from,this.to)}};$l=L.define({map(n,e){return n.map(t=>t.map(e))}}),Ae=Q.define({create(){return Fl.start()},update(n,e){return n.update(e)},provide:n=>[rn.from(n,e=>e.tooltip),M.contentAttributes.from(n,e=>e.attrs)]});jg=Fg(Ae,jl);Ug=n=>{let e=n.state.field(Ae,!1);return n.state.readOnly||!e||!e.open||e.open.selected<0||e.open.disabled||Date.now()-e.open.timestamp<n.state.facet(oe).interactionDelay?!1:jl(n,e.open.options[e.open.selected])},Ll=n=>n.state.field(Ae,!1)?(n.dispatch({effects:Us.of(!0)}),!0):!1,Gg=n=>{let e=n.state.field(Ae,!1);return!e||!e.active.some(t=>t.state!=0)?!1:(n.dispatch({effects:wn.of(null)}),!0)},Hl=class{constructor(e,t){this.active=e,this.context=t,this.time=Date.now(),this.updates=[],this.done=void 0}},_g=50,Yg=1e3,Xg=_.fromClass(class{constructor(n){this.view=n,this.debounceUpdate=-1,this.running=[],this.debounceAccept=-1,this.pendingStart=!1,this.composing=0;for(let e of n.state.field(Ae).active)e.isPending&&this.startQuery(e)}update(n){let e=n.state.field(Ae),t=n.state.facet(oe);if(!n.selectionSet&&!n.docChanged&&n.startState.field(Ae)==e)return;let i=n.transactions.some(r=>{let o=$f(r,t);return o&8||(r.selection||r.docChanged)&&!(o&3)});for(let r=0;r<this.running.length;r++){let o=this.running[r];if(i||o.context.abortOnDocChange&&n.docChanged||o.updates.length+n.transactions.length>_g&&Date.now()-o.time>Yg){for(let l of o.context.abortListeners)try{l()}catch(a){he(this.view.state,a)}o.context.abortListeners=null,this.running.splice(r--,1)}else o.updates.push(...n.transactions)}this.debounceUpdate>-1&&clearTimeout(this.debounceUpdate),n.transactions.some(r=>r.effects.some(o=>o.is(Us)))&&(this.pendingStart=!0);let s=this.pendingStart?50:t.activateOnTypingDelay;if(this.debounceUpdate=e.active.some(r=>r.isPending&&!this.running.some(o=>o.active.source==r.source))?setTimeout(()=>this.startUpdate(),s):-1,this.composing!=0)for(let r of n.transactions)r.isUserEvent("input.type")?this.composing=2:this.composing==2&&r.selection&&(this.composing=3)}startUpdate(){this.debounceUpdate=-1,this.pendingStart=!1;let{state:n}=this.view,e=n.field(Ae);for(let t of e.active)t.isPending&&!this.running.some(i=>i.active.source==t.source)&&this.startQuery(t);this.running.length&&e.open&&e.open.disabled&&(this.debounceAccept=setTimeout(()=>this.accept(),this.view.state.facet(oe).updateSyncTime))}startQuery(n){let{state:e}=this.view,t=Qt(e),i=new $s(e,t,n.explicit,this.view),s=new Hl(n,i);this.running.push(s),Promise.resolve(n.source(i)).then(r=>{s.context.aborted||(s.done=r||null,this.scheduleAccept())},r=>{this.view.dispatch({effects:wn.of(null)}),he(this.view.state,r)})}scheduleAccept(){this.running.every(n=>n.done!==void 0)?this.accept():this.debounceAccept<0&&(this.debounceAccept=setTimeout(()=>this.accept(),this.view.state.facet(oe).updateSyncTime))}accept(){var n;this.debounceAccept>-1&&clearTimeout(this.debounceAccept),this.debounceAccept=-1;let e=[],t=this.view.state.facet(oe),i=this.view.state.field(Ae);for(let s=0;s<this.running.length;s++){let r=this.running[s];if(r.done===void 0)continue;if(this.running.splice(s--,1),r.done){let l=Qt(r.updates.length?r.updates[0].startState:this.view.state),a=Math.min(l,r.done.from+(r.active.explicit?0:1)),h=new Gs(r.active.source,r.active.explicit,a,r.done,r.done.from,(n=r.done.to)!==null&&n!==void 0?n:l);for(let c of r.updates)h=h.update(c,t);if(h.hasResult()){e.push(h);continue}}let o=i.active.find(l=>l.source==r.active.source);if(o&&o.isPending)if(r.done==null){let l=new gt(r.active.source,0);for(let a of r.updates)l=l.update(a,t);l.isPending||e.push(l)}else this.startQuery(o)}(e.length||i.open&&i.open.disabled)&&this.view.dispatch({effects:$l.of(e)})}},{eventHandlers:{blur(n){let e=this.view.state.field(Ae,!1);if(e&&e.tooltip&&this.view.state.facet(oe).closeOnBlur){let t=e.open&&tl(this.view,e.open.tooltip);(!t||!t.dom.contains(n.relatedTarget))&&setTimeout(()=>this.view.dispatch({effects:wn.of(null)}),10)}},compositionstart(){this.composing=1},compositionend(){this.composing==3&&setTimeout(()=>this.view.dispatch({effects:Us.of(!1)}),20),this.composing=0}}}),Jg=typeof navigator=="object"&&/Win/.test(navigator.platform),Qg=Fe.highest(M.domEventHandlers({keydown(n,e){let t=e.state.field(Ae,!1);if(!t||!t.open||t.open.disabled||t.open.selected<0||!n.key||n.key.length>1||n.ctrlKey&&!(Jg&&n.altKey)||n.metaKey)return!1;let i=t.open.options[t.open.selected],s=t.active.find(o=>o.source==i.source),r=i.completion.commitCharacters||s.result.commitCharacters;return r&&r.indexOf(n.key)>-1&&jl(e,i),!1}})),jf=M.baseTheme({".cm-tooltip.cm-tooltip-autocomplete":{"& > ul":{fontFamily:"monospace",whiteSpace:"nowrap",overflow:"hidden auto",maxWidth_fallback:"700px",maxWidth:"min(700px, 95vw)",minWidth:"250px",maxHeight:"10em",height:"100%",listStyle:"none",margin:0,padding:0,"& > li, & > completion-section":{padding:"1px 3px",lineHeight:1.2},"& > li":{overflowX:"hidden",textOverflow:"ellipsis",cursor:"pointer"},"& > completion-section":{display:"list-item",borderBottom:"1px solid silver",paddingLeft:"0.5em",opacity:.7}}},"&light .cm-tooltip-autocomplete ul li[aria-selected]":{background:"#17c",color:"white"},"&light .cm-tooltip-autocomplete-disabled ul li[aria-selected]":{background:"#777"},"&dark .cm-tooltip-autocomplete ul li[aria-selected]":{background:"#347",color:"white"},"&dark .cm-tooltip-autocomplete-disabled ul li[aria-selected]":{background:"#444"},".cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after":{content:'"\xB7\xB7\xB7"',opacity:.5,display:"block",textAlign:"center",cursor:"pointer"},".cm-tooltip.cm-completionInfo":{position:"absolute",padding:"3px 9px",width:"max-content",maxWidth:"400px",boxSizing:"border-box",whiteSpace:"pre-line"},".cm-completionInfo.cm-completionInfo-left":{right:"100%"},".cm-completionInfo.cm-completionInfo-right":{left:"100%"},".cm-completionInfo.cm-completionInfo-left-narrow":{right:"30px"},".cm-completionInfo.cm-completionInfo-right-narrow":{left:"30px"},"&light .cm-snippetField":{backgroundColor:"#00000022"},"&dark .cm-snippetField":{backgroundColor:"#ffffff22"},".cm-snippetFieldPosition":{verticalAlign:"text-top",width:0,height:"1.15em",display:"inline-block",margin:"0 -0.7px -.7em",borderLeft:"1.4px dotted #888"},".cm-completionMatchedText":{textDecoration:"underline"},".cm-completionDetail":{marginLeft:"0.5em",fontStyle:"italic"},".cm-completionIcon":{fontSize:"90%",width:".8em",display:"inline-block",textAlign:"center",paddingRight:".6em",opacity:"0.6",boxSizing:"content-box"},".cm-completionIcon-function, .cm-completionIcon-method":{"&:after":{content:"'\u0192'"}},".cm-completionIcon-class":{"&:after":{content:"'\u25CB'"}},".cm-completionIcon-interface":{"&:after":{content:"'\u25CC'"}},".cm-completionIcon-variable":{"&:after":{content:"'\u{1D465}'"}},".cm-completionIcon-constant":{"&:after":{content:"'\u{1D436}'"}},".cm-completionIcon-type":{"&:after":{content:"'\u{1D461}'"}},".cm-completionIcon-enum":{"&:after":{content:"'\u222A'"}},".cm-completionIcon-property":{"&:after":{content:"'\u25A1'"}},".cm-completionIcon-keyword":{"&:after":{content:"'\u{1F511}\uFE0E'"}},".cm-completionIcon-namespace":{"&:after":{content:"'\u25A2'"}},".cm-completionIcon-text":{"&:after":{content:"'abc'",fontSize:"50%",verticalAlign:"middle"}}}),Wl=class{constructor(e,t,i,s){this.field=e,this.line=t,this.from=i,this.to=s}},Vl=class n{constructor(e,t,i){this.field=e,this.from=t,this.to=i}map(e){let t=e.mapPos(this.from,-1,ne.TrackDel),i=e.mapPos(this.to,1,ne.TrackDel);return t==null||i==null?null:new n(this.field,t,i)}},zl=class n{constructor(e,t){this.lines=e,this.fieldPositions=t}instantiate(e,t){let i=[],s=[t],r=e.doc.lineAt(t),o=/^\s*/.exec(r.text)[0];for(let a of this.lines){if(i.length){let h=o,c=/^\t*/.exec(a)[0].length;for(let f=0;f<c;f++)h+=e.facet(Mi);s.push(t+h.length-c),a=h+a.slice(c)}i.push(a),t+=a.length+1}let l=this.fieldPositions.map(a=>new Vl(a.field,s[a.line]+a.from,s[a.line]+a.to));return{text:i,ranges:l}}static parse(e){let t=[],i=[],s=[],r;for(let o of e.split(/\r\n?|\n/)){for(;r=/[#$]\{(?:(\d+)(?::([^{}]*))?|((?:\\[{}]|[^{}])*))\}/.exec(o);){let l=r[1]?+r[1]:null,a=r[2]||r[3]||"",h=-1;l===0&&(l=1e9);let c=a.replace(/\\[{}]/g,f=>f[1]);for(let f=0;f<t.length;f++)(l!=null?t[f].seq==l:c&&t[f].name==c)&&(h=f);if(h<0){let f=0;for(;f<t.length&&(l==null||t[f].seq!=null&&t[f].seq<l);)f++;t.splice(f,0,{seq:l,name:c}),h=f;for(let u of s)u.field>=h&&u.field++}for(let f of s)if(f.line==i.length&&f.from>r.index){let u=r[2]?3+(r[1]||"").length:2;f.from-=u,f.to-=u}s.push(new Wl(h,i.length,r.index,r.index+c.length)),o=o.slice(0,r.index)+a+o.slice(r.index+r[0].length)}o=o.replace(/\\([{}])/g,(l,a,h)=>{for(let c of s)c.line==i.length&&c.from>h&&(c.from--,c.to--);return a}),i.push(o)}return new n(i,s)}},Zg=B.widget({widget:new class extends we{toDOM(){let n=document.createElement("span");return n.className="cm-snippetFieldPosition",n}ignoreEvent(){return!1}}}),e0=B.mark({class:"cm-snippetField"}),Di=class n{constructor(e,t){this.ranges=e,this.active=t,this.deco=B.set(e.map(i=>(i.from==i.to?Zg:e0).range(i.from,i.to)),!0)}map(e){let t=[];for(let i of this.ranges){let s=i.map(e);if(!s)return null;t.push(s)}return new n(t,this.active)}selectionInsideField(e){return e.ranges.every(t=>this.ranges.some(i=>i.field==this.active&&i.from<=t.from&&i.to>=t.to))}},Sn=L.define({map(n,e){return n&&n.map(e)}}),t0=L.define(),kn=Q.define({create(){return null},update(n,e){for(let t of e.effects){if(t.is(Sn))return t.value;if(t.is(t0)&&n)return new Di(n.ranges,t.value)}return n&&e.docChanged&&(n=n.map(e.changes)),n&&e.selection&&!n.selectionInsideField(e.selection)&&(n=null),n},provide:n=>M.decorations.from(n,e=>e?e.deco:B.none)});n0=({state:n,dispatch:e})=>n.field(kn,!1)?(e(n.update({effects:Sn.of(null)})),!0):!1,s0=Uf(1),r0=Uf(-1),o0=[{key:"Tab",run:s0,shift:r0},{key:"Escape",run:n0}],Vf=A.define({combine(n){return n.length?n[0]:o0}}),l0=Fe.highest(vt.compute([Vf],n=>n.facet(Vf)));a0=M.domEventHandlers({mousedown(n,e){let t=e.state.field(kn,!1),i;if(!t||(i=e.posAtCoords({x:n.clientX,y:n.clientY}))==null)return!1;let s=t.ranges.find(r=>r.from<=i&&r.to>=i);return!s||s.field==t.active?!1:(e.dispatch({selection:Ul(t.ranges,s.field),effects:Sn.of(t.ranges.some(r=>r.field>s.field)?new Di(t.ranges,s.field):null),scrollIntoView:!0}),!0)}}),vn={brackets:["(","[","{","'",'"'],before:")]}:;>",stringPrefixes:[]},Jt=L.define({map(n,e){let t=e.mapPos(n,-1,ne.TrackAfter);return t??void 0}}),Gl=new class extends Ne{};Gl.startSide=1;Gl.endSide=-1;_f=Q.define({create(){return H.empty},update(n,e){if(n=n.map(e.changes),e.selection){let t=e.state.doc.lineAt(e.selection.main.head);n=n.update({filter:i=>i>=t.from&&i<=t.to})}for(let t of e.effects)t.is(Jt)&&(n=n.update({add:[Gl.range(t.value,t.value+1)]}));return n}});El="()[]{}<>\xAB\xBB\xBB\xAB\uFF3B\uFF3D\uFF5B\uFF5D";h0=typeof navigator=="object"&&/Android\b/.test(navigator.userAgent),c0=M.inputHandler.of((n,e,t,i)=>{if((h0?n.composing:n.compositionStarted)||n.state.readOnly)return!1;let s=n.state.selection.main;if(i.length>2||i.length==2&&Oe(ae(i,0))==1||e!=s.from||t!=s.to)return!1;let r=u0(n.state,i);return r?(n.dispatch(r),!0):!1}),f0=({state:n,dispatch:e})=>{if(n.readOnly)return!1;let i=Jf(n,n.selection.main.head).brackets||vn.brackets,s=null,r=n.changeByRange(o=>{if(o.empty){let l=d0(n.doc,o.head);for(let a of i)if(a==l&&_s(n.doc,o.head)==Xf(ae(a,0)))return{changes:{from:o.head-a.length,to:o.head+a.length},range:b.cursor(o.head-a.length)}}return{range:s=o}});return s||e(n.update(r,{scrollIntoView:!0,userEvent:"delete.backward"})),!s},Qf=[{key:"Backspace",run:f0}];_l=[{key:"Ctrl-Space",run:Ll},{mac:"Alt-`",run:Ll},{mac:"Alt-i",run:Ll},{key:"Escape",run:Gg},{key:"ArrowDown",run:Ks(!0)},{key:"ArrowUp",run:Ks(!1)},{key:"PageDown",run:Ks(!0,"page")},{key:"PageUp",run:Ks(!1,"page")},{key:"Enter",run:Ug}],b0=Fe.highest(vt.computeN([oe],n=>n.facet(oe).defaultKeymap?[_l]:[]))});function ea(n,e){return({state:t,dispatch:i})=>{if(t.readOnly)return!1;let s=n(e,t);return s?(i(t.update(s)),!0):!1}}function ta(n,e){let t=n.languageDataAt("commentTokens",e,1);return t.length?t[0]:{}}function S0(n,{open:e,close:t},i,s){let r=n.sliceDoc(i-Cn,i),o=n.sliceDoc(s,s+Cn),l=/\s*$/.exec(r)[0].length,a=/^\s*/.exec(o)[0].length,h=r.length-l;if(r.slice(h-e.length,h)==e&&o.slice(a,a+t.length)==t)return{open:{pos:i-l,margin:l&&1},close:{pos:s+a,margin:a&&1}};let c,f;s-i<=2*Cn?c=f=n.sliceDoc(i,s):(c=n.sliceDoc(i,i+Cn),f=n.sliceDoc(s-Cn,s));let u=/^\s*/.exec(c)[0].length,d=/\s*$/.exec(f)[0].length,p=f.length-d-t.length;return c.slice(u,u+e.length)==e&&f.slice(p,p+t.length)==t?{open:{pos:i+u+e.length,margin:/\s/.test(c.charAt(u+e.length))?1:0},close:{pos:s-d-t.length,margin:/\s/.test(f.charAt(p-1))?1:0}}:null}function C0(n){let e=[];for(let t of n.selection.ranges){let i=n.doc.lineAt(t.from),s=t.to<=i.to?i:n.doc.lineAt(t.to);s.from>i.from&&s.from==t.to&&(s=t.to==i.to+1?i:n.doc.lineAt(t.to-1));let r=e.length-1;r>=0&&e[r].to>i.from?e[r].to=s.to:e.push({from:i.from+/^\s*/.exec(i.text)[0].length,to:s.to})}return e}function hu(n,e,t=e.selection.ranges){let i=t.map(r=>ta(e,r.from).block);if(!i.every(r=>r))return null;let s=t.map((r,o)=>S0(e,i[o],r.from,r.to));if(n!=2&&!s.every(r=>r))return{changes:e.changes(t.map((r,o)=>s[o]?[]:[{from:r.from,insert:i[o].open+" "},{from:r.to,insert:" "+i[o].close}]))};if(n!=1&&s.some(r=>r)){let r=[];for(let o=0,l;o<s.length;o++)if(l=s[o]){let a=i[o],{open:h,close:c}=l;r.push({from:h.pos-a.open.length,to:h.pos+h.margin},{from:c.pos-c.margin,to:c.pos+a.close.length})}return{changes:r}}return null}function A0(n,e,t=e.selection.ranges){let i=[],s=-1;e:for(let{from:r,to:o}of t){let l=i.length,a=1e9,h;for(let c=r;c<=o;){let f=e.doc.lineAt(c);if(h==null&&(h=ta(e,f.from).line,!h))continue e;if(f.from>s&&(r==o||o>f.from)){s=f.from;let u=/^\s*/.exec(f.text)[0].length,d=u==f.length,p=f.text.slice(u,u+h.length)==h?u:-1;u<f.text.length&&u<a&&(a=u),i.push({line:f,comment:p,token:h,indent:u,empty:d,single:!1})}c=f.to+1}if(a<1e9)for(let c=l;c<i.length;c++)i[c].indent<i[c].line.text.length&&(i[c].indent=a);i.length==l+1&&(i[l].single=!0)}if(n!=2&&i.some(r=>r.comment<0&&(!r.empty||r.single))){let r=[];for(let{line:l,token:a,indent:h,empty:c,single:f}of i)(f||!c)&&r.push({from:l.from+h,insert:a+" "});let o=e.changes(r);return{changes:o,selection:e.selection.map(o,1)}}else if(n!=1&&i.some(r=>r.comment>=0)){let r=[];for(let{line:o,comment:l,token:a}of i)if(l>=0){let h=o.from+l,c=h+a.length;o.text[c-o.from]==" "&&c++,r.push({from:h,to:c})}return{changes:r}}return null}function uu(n={}){return[fu,cu.of(n),M.domEventHandlers({beforeinput(e,t){let i=e.inputType=="historyUndo"?An:e.inputType=="historyRedo"?Oi:null;return i?(e.preventDefault(),i(t)):!1}})]}function Js(n,e){return function({state:t,dispatch:i}){if(!e&&t.readOnly)return!1;let s=t.field(fu,!1);if(!s)return!1;let r=s.pop(n,t,e);return r?(i(r),!0):!1}}function Xs(n,e,t,i){let s=e+1>t+20?e-t-1:0,r=n.slice(s,e);return r.push(i),r}function B0(n,e){let t=[],i=!1;return n.iterChangedRanges((s,r)=>t.push(s,r)),e.iterChangedRanges((s,r,o,l)=>{for(let a=0;a<t.length;){let h=t[a++],c=t[a++];l>=h&&o<=c&&(i=!0)}}),i}function L0(n,e){return n.ranges.length==e.ranges.length&&n.ranges.filter((t,i)=>t.empty!=e.ranges[i].empty).length===0}function du(n,e){return n.length?e.length?n.concat(e):n:e}function pu(n,e){if(n.length){let t=n[n.length-1],i=t.selectionsAfter.slice(Math.max(0,t.selectionsAfter.length-E0));return i.length&&i[i.length-1].eq(e)?n:(i.push(e),Xs(n,n.length-1,1e9,t.setSelAfter(i)))}else return[Xe.selection([e])]}function R0(n){let e=n[n.length-1],t=n.slice();return t[n.length-1]=e.setSelAfter(e.selectionsAfter.slice(0,e.selectionsAfter.length-1)),t}function Xl(n,e){if(!n.length)return n;let t=n.length,i=qe;for(;t;){let s=P0(n[t-1],e,i);if(s.changes&&!s.changes.empty||s.effects.length){let r=n.slice(0,t);return r[t-1]=s,r}else e=s.mapped,t--,i=s.selectionsAfter}return i.length?[Xe.selection(i)]:qe}function P0(n,e,t){let i=du(n.selectionsAfter.length?n.selectionsAfter.map(l=>l.map(e)):qe,t);if(!n.changes)return Xe.selection(i);let s=n.changes.map(e),r=e.mapDesc(n.changes,!0),o=n.mapped?n.mapped.composeDesc(r):r;return new Xe(s,L.mapEffects(n.effects,e),o,n.startSelection.map(r),i)}function Bi(n,e){return b.create(n.ranges.map(e),n.mainIndex)}function Je(n,e){return n.update({selection:e,scrollIntoView:!0,userEvent:"select"})}function Qe({state:n,dispatch:e},t){let i=Bi(n.selection,t);return i.eq(n.selection,!0)?!1:(e(Je(n,i)),!0)}function Qs(n,e){return b.cursor(e?n.to:n.from)}function gu(n,e){return Qe(n,t=>t.empty?n.moveByChar(t,e):Qs(t,e))}function me(n){return n.textDirectionAt(n.state.selection.main.head)==q.LTR}function xu(n,e){return Qe(n,t=>t.empty?n.moveByGroup(t,e):Qs(t,e))}function H0(n,e,t){if(e.type.prop(t))return!0;let i=e.to-e.from;return i&&(i>2||/[^\s,.;:]/.test(n.sliceDoc(e.from,e.to)))||e.firstChild}function Zs(n,e,t){let i=re(n).resolveInner(e.head),s=t?P.closedBy:P.openedBy;for(let a=e.head;;){let h=t?i.childAfter(a):i.childBefore(a);if(!h)break;H0(n,h,s)?i=h:a=t?h.to:h.from}let r=i.type.prop(s),o,l;return r&&(o=t?Ye(n,i.from,1):Ye(n,i.to,-1))&&o.matched?l=t?o.end.to:o.end.from:l=t?i.to:i.from,b.cursor(l,t?-1:1)}function wu(n,e){return Qe(n,t=>{if(!t.empty)return Qs(t,e);let i=n.moveVertically(t,e);return i.head!=t.head?i:n.moveToLineBoundary(t,e)})}function Su(n){let e=n.scrollDOM.clientHeight<n.scrollDOM.scrollHeight-2,t=0,i=0,s;if(e){for(let r of n.state.facet(M.scrollMargins)){let o=r(n);o?.top&&(t=Math.max(o?.top,t)),o?.bottom&&(i=Math.max(o?.bottom,i))}s=n.scrollDOM.clientHeight-t-i}else s=(n.dom.ownerDocument.defaultView||window).innerHeight;return{marginTop:t,marginBottom:i,selfScroll:e,height:Math.max(n.defaultLineHeight,s-5)}}function Cu(n,e){let t=Su(n),{state:i}=n,s=Bi(i.selection,o=>o.empty?n.moveVertically(o,e,t.height):Qs(o,e));if(s.eq(i.selection))return!1;let r;if(t.selfScroll){let o=n.coordsAtPos(i.selection.main.head),l=n.scrollDOM.getBoundingClientRect(),a=l.top+t.marginTop,h=l.bottom-t.marginBottom;o&&o.top>a&&o.bottom<h&&(r=M.scrollIntoView(s.main.head,{y:"start",yMargin:o.top-a}))}return n.dispatch(Je(i,s),{effects:r}),!0}function Ot(n,e,t){let i=n.lineBlockAt(e.head),s=n.moveToLineBoundary(e,t);if(s.head==e.head&&s.head!=(t?i.to:i.from)&&(s=n.moveToLineBoundary(e,t,!1)),!t&&s.head==i.from&&i.length){let r=/^\s*/.exec(n.state.sliceDoc(i.from,Math.min(i.from+100,i.to)))[0].length;r&&e.head!=i.from+r&&(s=b.cursor(i.from+r))}return s}function G0(n,e,t){let i=!1,s=Bi(n.selection,r=>{let o=Ye(n,r.head,-1)||Ye(n,r.head,1)||r.head>0&&Ye(n,r.head-1,1)||r.head<n.doc.length&&Ye(n,r.head+1,-1);if(!o||!o.end)return r;i=!0;let l=o.start.from==r.head?o.end.to:o.end.from;return t?b.range(r.anchor,l):b.cursor(l)});return i?(e(Je(n,s)),!0):!1}function Ke(n,e,t){let i=Bi(n.state.selection,s=>{s.undirectional&&s.head>=s.anchor!=e&&(s=b.range(s.head,s.anchor));let r=t(s);return b.range(s.anchor,r.head,r.goalColumn,r.bidiLevel||void 0,r.assoc)});return i.eq(n.state.selection)?!1:(n.dispatch(Je(n.state,i)),!0)}function Au(n,e){return Ke(n,e,t=>n.moveByChar(t,e))}function Du(n,e){return Ke(n,e,t=>n.moveByGroup(t,e))}function Ou(n,e){return Ke(n,e,t=>n.moveVertically(t,e))}function Eu(n,e){return Ke(n,e,t=>n.moveVertically(t,e,Su(n).height))}function Ru(n,e){let{state:t}=n,i=t.selection,s=t.selection.ranges.slice();for(let r of t.selection.ranges){let o=t.doc.lineAt(r.head);if(e?o.to<n.state.doc.length:o.from>0)for(let l=r;;){let a=n.moveVertically(l,e);if(a.head<o.from||a.head>o.to){s.some(h=>h.head==a.head)||s.push(a);break}else{if(a.head==l.head)break;l=a}}}return s.length==i.ranges.length?!1:(n.dispatch(Je(t,b.create(s,s.length-1))),!0)}function Mn(n,e){if(n.state.readOnly)return!1;let t="delete.selection",{state:i}=n,s=i.changeByRange(r=>{let{from:o,to:l}=r;if(o==l){let a=e(r);a<o?(t="delete.backward",a=Ys(n,a,!1)):a>o&&(t="delete.forward",a=Ys(n,a,!0)),o=Math.min(o,a),l=Math.max(l,a)}else o=Ys(n,o,!1),l=Ys(n,l,!0);return o==l?{range:r}:{changes:{from:o,to:l},range:b.cursor(o,o<r.head?-1:1)}});return s.changes.empty?!1:(n.dispatch(i.update(s,{scrollIntoView:!0,userEvent:t,effects:t=="delete.selection"?M.announce.of(i.phrase("Selection deleted")):void 0})),!0)}function Ys(n,e,t){if(n instanceof M)for(let i of n.state.facet(M.atomicRanges).map(s=>s(n)))i.between(e,e,(s,r)=>{s<e&&r>e&&(e=t?r:s)});return e}function er(n){let e=[],t=-1;for(let i of n.selection.ranges){let s=n.doc.lineAt(i.from),r=n.doc.lineAt(i.to);if(!i.empty&&i.to==r.from&&(r=n.doc.lineAt(i.to-1)),t>=s.number){let o=e[e.length-1];o.to=r.to,o.ranges.push(i)}else e.push({from:s.from,to:r.to,ranges:[i]});t=r.number+1}return e}function Hu(n,e,t){if(n.readOnly)return!1;let i=[],s=[];for(let r of er(n)){if(t?r.to==n.doc.length:r.from==0)continue;let o=n.doc.lineAt(t?r.to+1:r.from-1),l=o.length+1;if(t){i.push({from:r.to,to:o.to},{from:r.from,insert:o.text+n.lineBreak});for(let a of r.ranges)s.push(b.range(Math.min(n.doc.length,a.anchor+l),Math.min(n.doc.length,a.head+l)))}else{i.push({from:o.from,to:r.from},{from:r.to,insert:n.lineBreak+o.text});for(let a of r.ranges)s.push(b.range(a.anchor-l,a.head-l))}}return i.length?(e(n.update({changes:i,scrollIntoView:!0,selection:b.create(s,n.selection.mainIndex),userEvent:"move.line"})),!0):!1}function Wu(n,e,t){if(n.readOnly)return!1;let i=[];for(let r of er(n))t?i.push({from:r.from,insert:n.doc.slice(r.from,r.to)+n.lineBreak}):i.push({from:r.to,insert:n.lineBreak+n.doc.slice(r.from,r.to)});let s=n.changes(i);return e(n.update({changes:s,selection:n.selection.map(s,t?1:-1),scrollIntoView:!0,userEvent:"input.copyline"})),!0}function vy(n,e){if(/\(\)|\[\]|\{\}/.test(n.sliceDoc(e-1,e+1)))return{from:e,to:e};let t=re(n).resolveInner(e),i=t.childBefore(e),s=t.childAfter(e),r;return i&&s&&i.to<=e&&s.from>=e&&(r=i.type.prop(P.closedBy))&&r.indexOf(s.name)>-1&&n.doc.lineAt(i.to).from==n.doc.lineAt(s.from).from&&!/\S/.test(n.sliceDoc(i.to,s.from))?{from:i.to,to:s.from}:null}function Vu(n){return({state:e,dispatch:t})=>{if(e.readOnly)return!1;let i=e.changeByRange(s=>{let{from:r,to:o}=s,l=e.doc.lineAt(r),a=!n&&r==o&&vy(e,r);n&&(r=o=(o<=l.to?l:e.doc.lineAt(o)).to);let h=new Yt(e,{simulateBreak:r,simulateDoubleBreak:!!a}),c=Ws(h,r);for(c==null&&(c=ct(/^\s*/.exec(e.doc.lineAt(r).text)[0],e.tabSize));o<l.to&&/\s/.test(l.text[o-l.from]);)o++;a?{from:r,to:o}=a:r>l.from&&r<l.from+100&&!/\S/.test(l.text.slice(0,r))&&(r=l.from);let f=["",Ti(e,c)];return a&&f.push(Ti(e,h.lineIndent(l.from,-1))),{changes:{from:r,to:o,insert:N.of(f)},range:b.cursor(r+1+f[1].length)}});return t(e.update(i,{scrollIntoView:!0,userEvent:"input"})),!0}}function ia(n,e){let t=-1;return n.changeByRange(i=>{let s=[];for(let o=i.from;o<=i.to;){let l=n.doc.lineAt(o);l.number>t&&(i.empty||i.to>l.from)&&(e(l,s,i),t=l.number),o=l.to+1}let r=n.changes(s);return{changes:s,range:b.range(r.mapPos(i.anchor,1),r.mapPos(i.head,1))}})}var x0,w0,k0,v0,Cn,Jl,M0,T0,cu,fu,An,Oi,D0,O0,Xe,qe,E0,I0,Zt,mu,yu,bu,N0,F0,O1,W0,V0,ku,vu,tu,Ql,z0,q0,K0,$0,j0,U0,_0,Mu,Tu,Y0,X0,J0,Q0,Bu,Lu,iu,nu,Z0,ey,ty,iy,ny,sy,su,ru,ou,lu,ry,oy,ly,ay,hy,cy,Pu,Zl,Iu,Nu,Fu,fy,uy,dy,py,my,gy,yy,by,xy,wy,ky,au,Sy,Cy,Ay,My,Ty,Dy,Oy,zu,na=ye(()=>{ft();St();xn();Bs();x0=n=>{let{state:e}=n,t=e.doc.lineAt(e.selection.main.from),i=ta(n.state,t.from);return i.line?w0(n):i.block?v0(n):!1};w0=ea(A0,0),k0=ea(hu,0),v0=ea((n,e)=>hu(n,e,C0(e)),0);Cn=50;Jl=Se.define(),M0=Se.define(),T0=A.define(),cu=A.define({combine(n){return pe(n,{minDepth:100,newGroupDelay:500,joinToEvent:(e,t)=>t},{minDepth:Math.max,newGroupDelay:Math.min,joinToEvent:(e,t)=>(i,s)=>e(i,s)||t(i,s)})}}),fu=Q.define({create(){return Zt.empty},update(n,e){let t=e.state.facet(cu),i=e.annotation(Jl);if(i){let a=Xe.fromTransaction(e,i.selection),h=i.side,c=h==0?n.undone:n.done;return a?c=Xs(c,c.length,t.minDepth,a):c=pu(c,e.startState.selection),new Zt(h==0?i.rest:c,h==0?c:i.rest)}let s=e.annotation(M0);if((s=="full"||s=="before")&&(n=n.isolate()),e.annotation(te.addToHistory)===!1)return e.changes.empty?n:n.addMapping(e.changes.desc);let r=Xe.fromTransaction(e),o=e.annotation(te.time),l=e.annotation(te.userEvent);return r?n=n.addChanges(r,o,l,t,e):e.selection&&(n=n.addSelection(e.startState.selection,o,l,t.newGroupDelay)),(s=="full"||s=="after")&&(n=n.isolate()),n},toJSON(n){return{done:n.done.map(e=>e.toJSON()),undone:n.undone.map(e=>e.toJSON())}},fromJSON(n){return new Zt(n.done.map(Xe.fromJSON),n.undone.map(Xe.fromJSON))}});An=Js(0,!1),Oi=Js(1,!1),D0=Js(0,!0),O0=Js(1,!0),Xe=class n{constructor(e,t,i,s,r){this.changes=e,this.effects=t,this.mapped=i,this.startSelection=s,this.selectionsAfter=r}setSelAfter(e){return new n(this.changes,this.effects,this.mapped,this.startSelection,e)}toJSON(){var e,t,i;return{changes:(e=this.changes)===null||e===void 0?void 0:e.toJSON(),mapped:(t=this.mapped)===null||t===void 0?void 0:t.toJSON(),startSelection:(i=this.startSelection)===null||i===void 0?void 0:i.toJSON(),selectionsAfter:this.selectionsAfter.map(s=>s.toJSON())}}static fromJSON(e){return new n(e.changes&&be.fromJSON(e.changes),[],e.mapped&&ht.fromJSON(e.mapped),e.startSelection&&b.fromJSON(e.startSelection),e.selectionsAfter.map(b.fromJSON))}static fromTransaction(e,t){let i=qe;for(let s of e.startState.facet(T0)){let r=s(e);r.length&&(i=i.concat(r))}return!i.length&&e.changes.empty?null:new n(e.changes.invert(e.startState.doc),i,void 0,t||e.startState.selection,qe)}static selection(e){return new n(void 0,qe,void 0,void 0,e)}};qe=[],E0=200;I0=/^(input\.type|delete)($|\.)/,Zt=class n{constructor(e,t,i=0,s=void 0){this.done=e,this.undone=t,this.prevTime=i,this.prevUserEvent=s}isolate(){return this.prevTime?new n(this.done,this.undone):this}addChanges(e,t,i,s,r){let o=this.done,l=o[o.length-1];return l&&l.changes&&!l.changes.empty&&e.changes&&(!i||I0.test(i))&&(!l.selectionsAfter.length&&t-this.prevTime<s.newGroupDelay&&s.joinToEvent(r,B0(l.changes,e.changes))||i=="input.type.compose")?o=Xs(o,o.length-1,s.minDepth,new Xe(e.changes.compose(l.changes),du(L.mapEffects(e.effects,l.changes),l.effects),l.mapped,l.startSelection,qe)):o=Xs(o,o.length,s.minDepth,e),new n(o,qe,t,i)}addSelection(e,t,i,s){let r=this.done.length?this.done[this.done.length-1].selectionsAfter:qe;return r.length>0&&t-this.prevTime<s&&i==this.prevUserEvent&&i&&/^select($|\.)/.test(i)&&L0(r[r.length-1],e)?this:new n(pu(this.done,e),this.undone,t,i)}addMapping(e){return new n(Xl(this.done,e),Xl(this.undone,e),this.prevTime,this.prevUserEvent)}pop(e,t,i){let s=e==0?this.done:this.undone;if(s.length==0)return null;let r=s[s.length-1],o=r.selectionsAfter[0]||(r.startSelection?r.startSelection.map(r.changes.invertedDesc,1):t.selection);if(i&&r.selectionsAfter.length)return t.update({selection:r.selectionsAfter[r.selectionsAfter.length-1],annotations:Jl.of({side:e,rest:R0(s),selection:o}),userEvent:e==0?"select.undo":"select.redo",scrollIntoView:!0});if(r.changes){let l=s.length==1?qe:s.slice(0,s.length-1);return r.mapped&&(l=Xl(l,r.mapped)),t.update({changes:r.changes,selection:r.startSelection,effects:r.effects,annotations:Jl.of({side:e,rest:l,selection:o}),filter:!1,userEvent:e==0?"undo":"redo",scrollIntoView:!0})}else return null}};Zt.empty=new Zt(qe,qe);mu=[{key:"Mod-z",run:An,preventDefault:!0},{key:"Mod-y",mac:"Mod-Shift-z",run:Oi,preventDefault:!0},{linux:"Ctrl-Shift-z",run:Oi,preventDefault:!0},{key:"Mod-u",run:D0,preventDefault:!0},{key:"Alt-u",mac:"Mod-Shift-u",run:O0,preventDefault:!0}];yu=n=>gu(n,!me(n)),bu=n=>gu(n,me(n));N0=n=>xu(n,!me(n)),F0=n=>xu(n,me(n)),O1=typeof Intl<"u"&&Intl.Segmenter?new Intl.Segmenter(void 0,{granularity:"word"}):null;W0=n=>Qe(n,e=>Zs(n.state,e,!me(n))),V0=n=>Qe(n,e=>Zs(n.state,e,me(n)));ku=n=>wu(n,!1),vu=n=>wu(n,!0);tu=n=>Cu(n,!1),Ql=n=>Cu(n,!0);z0=n=>Qe(n,e=>Ot(n,e,!0)),q0=n=>Qe(n,e=>Ot(n,e,!1)),K0=n=>Qe(n,e=>Ot(n,e,!me(n))),$0=n=>Qe(n,e=>Ot(n,e,me(n))),j0=n=>Qe(n,e=>n.moveToLineBoundary(e,!1,!1)),U0=n=>Qe(n,e=>n.moveToLineBoundary(e,!0,!1));_0=({state:n,dispatch:e})=>G0(n,e,!1);Mu=n=>Au(n,!me(n)),Tu=n=>Au(n,me(n));Y0=n=>Du(n,!me(n)),X0=n=>Du(n,me(n)),J0=n=>{let e=!me(n);return Ke(n,e,t=>Zs(n.state,t,e))},Q0=n=>{let e=me(n);return Ke(n,e,t=>Zs(n.state,t,e))};Bu=n=>Ou(n,!1),Lu=n=>Ou(n,!0);iu=n=>Eu(n,!1),nu=n=>Eu(n,!0),Z0=n=>Ke(n,!0,e=>Ot(n,e,!0)),ey=n=>Ke(n,!1,e=>Ot(n,e,!1)),ty=n=>{let e=!me(n);return Ke(n,e,t=>Ot(n,t,e))},iy=n=>{let e=me(n);return Ke(n,e,t=>Ot(n,t,e))},ny=n=>Ke(n,!1,e=>b.cursor(n.lineBlockAt(e.head).from)),sy=n=>Ke(n,!0,e=>b.cursor(n.lineBlockAt(e.head).to)),su=({state:n,dispatch:e})=>(e(Je(n,{anchor:0})),!0),ru=({state:n,dispatch:e})=>(e(Je(n,{anchor:n.doc.length})),!0),ou=({state:n,dispatch:e})=>(e(Je(n,{anchor:n.selection.main.anchor,head:0})),!0),lu=({state:n,dispatch:e})=>(e(Je(n,{anchor:n.selection.main.anchor,head:n.doc.length})),!0),ry=({state:n,dispatch:e})=>(e(n.update({selection:{anchor:0,head:n.doc.length},userEvent:"select"})),!0),oy=({state:n,dispatch:e})=>{let t=er(n).map(({from:i,to:s})=>b.undirectionalRange(i,Math.min(s+1,n.doc.length)));return e(n.update({selection:b.create(t),userEvent:"select"})),!0},ly=({state:n,dispatch:e})=>{let t=Bi(n.selection,i=>{let s=re(n),r=s.resolveStack(i.from,1);if(i.empty){let o=s.resolveStack(i.from,-1);o.node.from>=r.node.from&&o.node.to<=r.node.to&&(r=o)}for(let o=r;o;o=o.next){let{node:l}=o;if((l.from<i.from&&l.to>=i.to||l.to>i.to&&l.from<=i.from)&&o.next)return b.undirectionalRange(l.from,l.to)}return i});return t.eq(n.selection)?!1:(e(Je(n,t)),!0)};ay=n=>Ru(n,!1),hy=n=>Ru(n,!0),cy=({state:n,dispatch:e})=>{let t=n.selection,i=null;return t.ranges.length>1?i=b.create([t.main]):t.main.empty||(i=b.create([b.cursor(t.main.head)])),i?(e(Je(n,i)),!0):!1};Pu=(n,e,t)=>Mn(n,i=>{let s=i.from,{state:r}=n,o=r.doc.lineAt(s),l,a;if(t&&!e&&s>o.from&&s<o.from+200&&!/[^ \t]/.test(l=o.text.slice(0,s-o.from))){if(l[l.length-1]=="	")return s-1;let h=ct(l,r.tabSize),c=h%Dt(r)||Dt(r);for(let f=0;f<c&&l[l.length-1-f]==" ";f++)s--;a=s}else a=ee(o.text,s-o.from,e,e)+o.from,a==s&&o.number!=(e?r.doc.lines:1)?a+=e?1:-1:!e&&/[\ufe00-\ufe0f]/.test(o.text.slice(a-o.from,s-o.from))&&(a=ee(o.text,a-o.from,!1,!1)+o.from);return a}),Zl=n=>Pu(n,!1,!0),Iu=n=>Pu(n,!0,!1),Nu=(n,e)=>Mn(n,t=>{let i=t.head,{state:s}=n,r=s.doc.lineAt(i),o=s.charCategorizer(i);for(let l=null;;){if(i==(e?r.to:r.from)){i==t.head&&r.number!=(e?s.doc.lines:1)&&(i+=e?1:-1);break}let a=ee(r.text,i-r.from,e)+r.from,h=r.text.slice(Math.min(i,a)-r.from,Math.max(i,a)-r.from),c=o(h);if(l!=null&&c!=l)break;(h!=" "||i!=t.head)&&(l=c),i=a}return i}),Fu=n=>Nu(n,!1),fy=n=>Nu(n,!0),uy=n=>Mn(n,e=>{let t=n.lineBlockAt(e.head).to;return e.head<t?t:Math.min(n.state.doc.length,e.head+1)}),dy=n=>Mn(n,e=>{let t=n.moveToLineBoundary(e,!1).head;return e.head>t?t:Math.max(0,e.head-1)}),py=n=>Mn(n,e=>{let t=n.moveToLineBoundary(e,!0).head;return e.head<t?t:Math.min(n.state.doc.length,e.head+1)}),my=({state:n,dispatch:e})=>{if(n.readOnly)return!1;let t=n.changeByRange(i=>({changes:{from:i.from,to:i.to,insert:N.of(["",""])},range:b.cursor(i.from)}));return e(n.update(t,{scrollIntoView:!0,userEvent:"input"})),!0},gy=({state:n,dispatch:e})=>{if(n.readOnly)return!1;let t=n.changeByRange(i=>{if(!i.empty||i.from==0||i.from==n.doc.length)return{range:i};let s=i.from,r=n.doc.lineAt(s),o=s==r.from?s-1:ee(r.text,s-r.from,!1)+r.from,l=s==r.to?s+1:ee(r.text,s-r.from,!0)+r.from;return{changes:{from:o,to:l,insert:n.doc.slice(s,l).append(n.doc.slice(o,s))},range:b.cursor(l)}});return t.changes.empty?!1:(e(n.update(t,{scrollIntoView:!0,userEvent:"move.character"})),!0)};yy=({state:n,dispatch:e})=>Hu(n,e,!1),by=({state:n,dispatch:e})=>Hu(n,e,!0);xy=({state:n,dispatch:e})=>Wu(n,e,!1),wy=({state:n,dispatch:e})=>Wu(n,e,!0),ky=n=>{if(n.state.readOnly)return!1;let{state:e}=n,t=e.changes(er(e).map(({from:s,to:r})=>(s>0?s--:r<e.doc.length&&r++,{from:s,to:r}))),i=Bi(e.selection,s=>{let r;if(n.lineWrapping){let o=n.lineBlockAt(s.head),l=n.coordsAtPos(s.head,s.assoc||1);l&&(r=o.bottom+n.documentTop-l.bottom+n.defaultLineHeight/2)}return n.moveVertically(s,!0,r)}).map(t);return n.dispatch({changes:t,selection:i,scrollIntoView:!0,userEvent:"delete.line"}),!0};au=Vu(!1),Sy=Vu(!0);Cy=({state:n,dispatch:e})=>{if(n.readOnly)return!1;let t=Object.create(null),i=new Yt(n,{overrideIndentation:r=>{let o=t[r];return o??-1}}),s=ia(n,(r,o,l)=>{let a=Ws(i,r.from);if(a==null)return;/\S/.test(r.text)||(a=0);let h=/^\s*/.exec(r.text)[0],c=Ti(n,a);(h!=c||l.from<r.from+h.length)&&(t[r.from]=a,o.push({from:r.from,to:r.from+h.length,insert:c}))});return s.changes.empty||e(n.update(s,{userEvent:"indent"})),!0},Ay=({state:n,dispatch:e})=>n.readOnly?!1:(e(n.update(ia(n,(t,i)=>{i.push({from:t.from,insert:n.facet(Mi)})}),{userEvent:"input.indent"})),!0),My=({state:n,dispatch:e})=>n.readOnly?!1:(e(n.update(ia(n,(t,i)=>{let s=/^\s*/.exec(t.text)[0];if(!s)return;let r=ct(s,n.tabSize),o=0,l=Ti(n,Math.max(0,r-Dt(n)));for(;o<s.length&&o<l.length&&s.charCodeAt(o)==l.charCodeAt(o);)o++;i.push({from:t.from+o,to:t.from+s.length,insert:l.slice(o)})}),{userEvent:"delete.dedent"})),!0),Ty=n=>(n.setTabFocusMode(),!0),Dy=[{key:"Ctrl-b",run:yu,shift:Mu,preventDefault:!0},{key:"Ctrl-f",run:bu,shift:Tu},{key:"Ctrl-p",run:ku,shift:Bu},{key:"Ctrl-n",run:vu,shift:Lu},{key:"Ctrl-a",run:j0,shift:ny},{key:"Ctrl-e",run:U0,shift:sy},{key:"Ctrl-d",run:Iu},{key:"Ctrl-h",run:Zl},{key:"Ctrl-k",run:uy},{key:"Ctrl-Alt-h",run:Fu},{key:"Ctrl-o",run:my},{key:"Ctrl-t",run:gy},{key:"Ctrl-v",run:Ql}],Oy=[{key:"ArrowLeft",run:yu,shift:Mu,preventDefault:!0},{key:"Mod-ArrowLeft",mac:"Alt-ArrowLeft",run:N0,shift:Y0,preventDefault:!0},{mac:"Cmd-ArrowLeft",run:K0,shift:ty,preventDefault:!0},{key:"ArrowRight",run:bu,shift:Tu,preventDefault:!0},{key:"Mod-ArrowRight",mac:"Alt-ArrowRight",run:F0,shift:X0,preventDefault:!0},{mac:"Cmd-ArrowRight",run:$0,shift:iy,preventDefault:!0},{key:"ArrowUp",run:ku,shift:Bu,preventDefault:!0},{mac:"Cmd-ArrowUp",run:su,shift:ou},{mac:"Ctrl-ArrowUp",run:tu,shift:iu},{key:"ArrowDown",run:vu,shift:Lu,preventDefault:!0},{mac:"Cmd-ArrowDown",run:ru,shift:lu},{mac:"Ctrl-ArrowDown",run:Ql,shift:nu},{key:"PageUp",run:tu,shift:iu},{key:"PageDown",run:Ql,shift:nu},{key:"Home",run:q0,shift:ey,preventDefault:!0},{key:"Mod-Home",run:su,shift:ou},{key:"End",run:z0,shift:Z0,preventDefault:!0},{key:"Mod-End",run:ru,shift:lu},{key:"Enter",run:au,shift:au},{key:"Mod-a",run:ry},{key:"Backspace",run:Zl,shift:Zl,preventDefault:!0},{key:"Delete",run:Iu,preventDefault:!0},{key:"Mod-Backspace",mac:"Alt-Backspace",run:Fu,preventDefault:!0},{key:"Mod-Delete",mac:"Alt-Delete",run:fy,preventDefault:!0},{mac:"Mod-Backspace",run:dy,preventDefault:!0},{mac:"Mod-Delete",run:py,preventDefault:!0}].concat(Dy.map(n=>({mac:n.key,run:n.run,shift:n.shift}))),zu=[{key:"Alt-ArrowLeft",mac:"Ctrl-ArrowLeft",run:W0,shift:J0},{key:"Alt-ArrowRight",mac:"Ctrl-ArrowRight",run:V0,shift:Q0},{key:"Alt-ArrowUp",run:yy},{key:"Shift-Alt-ArrowUp",run:xy},{key:"Alt-ArrowDown",run:by},{key:"Shift-Alt-ArrowDown",run:wy},{key:"Mod-Alt-ArrowUp",run:ay},{key:"Mod-Alt-ArrowDown",run:hy},{key:"Escape",run:cy},{key:"Mod-Enter",run:Sy},{key:"Alt-l",mac:"Ctrl-l",run:oy},{key:"Mod-i",run:ly,preventDefault:!0},{key:"Mod-[",run:My},{key:"Mod-]",run:Ay},{key:"Mod-Alt-\\",run:Cy},{key:"Shift-Mod-k",run:ky},{key:"Shift-Mod-\\",run:_0},{key:"Mod-/",run:x0},{key:"Alt-A",mac:"Ctrl-A",run:k0},{key:"Ctrl-m",mac:"Shift-Alt-m",run:Ty}].concat(Oy)});function By(n){try{return new RegExp(n,ha),!0}catch{return!1}}function or(n,e){if(e>=n.length)return e;let t=n.lineAt(e),i;for(;e<t.to&&(i=t.text.charCodeAt(e-t.from))>=56320&&i<57344;)e++;return e}function Gu(n){let e=[Fy,Ny];return n&&e.push(Uu.of(n)),e}function Ku(n,e,t,i){return(t==0||n(e.sliceDoc(t-1,t))!=$.Word)&&(i==e.doc.length||n(e.sliceDoc(i,i+1))!=$.Word)}function Iy(n,e,t,i){return n(e.sliceDoc(t,t+1))==$.Word&&n(e.sliceDoc(i-1,i))==$.Word}function Wy(n,e){let{main:t,ranges:i}=n.selection,s=n.wordAt(t.head),r=s&&s.from==t.from&&s.to==t.to;for(let o=!1,l=new Lt(n.doc,e,i[i.length-1].to);;)if(l.next(),l.done){if(o)return null;l=new Lt(n.doc,e,0,Math.max(0,i[i.length-1].from-1)),o=!0}else{if(o&&i.some(a=>a.from==l.value.from))continue;if(r){let a=n.wordAt(l.value.from);if(!a||a.from!=l.value.from||a.to!=l.value.to)continue}return l.value}}function zy(n,e,t){return(i,s,r,o)=>{if(t&&!t(i,s,r,o))return!1;let l=i>=o&&s<=o+r.length?r.slice(i-o,s-o):e.doc.sliceString(i,s);return n(l,e,i,s)}}function Li(n,e,t,i){let s;return n.wholeWord&&(s=qy(e.doc,e.charCategorizer(e.selection.main.head))),n.test&&(s=zy(n.test,e,s)),new Lt(e.doc,n.unquoted,t,i,n.caseSensitive?void 0:r=>r.toLowerCase(),s)}function qy(n,e){return(t,i,s,r)=>((r>t||r+s.length<i)&&(r=Math.max(0,t-2),s=n.sliceString(r,Math.min(n.length,i+2))),(e(hr(s,t-r))!=$.Word||e(cr(s,t-r))!=$.Word)&&(e(cr(s,i-r))!=$.Word||e(hr(s,i-r))!=$.Word))}function Ky(n,e,t){return(i,s,r)=>(!t||t(i,s,r))&&n(r[0],e,i,s)}function Ei(n,e,t,i){let s;return n.wholeWord&&(s=$y(e.charCategorizer(e.selection.main.head))),n.test&&(s=Ky(n.test,e,s)),new nr(e.doc,n.search,{ignoreCase:!n.caseSensitive,test:s},t,i)}function hr(n,e){return n.slice(ee(n,e,!1),e)}function cr(n,e){return n.slice(e,ee(n,e))}function $y(n){return(e,t,i)=>!i[0].length||(n(hr(i.input,i.index))!=$.Word||n(cr(i.input,i.index))!=$.Word)&&(n(cr(i.input,i.index+i[0].length))!=$.Word||n(hr(i.input,i.index+i[0].length))!=$.Word)}function On(n){return e=>{let t=e.state.field(Bt,!1);return t&&t.query.spec.valid?n(e,t):Xu(e)}}function fa(n){return n.state.facet(Ri).createPanel(n)}function la(n,e){var t,i,s,r,o;let l=n.selection.main,a=l.empty||l.to>l.from+100?"":n.sliceDoc(l.from,l.to);if(e&&!a)return e;let h=n.facet(Ri);return new lr({search:((t=e?.literal)!==null&&t!==void 0?t:h.literal)?a:a.replace(/\n/g,"\\n"),caseSensitive:(i=e?.caseSensitive)!==null&&i!==void 0?i:h.caseSensitive,literal:(s=e?.literal)!==null&&s!==void 0?s:h.literal,regexp:(r=e?.regexp)!==null&&r!==void 0?r:h.regexp,wholeWord:(o=e?.wholeWord)!==null&&o!==void 0?o:h.wholeWord})}function _u(n){let e=Si(n,fa);return e&&e.dom.querySelector("[main-field]")}function Yu(n){let e=_u(n);e&&e==n.root.activeElement&&e.select()}function Re(n,e){return n.state.phrase(e)}function ua(n,{from:e,to:t}){let i=n.state.doc.lineAt(e),s=n.state.doc.lineAt(t).to,r=Math.max(i.from,e-tr),o=Math.min(s,t+tr),l=n.state.sliceDoc(r,o);if(r!=i.from){for(let a=0;a<tr;a++)if(!ir.test(l[a+1])&&ir.test(l[a])){l=l.slice(a);break}}if(o!=s){for(let a=l.length-1;a>l.length-tr;a--)if(!ir.test(l[a-1])&&ir.test(l[a])){l=l.slice(0,a);break}}return M.announce.of(`${n.state.phrase("current match")}. ${l} ${n.state.phrase("on line")} ${i.number}.`)}var qu,Lt,ju,ha,nr,sa,sr,rr,Ly,Ey,Uu,Ry,Py,Ny,Fy,Hy,Vy,Ri,lr,ar,ra,oa,Dn,ca,Bt,Tn,jy,Uy,Gy,fr,ur,_y,Yy,$u,Xy,Xu,Ju,Qu,aa,tr,ir,Jy,Qy,Zu=ye(()=>{St();ft();$n();qu=typeof String.prototype.normalize=="function"?n=>n.normalize("NFKD"):n=>n,Lt=class{constructor(e,t,i=0,s=e.length,r,o){this.test=o,this.value={from:0,to:0,precise:!1},this.done=!1,this.matches=[],this.buffer="",this.bufferPos=0,this.iter=e.iterRange(i,s),this.bufferStart=i,this.normalize=r?l=>r(qu(l)):qu,this.query=this.normalize(t)}peek(){if(this.bufferPos==this.buffer.length){if(this.bufferStart+=this.buffer.length,this.iter.next(),this.iter.done)return-1;this.bufferPos=0,this.buffer=this.iter.value}return ae(this.buffer,this.bufferPos)}next(){for(;this.matches.length;)this.matches.pop();return this.nextOverlapping()}nextOverlapping(){for(;;){let e=this.peek();if(e<0)return this.done=!0,this;let t=Vi(e),i=this.bufferStart+this.bufferPos;this.bufferPos+=Oe(e);let s=this.normalize(t);if(s.length)for(let r=0,o=i,l=!0;;r++){let a=s.charCodeAt(r),h=this.match(a,o,l,this.bufferPos+this.bufferStart,r==s.length-1);if(h)return this.value=h,this;if(r==s.length-1)break;l&&r<t.length&&t.charCodeAt(r)==a?o++:l=!1}}}match(e,t,i,s,r){let o=null;for(let l=0;l<this.matches.length;){let a=this.matches[l],h=!1;this.query.charCodeAt(a.index)==e&&(a.index==this.query.length-1?o={from:a.from,to:s,precise:r&&a.precise}:(a.index++,h=!0)),h?l++:this.matches.splice(l,1)}return this.query.charCodeAt(0)==e&&(this.query.length==1?o={from:t,to:s,precise:i&&r}:this.matches.push({from:t,index:1,precise:i})),o&&this.test&&!this.test(o.from,o.to,this.buffer,this.bufferStart)&&(o=null),o}};typeof Symbol<"u"&&(Lt.prototype[Symbol.iterator]=function(){return this});ju={from:-1,to:-1,match:/.*/.exec(""),precise:!0},ha="gm"+(/x/.unicode==null?"":"u"),nr=class{constructor(e,t,i,s=0,r=e.length){if(this.text=e,this.to=r,this.curLine="",this.done=!1,this.value=ju,/\\[sWDnr]|\n|\r|\[\^/.test(t))return new rr(e,t,i,s,r);this.re=new RegExp(t,ha+(i?.ignoreCase?"i":"")),this.test=i?.test,this.iter=e.iter();let o=e.lineAt(s);this.curLineStart=o.from,this.matchPos=or(e,s),this.getLine(this.curLineStart)}getLine(e){this.iter.next(e),this.iter.lineBreak?this.curLine="":(this.curLine=this.iter.value,this.curLineStart+this.curLine.length>this.to&&(this.curLine=this.curLine.slice(0,this.to-this.curLineStart)),this.iter.next())}nextLine(){this.curLineStart=this.curLineStart+this.curLine.length+1,this.curLineStart>this.to?this.curLine="":this.getLine(0)}next(){for(let e=this.matchPos-this.curLineStart;;){this.re.lastIndex=e;let t=this.matchPos<=this.to&&this.re.exec(this.curLine);if(t){let i=this.curLineStart+t.index,s=i+t[0].length;if(this.matchPos=or(this.text,s+(i==s?1:0)),i==this.curLineStart+this.curLine.length&&this.nextLine(),(i<s||i>this.value.to)&&(!this.test||this.test(i,s,t)))return this.value={from:i,to:s,precise:!0,match:t},this;e=this.matchPos-this.curLineStart}else if(this.curLineStart+this.curLine.length<this.to)this.nextLine(),e=0;else return this.done=!0,this}}},sa=new WeakMap,sr=class n{constructor(e,t){this.from=e,this.text=t}get to(){return this.from+this.text.length}static get(e,t,i){let s=sa.get(e);if(!s||s.from>=i||s.to<=t){let l=new n(t,e.sliceString(t,i));return sa.set(e,l),l}if(s.from==t&&s.to==i)return s;let{text:r,from:o}=s;return o>t&&(r=e.sliceString(t,o)+r,o=t),s.to<i&&(r+=e.sliceString(s.to,i)),sa.set(e,new n(o,r)),new n(t,r.slice(t-o,i-o))}},rr=class{constructor(e,t,i,s,r){this.text=e,this.to=r,this.done=!1,this.value=ju,this.matchPos=or(e,s),this.re=new RegExp(t,ha+(i?.ignoreCase?"i":"")),this.test=i?.test,this.flat=sr.get(e,s,this.chunkEnd(s+5e3))}chunkEnd(e){return e>=this.to?this.to:this.text.lineAt(e).to}next(){for(;;){let e=this.re.lastIndex=this.matchPos-this.flat.from,t=this.re.exec(this.flat.text);if(t&&!t[0]&&t.index==e&&(this.re.lastIndex=e+1,t=this.re.exec(this.flat.text)),t){let i=this.flat.from+t.index,s=i+t[0].length;if((this.flat.to>=this.to||t.index+t[0].length<=this.flat.text.length-10)&&(!this.test||this.test(i,s,t)))return this.value={from:i,to:s,precise:!0,match:t},this.matchPos=or(this.text,s+(i==s?1:0)),this}if(this.flat.to==this.to)return this.done=!0,this;this.flat=sr.get(this.text,this.flat.from,this.chunkEnd(this.flat.from+this.flat.text.length*2))}}};typeof Symbol<"u"&&(nr.prototype[Symbol.iterator]=rr.prototype[Symbol.iterator]=function(){return this});Ly=n=>{let e=zc(n,"cm-goto-line");if(e){let o=e.dom.querySelector("input[type=text]");return o&&o.select(),!0}let{state:t}=n,i=String(t.doc.lineAt(n.state.selection.main.head).number),{close:s,result:r}=Vc(n,{class:"cm-goto-line",label:t.phrase("Go to line"),input:{type:"text",name:"line",value:i},focus:!0,submitLabel:t.phrase("go")});return r.then(o=>{let l=o&&/^([+-])?(\d+)?(:\d+)?(%)?$/.exec(o.elements.line.value);if(!l){n.dispatch({effects:s});return}let a=t.doc.lineAt(t.selection.main.head),[,h,c,f,u]=l,d=f?+f.slice(1):0,p=c?+c:a.number;if(c&&u){let y=p/100;h&&(y=y*(h=="-"?-1:1)+a.number/t.doc.lines),p=Math.round(t.doc.lines*y)}else c&&h&&(p=p*(h=="-"?-1:1)+a.number);let m=t.doc.line(Math.max(1,Math.min(t.doc.lines,p))),g=b.cursor(m.from+Math.max(0,Math.min(d,m.length)));n.dispatch({effects:[s,M.scrollIntoView(g.from,{y:"center"})],selection:g})}),!0},Ey={highlightWordAroundCursor:!1,minSelectionLength:1,maxMatches:100,wholeWords:!1},Uu=A.define({combine(n){return pe(n,Ey,{highlightWordAroundCursor:(e,t)=>e||t,minSelectionLength:Math.min,maxMatches:Math.min})}});Ry=B.mark({class:"cm-selectionMatch"}),Py=B.mark({class:"cm-selectionMatch cm-selectionMatch-main"});Ny=_.fromClass(class{constructor(n){this.decorations=this.getDeco(n)}update(n){(n.selectionSet||n.docChanged||n.viewportChanged)&&(this.decorations=this.getDeco(n.view))}getDeco(n){let e=n.state.facet(Uu),{state:t}=n,i=t.selection;if(i.ranges.length>1)return B.none;let s=i.main,r,o=null;if(s.empty){if(!e.highlightWordAroundCursor)return B.none;let a=t.wordAt(s.head);if(!a)return B.none;o=t.charCategorizer(s.head),r=t.sliceDoc(a.from,a.to)}else{let a=s.to-s.from;if(a<e.minSelectionLength||a>200)return B.none;if(e.wholeWords){if(r=t.sliceDoc(s.from,s.to),o=t.charCategorizer(s.head),!(Ku(o,t,s.from,s.to)&&Iy(o,t,s.from,s.to)))return B.none}else if(r=t.sliceDoc(s.from,s.to),!r)return B.none}let l=[];for(let a of n.visibleRanges){let h=new Lt(t.doc,r,a.from,a.to);for(;!h.next().done;){let{from:c,to:f}=h.value;if((!o||Ku(o,t,c,f))&&(s.empty&&c<=s.from&&f>=s.to?l.push(Py.range(c,f)):(c>=s.to||f<=s.from)&&l.push(Ry.range(c,f)),l.length>e.maxMatches))return B.none}}return B.set(l)}},{decorations:n=>n.decorations}),Fy=M.baseTheme({".cm-selectionMatch":{backgroundColor:"#99ff7780"},".cm-searchMatch .cm-selectionMatch":{backgroundColor:"transparent"}}),Hy=({state:n,dispatch:e})=>{let{selection:t}=n,i=b.create(t.ranges.map(s=>n.wordAt(s.head)||b.cursor(s.head)),t.mainIndex);return i.eq(t)?!1:(e(n.update({selection:i})),!0)};Vy=({state:n,dispatch:e})=>{let{ranges:t}=n.selection;if(t.some(r=>r.from===r.to))return Hy({state:n,dispatch:e});let i=n.sliceDoc(t[0].from,t[0].to);if(n.selection.ranges.some(r=>n.sliceDoc(r.from,r.to)!=i))return!1;let s=Wy(n,i);return s?(e(n.update({selection:n.selection.addRange(b.range(s.from,s.to),!1),effects:M.scrollIntoView(s.to)})),!0):!1},Ri=A.define({combine(n){return pe(n,{top:!1,caseSensitive:!1,literal:!1,regexp:!1,wholeWord:!1,createPanel:e=>new aa(e),scrollToMatch:e=>M.scrollIntoView(e)})}}),lr=class{constructor(e){this.search=e.search,this.caseSensitive=!!e.caseSensitive,this.literal=!!e.literal,this.regexp=!!e.regexp,this.replace=e.replace||"",this.valid=!!this.search&&(!this.regexp||By(this.search)),this.unquoted=this.unquote(this.search),this.wholeWord=!!e.wholeWord,this.test=e.test}unquote(e){return this.literal?e:e.replace(/\\([nrt\\])/g,(t,i)=>i=="n"?`
`:i=="r"?"\r":i=="t"?"	":"\\")}eq(e){return this.search==e.search&&this.replace==e.replace&&this.caseSensitive==e.caseSensitive&&this.regexp==e.regexp&&this.wholeWord==e.wholeWord&&this.test==e.test}create(){return this.regexp?new oa(this):new ra(this)}getCursor(e,t=0,i){let s=e.doc?e:W.create({doc:e});return i==null&&(i=s.doc.length),this.regexp?Ei(this,s,t,i):Li(this,s,t,i)}},ar=class{constructor(e){this.spec=e}};ra=class extends ar{constructor(e){super(e)}nextMatch(e,t,i){let s=Li(this.spec,e,i,e.doc.length).nextOverlapping();if(s.done){let r=Math.min(e.doc.length,t+this.spec.unquoted.length);s=Li(this.spec,e,0,r).nextOverlapping()}return s.done||s.value.from==t&&s.value.to==i?null:s.value}prevMatchInRange(e,t,i){for(let s=i;;){let r=Math.max(t,s-1e4-this.spec.unquoted.length),o=Li(this.spec,e,r,s),l=null;for(;!o.nextOverlapping().done;)l=o.value;if(l)return l;if(r==t)return null;s-=1e4}}prevMatch(e,t,i){let s=this.prevMatchInRange(e,0,t);return s||(s=this.prevMatchInRange(e,Math.max(0,i-this.spec.unquoted.length),e.doc.length)),s&&(s.from!=t||s.to!=i)?s:null}getReplacement(e){return this.spec.unquote(this.spec.replace)}matchAll(e,t){let i=Li(this.spec,e,0,e.doc.length),s=[];for(;!i.next().done;){if(s.length>=t)return null;s.push(i.value)}return s}highlight(e,t,i,s){let r=Li(this.spec,e,Math.max(0,t-this.spec.unquoted.length),Math.min(i+this.spec.unquoted.length,e.doc.length));for(;!r.next().done;)s(r.value.from,r.value.to)}};oa=class extends ar{nextMatch(e,t,i){let s=Ei(this.spec,e,i,e.doc.length).next();return s.done&&(s=Ei(this.spec,e,0,t).next()),s.done?null:s.value}prevMatchInRange(e,t,i){for(let s=1;;s++){let r=Math.max(t,i-s*1e4),o=Ei(this.spec,e,r,i),l=null;for(;!o.next().done;)l=o.value;if(l&&(r==t||l.from>r+10))return l;if(r==t)return null}}prevMatch(e,t,i){return this.prevMatchInRange(e,0,t)||this.prevMatchInRange(e,i,e.doc.length)}getReplacement(e){return this.spec.unquote(this.spec.replace).replace(/\$([$&]|\d+)/g,(t,i)=>{if(i=="&")return e.match[0];if(i=="$")return"$";for(let s=i.length;s>0;s--){let r=+i.slice(0,s);if(r>0&&r<e.match.length)return e.match[r]+i.slice(s)}return t})}matchAll(e,t){let i=Ei(this.spec,e,0,e.doc.length),s=[];for(;!i.next().done;){if(s.length>=t)return null;s.push(i.value)}return s}highlight(e,t,i,s){let r=Ei(this.spec,e,Math.max(0,t-250),Math.min(i+250,e.doc.length));for(;!r.next().done;)s(r.value.from,r.value.to)}},Dn=L.define(),ca=L.define(),Bt=Q.define({create(n){return new Tn(la(n).create(),null)},update(n,e){for(let t of e.effects)t.is(Dn)?n=new Tn(t.value.create(),n.panel):t.is(ca)&&(n=new Tn(n.query,t.value?fa:null));return n},provide:n=>$t.from(n,e=>e.panel)}),Tn=class{constructor(e,t){this.query=e,this.panel=t}},jy=B.mark({class:"cm-searchMatch"}),Uy=B.mark({class:"cm-searchMatch cm-searchMatch-selected"}),Gy=_.fromClass(class{constructor(n){this.view=n,this.decorations=this.highlight(n.state.field(Bt))}update(n){let e=n.state.field(Bt);(e!=n.startState.field(Bt)||n.docChanged||n.selectionSet||n.viewportChanged)&&(this.decorations=this.highlight(e))}highlight({query:n,panel:e}){if(!e||!n.spec.valid)return B.none;let{view:t}=this,i=new de;for(let s=0,r=t.visibleRanges,o=r.length;s<o;s++){let{from:l,to:a}=r[s];for(;s<o-1&&a>r[s+1].from-500;)a=r[++s].to;n.highlight(t.state,l,a,(h,c)=>{let f=t.state.selection.ranges.some(u=>u.from==h&&u.to==c);i.add(h,c,f?Uy:jy)})}return i.finish()}},{decorations:n=>n.decorations});fr=On((n,{query:e})=>{let{to:t}=n.state.selection.main,i=e.nextMatch(n.state,t,t);if(!i)return!1;let s=b.single(i.from,i.to),r=n.state.facet(Ri);return n.dispatch({selection:s,effects:[ua(n,i),r.scrollToMatch(s.main,n)],userEvent:"select.search"}),Yu(n),!0}),ur=On((n,{query:e})=>{let{state:t}=n,{from:i}=t.selection.main,s=e.prevMatch(t,i,i);if(!s)return!1;let r=b.single(s.from,s.to),o=n.state.facet(Ri);return n.dispatch({selection:r,effects:[ua(n,s),o.scrollToMatch(r.main,n)],userEvent:"select.search"}),Yu(n),!0}),_y=On((n,{query:e})=>{let t=e.matchAll(n.state,1e3);return!t||!t.length?!1:(n.dispatch({selection:b.create(t.map(i=>b.range(i.from,i.to))),userEvent:"select.search.matches"}),!0)}),Yy=({state:n,dispatch:e})=>{let t=n.selection;if(t.ranges.length>1||t.main.empty)return!1;let{from:i,to:s}=t.main,r=[],o=0;for(let l=new Lt(n.doc,n.sliceDoc(i,s));!l.next().done;){if(r.length>1e3)return!1;l.value.from==i&&(o=r.length),r.push(b.range(l.value.from,l.value.to))}return e(n.update({selection:b.create(r,o),userEvent:"select.search.matches"})),!0},$u=On((n,{query:e})=>{let{state:t}=n,{from:i,to:s}=t.selection.main;if(t.readOnly)return!1;let r=e.nextMatch(t,i,i);if(!r)return!1;let o=r,l=[],a,h,c=[];o.precise?o.from==i&&o.to==s&&(h=t.toText(e.getReplacement(o)),l.push({from:o.from,to:o.to,insert:h}),o=e.nextMatch(t,o.from,o.to),c.push(M.announce.of(t.phrase("replaced match on line $",t.doc.lineAt(i).number)+"."))):o=e.nextMatch(t,o.from,o.to);let f=n.state.changes(l);return o&&(a=b.single(o.from,o.to).map(f),c.push(ua(n,o)),c.push(t.facet(Ri).scrollToMatch(a.main,n))),n.dispatch({changes:f,selection:a,effects:c,userEvent:"input.replace"}),!0}),Xy=On((n,{query:e})=>{if(n.state.readOnly)return!1;let t=[];for(let s of e.matchAll(n.state,1e9)){let{from:r,to:o,precise:l}=s;l&&t.push({from:r,to:o,insert:e.getReplacement(s)})}if(!t.length)return!1;let i=n.state.phrase("replaced $ matches",t.length)+".";return n.dispatch({changes:t,effects:M.announce.of(i),userEvent:"input.replace.all"}),!0});Xu=n=>{let e=n.state.field(Bt,!1);if(e&&e.panel){let t=_u(n);if(t&&t!=n.root.activeElement){let i=la(n.state,e.query.spec);i.valid&&n.dispatch({effects:Dn.of(i)}),t.focus(),t.select()}}else n.dispatch({effects:[ca.of(!0),e?Dn.of(la(n.state,e.query.spec)):L.appendConfig.of(Qy)]});return!0},Ju=n=>{let e=n.state.field(Bt,!1);if(!e||!e.panel)return!1;let t=Si(n,fa);return t&&t.dom.contains(n.root.activeElement)&&n.focus(),n.dispatch({effects:ca.of(!1)}),!0},Qu=[{key:"Mod-f",run:Xu,scope:"editor search-panel"},{key:"F3",run:fr,shift:ur,scope:"editor search-panel",preventDefault:!0},{key:"Mod-g",run:fr,shift:ur,scope:"editor search-panel",preventDefault:!0},{key:"Escape",run:Ju,scope:"editor search-panel"},{key:"Mod-Shift-l",run:Yy},{key:"Mod-Alt-g",run:Ly},{key:"Mod-d",run:Vy,preventDefault:!0}],aa=class{constructor(e){this.view=e;let t=this.query=e.state.field(Bt).query.spec;this.commit=this.commit.bind(this),this.searchField=V("input",{value:t.search,placeholder:Re(e,"Find"),"aria-label":Re(e,"Find"),class:"cm-textfield",name:"search",form:"","main-field":"true",onchange:this.commit,onkeyup:this.commit}),this.replaceField=V("input",{value:t.replace,placeholder:Re(e,"Replace"),"aria-label":Re(e,"Replace"),class:"cm-textfield",name:"replace",form:"",onchange:this.commit,onkeyup:this.commit}),this.caseField=V("input",{type:"checkbox",name:"case",form:"",checked:t.caseSensitive,onchange:this.commit}),this.reField=V("input",{type:"checkbox",name:"re",form:"",checked:t.regexp,onchange:this.commit}),this.wordField=V("input",{type:"checkbox",name:"word",form:"",checked:t.wholeWord,onchange:this.commit});function i(s,r,o){return V("button",{class:"cm-button",name:s,onclick:r,type:"button"},o)}this.dom=V("div",{onkeydown:s=>this.keydown(s),class:"cm-search"},[this.searchField,i("next",()=>fr(e),[Re(e,"next")]),i("prev",()=>ur(e),[Re(e,"previous")]),i("select",()=>_y(e),[Re(e,"all")]),V("label",null,[this.caseField,Re(e,"match case")]),V("label",null,[this.reField,Re(e,"regexp")]),V("label",null,[this.wordField,Re(e,"by word")]),...e.state.readOnly?[]:[V("br"),this.replaceField,i("replace",()=>$u(e),[Re(e,"replace")]),i("replaceAll",()=>Xy(e),[Re(e,"replace all")])],V("button",{name:"close",onclick:()=>Ju(e),"aria-label":Re(e,"close"),type:"button"},["\xD7"])])}commit(){let e=new lr({search:this.searchField.value,caseSensitive:this.caseField.checked,regexp:this.reField.checked,wholeWord:this.wordField.checked,replace:this.replaceField.value});e.eq(this.query)||(this.query=e,this.view.dispatch({effects:Dn.of(e)}))}keydown(e){Sc(this.view,e,"search-panel")?e.preventDefault():e.keyCode==13&&e.target==this.searchField?(e.preventDefault(),(e.shiftKey?ur:fr)(this.view)):e.keyCode==13&&e.target==this.replaceField&&(e.preventDefault(),$u(this.view))}update(e){for(let t of e.transactions)for(let i of t.effects)i.is(Dn)&&!i.value.eq(this.query)&&this.setQuery(i.value)}setQuery(e){this.query=e,this.searchField.value=e.search,this.replaceField.value=e.replace,this.caseField.checked=e.caseSensitive,this.reField.checked=e.regexp,this.wordField.checked=e.wholeWord}mount(){this.searchField.select()}get pos(){return 80}get top(){return this.view.state.facet(Ri).top}};tr=30,ir=/[\s\.,:;?!]/;Jy=M.baseTheme({".cm-panel.cm-search":{padding:"2px 6px 4px",position:"relative","& [name=close]":{position:"absolute",top:"0",right:"4px",backgroundColor:"inherit",border:"none",font:"inherit",padding:0,margin:0},"& input, & button, & label":{margin:".2em .6em .2em 0"},"& input[type=checkbox]":{marginRight:".2em"},"& label":{fontSize:"80%",whiteSpace:"pre"}},"&light .cm-searchMatch":{backgroundColor:"#ffff0054"},"&dark .cm-searchMatch":{backgroundColor:"#00ffff8a"},"&light .cm-searchMatch-selected":{backgroundColor:"#ff6a0054"},"&dark .cm-searchMatch-selected":{backgroundColor:"#ff00ff8a"}}),Qy=[Bt,Fe.low(Gy),Jy]});function Et(n,e=null,t=0){let i=null;return n.between(t,1e9,(s,r,{spec:o})=>{if(!(e&&o.diagnostics.indexOf(e)<0))if(!i)i=new pr(s,r,e||o.diagnostics[0]);else{if(o.diagnostics.indexOf(i.diagnostic)<0)return!1;i=new pr(i.from,r,i.diagnostic)}}),i}function Zy(n,e){let t=e.pos,i=e.end||t,s=n.state.facet(Bn).hideOn(n,t,i);if(s!=null)return s;let r=n.startState.doc.lineAt(e.pos);return!!(n.effects.some(o=>o.is(id))||n.changes.touchesRange(r.from,Math.max(r.to,i)))}function eb(n,e){return n.field(Pe,!1)?e:e.concat(L.appendConfig.of(cb))}function ib(n,e,t){let{diagnostics:i}=n.state.field(Pe),s,r=-1,o=-1;i.between(e-(t<0?1:0),e+(t>0?1:0),(a,h,{spec:c})=>{if(e>=a&&e<=h&&(a==h||(e>a||t>0)&&(e<h||t<0)))return s=c.diagnostics,r=a,o=h,!1});let l=n.state.facet(Bn).tooltipFilter;return s&&l&&(s=l(s,n.state)),s?{pos:r,end:o,above:!0,create(){return{dom:nb(n,s)}}}:null}function nb(n,e){return V("ul",{class:"cm-tooltip-lint"},e.map(t=>od(n,t,!1)))}function td(n,e){return n?e?(t,i)=>e(n(t,i),i):n:e}function rd(n){let e=[];if(n)e:for(let{name:t}of n){for(let i=0;i<t.length;i++){let s=t[i];if(/[a-zA-Z]/.test(s)&&!e.some(r=>r.toLowerCase()==s.toLowerCase())){e.push(s);continue e}}e.push("")}return e}function od(n,e,t){var i;let s=t?rd(e.actions):[];return V("li",{class:"cm-diagnostic cm-diagnostic-"+e.severity},V("span",{class:"cm-diagnosticText"},e.renderMessage?e.renderMessage(n):e.message),(i=e.actions)===null||i===void 0?void 0:i.map((r,o)=>{let l=0,a=d=>{if(d.preventDefault(),l>Date.now()-100)return;let p=Et(n.state.field(Pe).diagnostics,e);p&&r.apply(n,p.from,p.to),l=Date.now()},{name:h}=r,c=s[o]?h.indexOf(s[o]):-1,f=c<0?h:[h.slice(0,c),V("u",h.slice(c,c+1)),h.slice(c+1)],u=r.markClass?" "+r.markClass:"";return V("button",{type:"button",class:"cm-diagnosticAction"+u,onclick:a,onmousedown:a,"aria-label":` Action: ${h}${c<0?"":` (access key "${s[o]})"`}.`},f)}),e.source&&V("div",{class:"cm-diagnosticSource"},e.source))}function ob(n,e='viewBox="0 0 40 40"'){return`url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" ${e}>${encodeURIComponent(n)}</svg>')`}function dr(n){return ob(`<path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="${n}" fill="none" stroke-width=".7"/>`,'width="6" height="3"')}function ab(n){return n=="error"?4:n=="warning"?3:n=="info"?2:1}function hb(n){let e="hint",t=1;for(let i of n){let s=ab(i.severity);s>t&&(t=s,e=i.severity)}return e}var pr,ei,id,pa,nd,Pe,tb,sb,ed,rb,sd,Bn,da,mr,Ln,lb,ld,cb,ad=ye(()=>{St();ft();$n();pr=class{constructor(e,t,i){this.from=e,this.to=t,this.diagnostic=i}},ei=class n{constructor(e,t,i){this.diagnostics=e,this.panel=t,this.selected=i}static init(e,t,i){let s=i.facet(Bn).markerFilter;s&&(e=s(e,i));let r=e.slice().sort((d,p)=>d.from-p.from||d.to-p.to),o=new de,l=[],a=0,h=i.doc.iter(),c=0,f=i.doc.length;for(let d=0;;){let p=d==r.length?null:r[d];if(!p&&!l.length)break;let m,g;if(l.length)m=a,g=l.reduce((x,O)=>Math.min(x,O.to),p&&p.from>m?p.from:1e8);else{if(m=p.from,m>f)break;g=p.to,l.push(p),d++}for(;d<r.length;){let x=r[d];if(x.from==m&&(x.to>x.from||x.to==m))l.push(x),d++,g=Math.min(x.to,g);else{g=Math.min(x.from,g);break}}g=Math.min(g,f);let y=!1;if(l.some(x=>x.from==m&&(x.to==g||g==f))&&(y=m==g,!y&&g-m<10)){let x=m-(c+h.value.length);x>0&&(h.next(x),c=m);for(let O=m;;){if(O>=g){y=!0;break}if(!h.lineBreak&&c+h.value.length>O)break;O=c+h.value.length,c+=h.value.length,h.next()}}let k=hb(l);if(y)o.add(m,m,B.widget({widget:new da(k),diagnostics:l.slice()}));else{let x=l.reduce((O,w)=>w.markClass?O+" "+w.markClass:O,"");o.add(m,g,B.mark({class:"cm-lintRange cm-lintRange-"+k+x,diagnostics:l.slice(),inclusiveEnd:l.some(O=>O.to>g)}))}if(a=g,a==f)break;for(let x=0;x<l.length;x++)l[x].to<=a&&l.splice(x--,1)}let u=o.finish();return new n(u,t,Et(u))}};id=L.define(),pa=L.define(),nd=L.define(),Pe=Q.define({create(){return new ei(B.none,null,null)},update(n,e){if(e.docChanged&&n.diagnostics.size){let t=n.diagnostics.map(e.changes),i=null,s=n.panel;if(n.selected){let r=e.changes.mapPos(n.selected.from,1);i=Et(t,n.selected.diagnostic,r)||Et(t,null,r)}!t.size&&s&&e.state.facet(Bn).autoPanel&&(s=null),n=new ei(t,s,i)}for(let t of e.effects)if(t.is(id)){let i=e.state.facet(Bn).autoPanel?t.value.length?Ln.open:null:n.panel;n=ei.init(t.value,i,e.state)}else t.is(pa)?n=new ei(n.diagnostics,t.value?Ln.open:null,n.selected):t.is(nd)&&(n=new ei(n.diagnostics,n.panel,t.value));return n},provide:n=>[$t.from(n,e=>e.panel),M.decorations.from(n,e=>e.diagnostics)]}),tb=B.mark({class:"cm-lintRange cm-lintRange-active"});sb=n=>{let e=n.state.field(Pe,!1);(!e||!e.panel)&&n.dispatch({effects:eb(n.state,[pa.of(!0)])});let t=Si(n,Ln.open);return t&&t.dom.querySelector(".cm-panel-lint ul").focus(),!0},ed=n=>{let e=n.state.field(Pe,!1);return!e||!e.panel?!1:(n.dispatch({effects:pa.of(!1)}),!0)},rb=n=>{let e=n.state.field(Pe,!1);if(!e)return!1;let t=n.state.selection.main,i=Et(e.diagnostics,null,t.to+1);return!i&&(i=Et(e.diagnostics,null,0),!i||i.from==t.from&&i.to==t.to)?!1:(n.dispatch({selection:{anchor:i.from,head:i.to},scrollIntoView:!0}),Hc(n,i.from,1,{tooltip:ld,until:s=>s.docChanged||s.newSelection.main.head<i.from||s.newSelection.main.head>i.to}),!0)},sd=[{key:"Mod-Shift-m",run:sb,preventDefault:!0},{key:"F8",run:rb}],Bn=A.define({combine(n){return{sources:n.map(e=>e.source).filter(e=>e!=null),...pe(n.map(e=>e.config),{delay:750,markerFilter:null,tooltipFilter:null,needsRefresh:null,hideOn:()=>null},{delay:Math.max,markerFilter:td,tooltipFilter:td,needsRefresh:(e,t)=>e?t?i=>e(i)||t(i):e:t,hideOn:(e,t)=>e?t?(i,s,r)=>e(i,s,r)||t(i,s,r):e:t,autoPanel:(e,t)=>e||t})}}});da=class extends we{constructor(e){super(),this.sev=e}eq(e){return e.sev==this.sev}toDOM(){return V("span",{class:"cm-lintPoint cm-lintPoint-"+this.sev})}},mr=class{constructor(e,t){this.diagnostic=t,this.id="item_"+Math.floor(Math.random()*4294967295).toString(16),this.dom=od(e,t,!0),this.dom.id=this.id,this.dom.setAttribute("role","option")}},Ln=class n{constructor(e){this.view=e,this.items=[];let t=s=>{if(!(s.ctrlKey||s.altKey||s.metaKey)){if(s.keyCode==27)ed(this.view),this.view.focus();else if(s.keyCode==38||s.keyCode==33)this.moveSelection((this.selectedIndex-1+this.items.length)%this.items.length);else if(s.keyCode==40||s.keyCode==34)this.moveSelection((this.selectedIndex+1)%this.items.length);else if(s.keyCode==36)this.moveSelection(0);else if(s.keyCode==35)this.moveSelection(this.items.length-1);else if(s.keyCode==13)this.view.focus();else if(s.keyCode>=65&&s.keyCode<=90&&this.selectedIndex>=0){let{diagnostic:r}=this.items[this.selectedIndex],o=rd(r.actions);for(let l=0;l<o.length;l++)if(o[l].toUpperCase().charCodeAt(0)==s.keyCode){let a=Et(this.view.state.field(Pe).diagnostics,r);a&&r.actions[l].apply(e,a.from,a.to)}}else return;s.preventDefault()}},i=s=>{for(let r=0;r<this.items.length;r++)this.items[r].dom.contains(s.target)&&this.moveSelection(r)};this.list=V("ul",{tabIndex:0,role:"listbox","aria-label":this.view.state.phrase("Diagnostics"),onkeydown:t,onclick:i}),this.dom=V("div",{class:"cm-panel-lint"},this.list,V("button",{type:"button",name:"close","aria-label":this.view.state.phrase("close"),onclick:()=>ed(this.view)},"\xD7")),this.update()}get selectedIndex(){let e=this.view.state.field(Pe).selected;if(!e)return-1;for(let t=0;t<this.items.length;t++)if(this.items[t].diagnostic==e.diagnostic)return t;return-1}update(){let{diagnostics:e,selected:t}=this.view.state.field(Pe),i=0,s=!1,r=null,o=new Set;for(e.between(0,this.view.state.doc.length,(l,a,{spec:h})=>{for(let c of h.diagnostics){if(o.has(c))continue;o.add(c);let f=-1,u;for(let d=i;d<this.items.length;d++)if(this.items[d].diagnostic==c){f=d;break}f<0?(u=new mr(this.view,c),this.items.splice(i,0,u),s=!0):(u=this.items[f],f>i&&(this.items.splice(i,f-i),s=!0)),t&&u.diagnostic==t.diagnostic?u.dom.hasAttribute("aria-selected")||(u.dom.setAttribute("aria-selected","true"),r=u):u.dom.hasAttribute("aria-selected")&&u.dom.removeAttribute("aria-selected"),i++}});i<this.items.length&&!(this.items.length==1&&this.items[0].diagnostic.from<0);)s=!0,this.items.pop();this.items.length==0&&(this.items.push(new mr(this.view,{from:-1,to:-1,severity:"info",message:this.view.state.phrase("No diagnostics")})),s=!0),r?(this.list.setAttribute("aria-activedescendant",r.id),this.view.requestMeasure({key:this,read:()=>({sel:r.dom.getBoundingClientRect(),panel:this.list.getBoundingClientRect()}),write:({sel:l,panel:a})=>{let h=a.height/this.list.offsetHeight;l.top<a.top?this.list.scrollTop-=(a.top-l.top)/h:l.bottom>a.bottom&&(this.list.scrollTop+=(l.bottom-a.bottom)/h)}})):this.selectedIndex<0&&this.list.removeAttribute("aria-activedescendant"),s&&this.sync()}sync(){let e=this.list.firstChild;function t(){let i=e;e=i.nextSibling,i.remove()}for(let i of this.items)if(i.dom.parentNode==this.list){for(;e!=i.dom;)t();e=i.dom.nextSibling}else this.list.insertBefore(i.dom,e);for(;e;)t()}moveSelection(e){if(this.selectedIndex<0)return;let t=this.view.state.field(Pe),i=Et(t.diagnostics,this.items[e].diagnostic);i&&this.view.dispatch({selection:{anchor:i.from,head:i.to},scrollIntoView:!0,effects:nd.of(i)})}static open(e){return new n(e)}};lb=M.baseTheme({".cm-diagnostic":{padding:"3px 6px 3px 8px",marginLeft:"-1px",display:"block",whiteSpace:"pre-wrap"},".cm-diagnostic-error":{borderLeft:"5px solid #d11"},".cm-diagnostic-warning":{borderLeft:"5px solid orange"},".cm-diagnostic-info":{borderLeft:"5px solid #999"},".cm-diagnostic-hint":{borderLeft:"5px solid #66d"},".cm-diagnosticAction":{font:"inherit",border:"none",padding:"2px 4px",backgroundColor:"#444",color:"white",borderRadius:"3px",marginLeft:"8px",cursor:"pointer"},".cm-diagnosticSource":{fontSize:"70%",opacity:.7},".cm-lintRange":{backgroundPosition:"left bottom",backgroundRepeat:"repeat-x",paddingBottom:"0.7px"},".cm-lintRange-error":{backgroundImage:dr("#f11")},".cm-lintRange-warning":{backgroundImage:dr("orange")},".cm-lintRange-info":{backgroundImage:dr("#999")},".cm-lintRange-hint":{backgroundImage:dr("#66d")},".cm-lintRange-active":{backgroundColor:"#ffdd9980"},".cm-tooltip-lint":{padding:0,margin:0},".cm-lintPoint":{position:"relative","&:after":{content:'""',position:"absolute",bottom:0,left:"-2px",borderLeft:"3px solid transparent",borderRight:"3px solid transparent",borderBottom:"4px solid #d11"}},".cm-lintPoint-warning":{"&:after":{borderBottomColor:"orange"}},".cm-lintPoint-info":{"&:after":{borderBottomColor:"#999"}},".cm-lintPoint-hint":{"&:after":{borderBottomColor:"#66d"}},".cm-panel.cm-panel-lint":{position:"relative","& ul":{maxHeight:"100px",overflowY:"auto","& [aria-selected]":{backgroundColor:"#ddd","& u":{textDecoration:"underline"}},"&:focus [aria-selected]":{background_fallback:"#bdf",backgroundColor:"Highlight",color_fallback:"white",color:"HighlightText"},"& u":{textDecoration:"none"},padding:0,margin:0},"& [name=close]":{position:"absolute",top:"0",right:"2px",background:"inherit",border:"none",font:"inherit",padding:0,margin:0}},"&dark .cm-lintRange-active":{backgroundColor:"#86714a80"},"&dark .cm-panel.cm-panel-lint ul":{"& [aria-selected]":{backgroundColor:"#2e343e"}}});ld=Fc(ib,{hideOn:Zy}),cb=[Pe,M.decorations.compute([Pe],n=>{let{selected:e,panel:t}=n.field(Pe);return!e||!t||e.from==e.to?B.none:B.set([tb.range(e.from,e.to)])}),ld,lb]});var hd,cd=ye(()=>{St();ft();xn();na();Zu();Yl();ad();hd=[jc(),Uc(),Lc(),uu(),Cf(),Tc(),Bc(),W.allowMultipleSelections.of(!0),Vs(),qs(Mf,{fallback:!0}),Bf(),Yf(),eu(),Rc(),Pc(),Ec(),Gu(),vt.of([...Qf,...zu,...Qu,...mu,...kf,..._l,...sd])]});var Ob=pd(()=>{ft();St();Yl();cd();na();xn();pl();var fb=Fs.define({name:"latex",startState:()=>({inMath:!1,inComment:!1}),token(n,e){if(n.sol()&&(e.inComment=!1),e.inComment){for(;!n.eol();){if(n.match(/^.*?%/))return e.inComment=!1,"comment";n.next()}return"comment"}return n.match(/^%/)?(e.inComment=!0,n.skipToEnd(),"comment"):e.inMath?n.match(/^\$\$/)||n.match(/^\$/)?(e.inMath=!1,"keyword"):(n.next(),"string"):n.match(/^\$\$/)||n.match(/^\$/)?(e.inMath=!0,"keyword"):n.match(/^\\begin\{[^}]*\}/)||n.match(/^\\end\{[^}]*\}/)||n.match(/^\\[a-zA-Z@]+\*?/)?"keyword":n.match(/^\\./)?"escape":n.match(/^[{}]/)?"brace":n.match(/^\[[^\]]*\]/)?"propertyName":(n.next(),null)},languageData:{commentTokens:{line:"%"},closeBrackets:{brackets:["(","[","{","'",'"']}}}),ub='ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',db=M.theme({"&":{height:"100%",fontSize:"12px",backgroundColor:"transparent",color:"var(--dsw-alias-label-primary, #e6e6e6)"},"&.cm-focused":{outline:"none"},".cm-scroller":{fontFamily:ub,lineHeight:"18px",overflow:"auto"},".cm-content":{padding:"6px 0",caretColor:"var(--dsw-alias-label-primary, #e6e6e6)"},".cm-line":{padding:"0 8px"},".cm-gutters":{backgroundColor:"transparent",border:"none",color:"var(--dsw-alias-label-secondary, #9aa0a6)",paddingLeft:"4px"},".cm-lineNumbers .cm-gutterElement":{padding:"0 10px 0 4px",minWidth:"34px"},".cm-activeLine":{backgroundColor:"transparent"},".cm-activeLineGutter":{backgroundColor:"transparent",color:"var(--dsw-alias-label-primary, #e6e6e6)"},".cm-cursor, .cm-dropCursor":{borderLeftColor:"var(--dsw-alias-label-primary, #e6e6e6)"},"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":{backgroundColor:"rgba(120, 170, 255, 0.28)"},".cm-selectionMatch":{backgroundColor:"rgba(120, 170, 255, 0.14)"},".cm-matchingBracket, &.cm-focused .cm-matchingBracket":{backgroundColor:"rgba(120, 170, 255, 0.20)",outline:"none"},".cm-searchMatch":{backgroundColor:"rgba(217, 154, 43, 0.28)"},".cm-searchMatch.cm-searchMatch-selected":{backgroundColor:"rgba(217, 154, 43, 0.45)"},".cm-panels":{backgroundColor:"var(--dsw-alias-bg-layer-1, #232323)",color:"var(--dsw-alias-label-primary, #e6e6e6)"},".cm-panels.cm-panels-top":{borderBottom:"1px solid var(--dsw-alias-border-l1, #3a3a3a)"},".cm-textfield":{backgroundColor:"transparent",color:"inherit",border:"1px solid var(--dsw-alias-border-l1, #3a3a3a)",borderRadius:"4px"},".cm-button":{backgroundImage:"none",backgroundColor:"transparent",color:"inherit",border:"1px solid var(--dsw-alias-border-l1, #3a3a3a)",borderRadius:"4px"},".cm-tooltip":{backgroundColor:"var(--dsw-alias-bg-overlay, #2b2b2b)",color:"var(--dsw-alias-label-primary, #e6e6e6)",border:"1px solid var(--dsw-alias-border-l1, #3a3a3a)"},".cm-tooltip-autocomplete > ul > li[aria-selected]":{backgroundColor:"var(--dsw-alias-bg-layer-2, #333)",color:"var(--dsw-alias-label-primary, #e6e6e6)"}},{dark:!0}),Me={comment:"var(--dsw-alias-label-secondary, #9aa0a6)",keyword:"#c678dd",string:"#98c379",number:"#d19a66",func:"#61afef",typeName:"#e5c07b",property:"#e06c75",invalid:"#f44747",escape:"#56b6c2"},pb=Ai.define([{tag:v.comment,color:Me.comment,fontStyle:"italic"},{tag:v.keyword,color:Me.keyword},{tag:v.operator,color:"var(--dsw-alias-label-primary, #e6e6e6)"},{tag:v.string,color:Me.string},{tag:v.number,color:Me.number},{tag:v.definition(v.variableName),color:Me.func},{tag:v.function(v.variableName),color:Me.func},{tag:v.typeName,color:Me.typeName},{tag:v.propertyName,color:Me.property},{tag:v.className,color:Me.typeName},{tag:v.invalid,color:Me.invalid},{tag:v.meta,color:Me.keyword},{tag:v.processingInstruction,color:Me.keyword},{tag:v.escape,color:Me.escape},{tag:v.brace,color:"var(--dsw-alias-label-secondary, #9aa0a6)"},{tag:v.emphasis,fontStyle:"italic"},{tag:v.strong,fontWeight:"bold"},{tag:v.link,color:Me.func,textDecoration:"underline"}]),fd=new Ht,ud=new Ht;function dd(n){return n?M.lineWrapping:[]}function mb(n){let e=s=>Object.keys(s||{}).map(r=>r.replace(/[A-Z]/g,o=>"-"+o.toLowerCase())+": "+s[r]).join("; "),t=s=>{let r=new de,o=null;try{o=n.getSegments?n.getSegments(s.state.doc.toString()):null}catch{o=null}if(!o||!o.length)return r.finish();for(let l of s.visibleRanges){let a=s.state.doc.lineAt(l.from).number,h=s.state.doc.lineAt(l.to).number;for(let c=a;c<=h;c++){let f=o[c-1];if(!f||!f.length)continue;let u=s.state.doc.line(c),d=u.from;for(let p of f){let m=p&&p.text?p.text.length:0;if(m<=0)continue;let g=Math.min(d+m,u.to);if(g>d&&p.style&&r.add(d,g,B.mark({attributes:{style:e(p.style)}})),d=g,d>=u.to)break}}}return r.finish()};class i{constructor(r){this.decorations=t(r)}update(r){(r.docChanged||r.viewportChanged)&&(this.decorations=t(r.view))}}return _.fromClass(i,{decorations:s=>s.decorations})}function gb(n){if(!n.onComplete)return[];let t=[{autocomplete:i=>{let s=null;try{s=n.onComplete(i)}catch{s=null}return!s||!Array.isArray(s.options)||!s.options.length?null:{from:typeof s.from=="number"?s.from:i.pos,options:s.options.map(o=>o&&o.snippet?Gf(o.snippet,o):o)}}}];return W.languageData.of(()=>t)}function yb(n,e){let t=e||{},i=vt.of([{key:"Mod-s",preventDefault:!0,run:()=>(t.onSave&&t.onSave(),!0)},{key:"F5",preventDefault:!0,run:()=>(t.onCompile&&t.onCompile(),!0)}]),s=W.create({doc:t.doc||"",extensions:[i,hd,fb,db,qs(pb),Vs(),mb(t),gb(t),ud.of(W.readOnly.of(!!t.readOnly)),fd.of(dd(t.wrap!==!1)),M.domEventHandlers({dblclick:(o,l)=>{if(!t.onDblClick)return!1;let a=l.posAtCoords({x:o.clientX,y:o.clientY});return a==null||t.onDblClick(l.state.doc.lineAt(a).number),!1},contextmenu:(o,l)=>{if(!t.onContextMenu)return!1;let a=l.posAtCoords({x:o.clientX,y:o.clientY});return a==null?!1:(o.preventDefault(),t.onContextMenu(l.state.doc.lineAt(a).number,o),!0)}}),M.updateListener.of(o=>{o.docChanged&&t.onChange&&t.onChange(o.state.doc.toString()),o.viewportChanged&&t.onViewport&&t.onViewport()})]}),r=new M({state:s,parent:n});return t.autofocus&&r.focus(),r}function bb(n,e){!n||n.state.doc.toString()===e||n.dispatch({changes:{from:0,to:n.state.doc.length,insert:e},selection:{anchor:Math.min(n.state.selection.main.anchor,e.length)}})}function xb(n){return n?n.state.doc.toString():""}function wb(n,e){n&&n.dispatch({effects:fd.reconfigure(dd(e!==!1))})}function kb(n,e){n&&n.dispatch({effects:ud.reconfigure(W.readOnly.of(!!e))})}function vb(n,e){if(!n)return;let t=n.state.doc.lines,i=Math.max(1,Math.min(t,Number(e)||1)),s=n.state.doc.line(i);n.dispatch({selection:{anchor:s.from},effects:M.scrollIntoView(s.from,{y:"center"})}),n.focus()}function Sb(n){n&&n.focus()}function Cb(n){n&&n.destroy()}function Ab(n){n&&An(n)}function Mb(n){n&&Oi(n)}function Tb(n,e){if(n){if(n.focus(),e==="selectAll"){n.dispatch({selection:{anchor:0,head:n.state.doc.length}});return}if(e==="undo"){An(n);return}if(e==="redo"){Oi(n);return}if(e==="paste"){let t=window.navigator&&window.navigator.clipboard;if(t&&typeof t.readText=="function"){t.readText().then(i=>{i&&n.dispatch(n.state.replaceSelection(i))}).catch(()=>{});return}try{document.execCommand("paste")}catch{}return}try{document.execCommand(e)}catch{}}}function Db(n){if(!n)return{text:"",fromLine:0,toLine:0};let e=n.state.selection.main,t=n.state.sliceDoc(e.from,e.to),i=n.state.doc.lineAt(e.from).number,s=n.state.doc.lineAt(e.to).number;return{text:t,fromLine:i,toLine:s}}window.__molingCM={version:"6",create:yb,setDoc:bb,getDoc:xb,setWrap:wb,setReadOnly:kb,gotoLine:vb,focus:Sb,destroy:Cb,undo:Ab,redo:Mb,runCommand:Tb,getSelection:Db}});Ob();})();
