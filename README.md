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
| 工作台 | 顶部条 | `首页`（回启动页）、工作区下拉、`目录`、`树`（浮层文件树）、`保存`、`编译` |
| 工作台 | 左栏 | 标签条（多标签、未保存 ●、`×` 关闭）+ 编辑器（LaTeX 语法高亮、行号、软换行；`F5` 编译、`Ctrl+S` 保存、`Tab` 缩进） |
| 工作台 | 分栏 | tex 与 pdf 之间是**可拖动分隔条**（20%–80%），宽度记进 localStorage |
| 工作台 | 右栏 | `日志` / `PDF` 切换；日志里错误行可点击跳到源码行；PDF 内嵌预览（blob URL），`新标签` 可单独打开；引擎/模式/清理在右栏头部；**编译状态与错误显示在预览区底部** |
| 工作台 | 浮层 | 文件树抽屉：浮在编辑区上（不占列），**右边框可拖动**（30%–100%），点外部/`Esc`/`×` 关闭，选中文件自动收起 |
| 工作台 | 状态行 | 数据通道指示灯、忙闲、TeX 是否就绪、当前文件 |

**状态**：会话内状态放在模块级 store（切标签页不丢），但**不自动恢复上次的文件/工作区**——只持久化「最近打开」、引擎、模式、过滤词、两个分栏宽度；所以重开 DSH 或刷新页面都从启动页开始。工作台里点 `首页` 随时回到启动页。

**最近文件为什么记 `abs`**：宿主的 `open-file` 收的是绝对路径（相对路径会按 DSH 进程的 cwd 解析，落成 `…\profiles\desktop\xxx.tex` 而报「文件不存在」）。所以最近记录里同时存 `value`（相对）与 `abs`（绝对）；老版本只存了相对路径的记录，会在打开时用 `root + value` 自动补全。

### 语法高亮

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
| `pdf` | `{root,path}` | PDF 的 base64（面板转 blob URL 内嵌预览） |

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

用插件管理器（它同时写依赖与 `dsh.profile.bundles`，也会处理已装同名包）：

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
node test/smoke.mjs          # 工具：注册 / 引擎识别 / status / outline / quick / 失败路径
node test/smoke.mjs --full   # 追加 full、中文 xelatex、SyncTeX、clean
node test/server-smoke.mjs   # 宿主 API：11 个端点 + 白名单 + 越界 + 读写 + 编译 + PDF + 打开目录/文件
node test/client-smoke.mjs   # 浏览器半侧：bundle 注册 + 右侧栏类型/槽位注册 + SSR 渲染
```

`client-smoke` 用本地 DSH 源码 checkout 里的 React；找不到就跳过（可设 `DSH_CHECKOUT`）。

## 结构

```
lib/index.js        宿主入口：5 个工具 + 注册 /moling/api 路由
lib/server.js       与传输无关的操作表（createPanelCore）+ /moling/api 适配器
lib/latex.js        引擎探测、编译流程、日志解析、辅助文件清理、大纲解析
lib/synctex.js      SyncTeX 正反向
lib/client.js       浏览器半侧：右侧栏标签类型 + 正文（模块级 store、目录树、多标签、日志/PDF）
cordis.patch.yml    本组合包的 loader patch 层
```

## 已知差距

- 编辑器是纯 `<textarea>` + 行号槽：**没有语法高亮**，也**没有 SyncTeX 点击跳转**（`latex_synctex` 工具本身可用，只是没接到双击/单击上）。
- 右栏窄：不做左右分栏，PDF/日志在底部切换。
- 视觉验证需人工确认：面板在真实页面里的观感（亮/暗主题、窄栏换行）由使用者过目，自测只覆盖注册与数据链路。

## 排错

| 现象 | 处理 |
| --- | --- |
| 右侧栏指南里没有「墨灵 LaTeX」卡片 | 插件没挂载：`plugin_manager list_bundles` 看有没有 `dsh-plugin-moling-latex`，没有就重装 |
| 面板打开后状态灯是红的 | 数据通道异常：确认 `GET /moling/api/ping` 能返回 `{"ok":true,...}`；否则说明宿主半侧没装载 |
| 导入文件夹后列表是空的 | 列表区会写原因：`不在允许范围内` → 用「目录」打开或写进 `config.allowedRoots`；`另有 N 个其它文件` → 该目录确实没有支持的类型 |
| 编译报「找不到引擎」 | 让 Agent 跑 `latex_status`，或在 config 里指 `texlivePath` |
| PDF 视图空白 | 该环境可能禁用内建 PDF 查看器；点「新标签」用系统/浏览器打开 |
