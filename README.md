# dsh-plugin-moling-latex

**moling_latex** —— 把 **墨灵TeX**（本仓库的 Electron 桌面版）搬进 DSH 的插件，两半：

- **右侧栏工作台**：在 DSH 主界面**右侧栏**注册一个「墨灵 LaTeX」标签页（与 文档 / 文件 / 指南 并列，指南页里有入口卡片）；
- **5 个 Agent 工具**：让本体里的模型直接编译论文、看报错、定位源码行、读大纲。

## 形态与接入点

右侧栏不是"塞一个 div"，而是注册一种**标签页类型**（两步，都在 `ctx.effect` 里）：

```js
// 1) 声明类型（右侧栏按 kind 派发正文，按 id 找到正文槽位）
ctx.sidebarRightTabs.register({
  id: 'dsh-plugin-moling-latex',
  kind: 'moling',
  title: () => '墨灵 LaTeX',
  guide: [{ order: 40, title: () => '墨灵 LaTeX', description: () => '本地 LaTeX 工程：目录树 / 编辑 / 编译 / PDF' }],
  keepMounted: true,
})
// 2) 注册正文
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-plugin-moling-latex' }, Body))
```

打开方式：展开右侧栏 → 指南页里的「墨灵 LaTeX」卡片；或标签条上的 `+` → 指南 → 卡片。

**限制**（来自右栏本身）：右栏按**会话**存在，没有会话就没有内容；窄栏里是单列布局。

## 面板里有什么

**先落在启动页**（按墨灵 TeX 桌面版欢迎页的结构排的）：每次进来先看到「最近」，点一个项目/文件才进入工作台；不会自动打开某个工作区，也不会自动拉出 tex|pdf。

| 视图 | 区域 | 能力 |
| --- | --- | --- |
| 启动页 | 头部 | 大标题「墨灵 LaTeX」+ 副标题「编辑 · 编译 · 预览 — 本地一体化 LaTeX 工作流」 |
| 启动页 | 启动 | `新建文档`（在当前/最近的工作区里生成 ctexart 骨架并打开，Ctrl+N）、`打开文件夹…`（原生目录选择，Ctrl+K）、`打开文件…`（进工作台并展开文件树，Ctrl+O）；每行右侧显示快捷键 |
| 启动页 | 最近 | 一行一条：`工作区`/`文件` 类型标签 + 名称 + 右对齐路径；点工作区进项目，点文件直接打开 |
| 启动页 | 模板 | 一张卡片：`新建中文文档`（ctexart 骨架：标题/作者/日期/一节正文） |
| 启动页 | 提示栏 | 快捷键速查、TeX 环境（版本 + bin 目录）、数据通道状态；窄的时候自动折到下方 |
| 工作台 | 顶部条 | `首页`、工作区下拉、`目录`、`树`（浮层文件树）、`换行`、`保存`、`提纲`、`新建`（在当前项目里建 ctexart 骨架，`Ctrl+N` 同效），右端是**连接状态胶囊 + 分体编译按钮**：胶囊显示项目是否已在左侧 DSH 工作区（点一下连接/刷新），编译按钮左边 3/4 显示当前编译方式、点一下即编译，右边 1/4 小三角改方式 |
| 工作台 | 提纲 | 点 `提纲` → 编辑区**左下角浮出**章节列表（`\part`…`\paragraph`，按层级缩进 + 行号），点一条跳该行；解析在浏览器里做，不请求宿主 |
| 工作台 | 左栏 | 标签条（多标签、未保存 ●、`×` 关闭）+ 编辑器（LaTeX 语法高亮、行号、软换行；`F5` 编译、`Ctrl+S` 保存、`Tab` 缩进） |
| 工作台 | 分栏 | tex 与 pdf 之间是**可拖动分隔条**（20%–80%），宽度记进 localStorage |
| 工作台 | 右栏 | `日志` / `PDF` 切换（也可在状态栏最右点）；日志里错误行可点击跳到源码行；PDF 是**逐页图片**（可 Ctrl+滚轮缩放），**单击页面可定位回源码行**；引擎/清晰度/缩放/清理/新标签在右栏头部；错误详情仍在预览区底部 |
| 工作台 | 浮层 | 文件树抽屉：浮在编辑区上（不占列），**右边框可拖动**（30%–100%），点外部/`Esc`/`×` 关闭，选中文件自动收起 |
| 工作台 | 状态行 | 数据通道指示灯、忙闲、TeX 是否就绪、当前文件；**最右**是 `日志` / `PDF` 切换；**正中**是编译结果（成功绿色、失败红色，绝对居中不挤两侧） |

**状态**：会话内状态放在模块级 store（切标签页不丢），但**不自动恢复上次的文件/工作区**——只持久化「最近打开」、引擎、模式、过滤词、两个分栏宽度；所以重开 DSH 或刷新页面都从启动页开始。工作台里点 `首页` 随时回到启动页。

**最近文件为什么记 `abs`**：宿主的 `open-file` 收的是绝对路径（相对路径会按 DSH 进程的 cwd 解析，落成 `…\profiles\desktop\xxx.tex` 而报「文件不存在」）。所以最近记录里同时存 `value`（相对）与 `abs`（绝对）；老版本只存了相对路径的记录，会在打开时用 `root + value` 自动补全。

### 编辑器

**CodeMirror 6**（内核已内联进 `lib/client.js` 末尾，源码在 `lib/vendor/`），要点：

- **只渲染视口内的行**（虚拟化）：1435 行 / 142 KB 的论文，DOM 里只有 ~29 行、行号 ~30 个；实测**每次按键 1 ms**（原生 `<textarea>` 同文档要 17–23 ms）。
- 光标、选区、折行都是编辑器自己画的 → 不存在「字形与光标错位」。
- LaTeX 着色用 CodeMirror 5 时代的 `stex` 模式（`@codemirror/legacy-modes`）+ `StreamLanguage`：[`@codemirror/lang-latex`](https://www.npmjs.com/package/@codemirror/lang-latex) 在当前 registry 上 404。
- 自带：括号匹配、行号、搜索（`Ctrl+F`）、撤销栈、行内补全无关；`Ctrl+S` 保存、`F5` 编译、`Tab` 缩进都接管了。
- 配色仍只用主题 token（`--dsw-alias-*`），亮/暗自动跟随。
- **回退**：内核脚本加载失败（端点缺失、离线等）→ 自动退回旧实现（透明 `<textarea>` 叠高亮层），功能一样、大文件会慢。回退路径的两层宽度补偿：`textarea` 用 `scrollbar-gutter: stable` 永久预留滚动条槽，高亮层按探测到的滚动条宽度补 `padding-right`，两层内容宽度恒等（这是此前「删错字」的根治手段）。
- 重新构建内核：见 `lib/vendor/BUILD.md`（源码在 `lib/vendor/entry.js`）。

### 与 DSH 会话互动

- **连接状态胶囊**（顶栏编译按钮左边）：把当前项目目录与 DSH 工作区列表比对，三种状态 ——
  `已连接 DSH 工作区`（绿）/ `同名工作区不同路径`（黄，防止发错项目）/ `未连接 DSH 工作区`（灰）。
  只认 `kind === 'workspace'` 的条目：宿主列表里还有 `kind: 'opened'`（插件自己打开过的目录），**那种不算连接**。
  未连接时**点一下**就调客户端服务 `workspaces.create({ path })` 把该目录加进左侧工作区；已连接时点一下是刷新。切回窗口会自动刷新工作区列表。
- **发送选中内容到对话框**（编辑器右键菜单）：把选区包成「出处 + `latex` 代码块」送进当前会话的输入框（不自动发送）：
  `> 来自 main.tex 第 12–15 行` + 围栏代码。通道是右栏 tab body 的注入属性 `inputActions`（依次探 `appendText`/`insertText`/`setText`/…），
  拿不到就退化为复制到剪贴板并在状态栏提示。
- 硬限制：只能作用于**当前会话**——DSH 没有“按工作区找会话并往里写文本”的 API，所以项目不在工作区时先拦住并提示先连接。

### SyncTeX 双向定位

- **源码 → PDF**：编辑器里**右键** → 菜单「定位到 PDF 位置（第 N 行）」→ `synctex view` 拿到 `{page,x,y}` → 右栏切到 PDF、滚到该页，黄色圆圈标出位置。右键菜单同时保留基础编辑功能：撤销/重做/剪切/复制/粘贴/全选（面板接管了原生菜单，这些要自己补）。
- **PDF → 源码**：在预览页上**单击** → 点击处换算成 PDF 点（`px / dpi * 72`）→ `synctex edit` 拿到行号 → 编辑器跳到该行。
- 结果写在**底部状态栏**（`第 6 行 → 第 1 页` / `PDF 第 1 页 → 源码第 10 行`）；失败也写在那里。
- 前提：编译时带 `-synctex=1`（本插件的编译流程默认带），PDF 与 `.synctex.gz` 同目录。
- 已知修复：多页 PDF 里「源码→PDF」曾经滚错页（页面 ref 的闭包写到了最后一页），已改成按页捕获。

### 语法高亮（回退实现 / 分词逻辑）

带状态的轻量 LaTeX 词法（跨行数学环境、注释、引用键），配色全部取自主题 token：

| 类别 | 例子 | token |
| --- | --- | --- |
| 命令 | `\section` `\item` | `brand-primary`，500 字重 |
| 环境名 | `\begin{equation}` 里的 `equation` | `state-error-primary` |
| 引用/标签键 | `\cite{…}` `\ref{…}` `\label{…}` `\input{…}` | `state-warn-primary` |
| 数学 | `$…$`，以及 `\begin{equation}…\end{equation}` 整段（可跨行） | `state-success-primary` |
| 注释 | `% …` 整行 | `label-secondary`，斜体 |
| 括号 / 数字 | `{}` `[]` / 数字 | `label-secondary` / `state-success-primary` |

章节命令（`\part` `\chapter` `\section` `\subsection`…）所在行整行加粗。超过 30 万字符的文件退化为纯文本（保留行号与换行）；行级缓存保证大文件里打字只重排被编辑的那一行（实测 3000 行 / 4.8 万 token 的分词 8ms）。

## 通信方式

面板与本机同装插件 `dsh-drawai` 走同一条**已验证**的路子：宿主注册一条 HTTP 前缀路由，面板同源 `fetch`。

```js
// 宿主（lib/index.js）
ctx.webServer.register({ kind: 'prefix', path: '/moling/api', handler })
// 面板（lib/client.js）
fetch('/moling/api/tree', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"root":"…"}' })
```

一律返回 `{ ok: true, value }` / `{ ok: false, error }`。同源请求不需要 CORS、不需要令牌。
（DSH 的 Connection RPC 更"官方"，但第三方文件插件没有注册入口——只有动态插件拿得到 `host.call`；`dsh.client` 只能用 `ctx.remote.*` 那套 Typert 远程，需要宿主自己实现 Remote 服务。）

### 端点

| 端点 | 入参 | 说明 |
| --- | --- | --- |
| `ping` | — | 探活（GET/POST 都行） |
| `status` | — | TeX 环境 |
| `workspaces` | — | 已注册工作区 + 打开过的目录 |
| `open-root` | `{root}` | 登记一个目录为允许根 |
| `open-file` | `{path}` | 打开单个文件（登记其所在目录）并返回内容 |
| `tree` | `{root}` | 扁平 `files` + 嵌套 `tree`，附 `total`/`skipped` |
| `read-file` | `{root,path}` | 读文本 |
| `write-file` | `{root,path,content}` | 写文本 |
| `compile` | `{root,file,mode,engine}` | 编译，返回错误/警告/日志 + `pdfRel`/`pdfMtime` |
| `clean` | `{root,file}` | 清辅助文件 |
| `pdf` | `{root,path,meta?}` | 整份 byte 数 + `mtime` + `pages`（页数）+ `raster`；不带 `meta` 时另给 `base64` |
| `pdf-page` | `{root,path,page,dpi}` | 第 `page` 页的 **PNG 二进制**（GET 也支持：`?root=&path=&page=&dpi=`）；dpi 夹在 48–200 |
| `asset` | `{name}` | 发 `lib/vendor/` 下的浏览器资源（目前只有 `cm6.js`）；只认 `[A-Za-z0-9._-]+\.(js\|css)` |
| `synctex` | `{direction,root,file,pdf,line}` / `{direction:'backward',root,file,pdf,page,x,y}` | SyncTeX 双向：源码行 → `{page,x,y}`；PDF 点 → `{line,file}` |

### PDF 预览：降分辨率图片，而不是浏览器内置阅读器

预览默认是「**一页一张 PNG**」，由宿主用 TeX Live 自带的 poppler（`pdftoppm`）按所选 dpi 栅格化，
前端只 `<img loading="lazy">` 等比缩放。对比内置 PDF 阅读器少掉三笔开销：

| 旧（blob + 内置阅读器） | 现在（栅格化图片） |
| --- | --- |
| `.pdf` 整份读进内存再转 base64（48MB 的 PDF → 64MB 字符串） | 只按页取图，取多少看滚到哪 |
| PDFium 按**设备像素**渲染整页，滚动/缩放时重绘 | 浏览器只解码 + 缩放位图，不做 PDF 解析 |
| 只能靠缩放间接影响像素量 | dpi 与清晰度**直接解耦**：72 / 96 / 144 三档 |

- 缓存：`%TEMP%\dsh-moling-pdf\<sha1>.png`，键 = 绝对路径 + PDF `mtime` + dpi + 页码；重新编译换了 mtime 自然换键。前端 URL 里带 `v=<mtime>`，所以能 `immutable` 长缓存。
- 回退：找不到 `pdftoppm`，或某一页取图失败 → 自动退回内置阅读器（`pdf` 端点给 base64 → blob → iframe），不黑屏。
- 代价：栅格化发生在编译后首次预览，单页约 40–80ms（进程启动占大头），之后走缓存直接命中。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `latex_compile` | 编译 `.tex`。`quick` 单趟 draft；`full` 主编译 →（需要时）bibtex → 再编译 → 视 Rerun 提示补一趟；`clean` 先清辅助文件再走 full |
| `latex_status` | TeX Live / MiKTeX 探测：bin 目录、版本、六个引擎路径 |
| `latex_synctex` | SyncTeX 双向同步：源码行 → PDF 坐标；PDF 坐标 → 源码行 |
| `latex_clean` | 删除 `.aux/.log/.toc/.out/.bbl/.synctex.gz/...`（不碰 `.tex/.pdf/.bib`） |
| `latex_outline` | 章节标题与行号、`\input`/`\include` 依赖、`\label`/`\cite` 计数 |

引擎缺省 `auto`：`ctex`/中文 → `xelatex`；`IEEEtran`/`elsarticle`/`article` → `pdflatex`。

## 安装

### 一键安装（给别人用）

在 DSH 里让 agent 执行（或自己在插件管理器里填同一个地址）：

```
plugin_manager install_bundle  https://github.com/dichi123456/dsh-molingTex/releases/download/v0.6.0/dsh-plugin-moling-latex-0.6.0.tgz
```

也可以直接用 git 源（跟随 `main` 最新提交）：

```
plugin_manager install_bundle  github:dichi123456/dsh-molingTex
```

发布页：<https://github.com/dichi123456/dsh-molingTex/releases>

两种方式都实测可用（`npm i <tarball-url>` / `npm i github:dichi123456/dsh-molingTex` 都能装上 0.6.0，含 `lib/vendor/cm6.js`）。

前置条件：

- DSH（带插件管理器）——插件以 `dsh.bundle` + `cordis.patch.yml` 挂载；
- 本机 TeX 发行版（TeX Live / MiKTeX）：编译要 `xelatex`/`pdflatex`，PDF 预览要 poppler 的 `pdftoppm`，双向定位要 `synctex`；
- 装完**重开 DSH**（宿主半侧要加载 `lib/server.js`）。

### 本地开发安装

```
plugin_manager install_bundle  E:\E_个人项目\Latex_APP\dsh-plugin-moling-latex
```

> 已装的同版本会返回 `already-installed`：先 `remove_bundle` 再 `install_bundle`。
> **注意**：用 `dsh plugin add` 安装别的插件时，profile 的 `dsh.profile.bundles` 可能被重写；
> 如果哪天面板突然消失，先看该文件里还有没有 `dsh-plugin-moling-latex`，没有就重装一次。

`lib/client.js` 改动有 HMR；`lib/index.js`、`lib/server.js` 改动要重开 DSH。

## 配置

`cordis.patch.yml` 里 insert 行的 `config`：

```yaml
- insert:
    - id: moling_latex
      name: 'dsh-plugin-moling-latex'
      config:
        texlivePath: ''    # 空 = 自动探测（本配置 > 墨灵TeX 的 config.json > PATH/常见路径）
        engine: auto       # auto | xelatex | pdflatex | lualatex | latexmk
        timeoutMs: 120000  # 单趟超时；超时终结整棵进程树
        maxLogChars: 8000  # 写回会话记录的日志上限
        allowedRoots: []   # 额外允许打开的目录
```

**能打开哪些目录**：DSH 已注册的工作区 **+** 你在面板里显式打开过的目录/文件所在目录（本次运行内有效）
**+** `config.allowedRoots`。三者都为空时才退化为「任意已存在目录」。
所有 `path` 都会解析并校验必须落在 `root` 之内；写文件只接受文本类型。

## 自测

```bash
node test/smoke.mjs          # 工具：注册 / 引擎识别 / status / outline / quick / 失败路径（12）
node test/smoke.mjs --full   # 追加 full、中文 xelatex、SyncTeX、clean
node test/server-smoke.mjs   # 宿主 API：15 个端点 + 白名单 + 越界 + 读写 + 编译 + PDF + asset + synctex + outline（34）
node test/client-smoke.mjs   # 浏览器半侧：bundle/槽位/SSR/词法/路径/PDF/编辑器/顶栏/提纲/新建/连接（145）
node test/live-api.mjs       # 对正在运行的 DSH 打真实 HTTP（端口取 DSH_WEB_URL）
```

合计 **12 + 34 + 145 = 191** 项。

`client-smoke` 用本地 DSH 源码 checkout 里的 React；找不到就跳过（可设 `DSH_CHECKOUT`）。

## 结构

```
lib/index.js        宿主入口：5 个工具 + 注册 /moling/api 路由
lib/server.js       与传输无关的操作表（createPanelCore）+ /moling/api 适配器
lib/latex.js        引擎探测、编译流程、日志解析、辅助文件清理、大纲解析
lib/synctex.js      SyncTeX 正反向
lib/client.js       浏览器半侧：右侧栏标签类型 + 正文（模块级 store、目录树、多标签、日志/PDF、编辑器）
lib/vendor/cm6.js   打包好的编辑器内核（CodeMirror 6，挂在 window.__molingCM）
lib/vendor/entry.js 内核源码；BUILD.md 是重建步骤
cordis.patch.yml    本组合包的 loader patch 层
```

## 已知差距

- **没有 SyncTeX 点击跳转**（`latex_synctex` 工具本身可用，只是没接到双击/单击上）。
- 内核脚本（395 KB）加载完成后才切到 CodeMirror；在此之前用回退编辑器顶着（同源本地请求，实际很快）。
- PDF 预览的图片按栏宽等比缩放：栏宽超过该 dpi 的页面像素宽时会略糊（拉窄栏或把清晰度调到「高」）。
- 视觉验证需人工确认：面板在真实页面里的观感（亮/暗主题、窄栏换行）由使用者过目，自测只覆盖注册与数据链路。

## 排错

| 现象 | 处理 |
| --- | --- |
| 右侧栏指南里没有「墨灵 LaTeX」卡片 | 插件没挂载：`plugin_manager list_bundles` 看有没有 `dsh-plugin-moling-latex`，没有就重装 |
| 面板打开后状态灯是红的 | 数据通道异常：确认 `GET /moling/api/ping` 能返回 `{"ok":true,...}`；否则说明宿主半侧没装载 |
| 导入文件夹后列表是空的 | 列表区会写原因：`不在允许范围内` → 用「目录」打开或写进 `config.allowedRoots`；`另有 N 个其它文件` → 该目录确实没有支持的类型 |
| 编译报「找不到引擎」 | 让 Agent 跑 `latex_status`，或在 config 里指 `texlivePath` |
| PDF 预览空白 | 先看底部状态条：写「降分辨率预览不可用」= 取图失败（退回了内置阅读器）；两样都空则该环境禁用了 PDF 查看器，点「新标签」用系统/浏览器打开 |
| 刷新页面后 PDF 预览没变 | `lib/server.js` 改了要**重开 DSH**（`pdf-page` 是新端点）；只改 `lib/client.js` 才是刷新即可 |
