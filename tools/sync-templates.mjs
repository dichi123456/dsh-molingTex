/**
 * 把桌面版（墨灵TeX，../src/templates）的模板素材同步进插件：
 *   lib/templates/<id>/main.tex  + 附带类文件 / 图片
 *   lib/templates/index.json     + 元数据（启动页模板卡片用）
 *
 * 桌面版那份注册表在 src/utils/templates.ts 里（Vite `?raw` + base64 常量），
 * 浏览器半侧没法 require 它，所以这里按同一份 id / 文案 / 引擎导出一份纯数据。
 *
 *   node tools/sync-templates.mjs                     # 默认 ../src/templates
 *   MOLING_TEMPLATES_SRC=D:\xxx node tools/sync-templates.mjs
 *
 * 只在开发机上跑（需要桌面版仓库在隔壁）；产物已提交，装插件的人不需要它。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const source = process.env.MOLING_TEMPLATES_SRC || join(pluginRoot, '..', 'src', 'templates')
const target = join(pluginRoot, 'lib', 'templates')

/**
 * 每项：id / 展示名 / 分类 / 引擎 / 描述 / 卡片配色与版式（对应桌面版 makePreview 的 accent+layout）
 *   src  相对 src/templates 的主 tex
 *   main 落地后的主文件名（统一 main.tex，和桌面版 useTemplate 一致）
 *   also 额外要一起搬的文件/目录（相对主 tex 所在目录）
 */
const CATALOG = [
  {
    id: 'zh-article', name: '中文论文', category: '中文论文', engine: 'xelatex',
    description: 'ctexart 中文课程论文/学位论文模板，含封面、摘要、章节结构',
    accent: '#2563eb', layout: 'stack', src: '中文论文.tex'
  },
  {
    id: 'cumcm', name: '国赛论文', category: '中文论文', engine: 'xelatex',
    description: '全国大学生数学建模竞赛（CUMCM）标准模板，含封面、承诺书、摘要、示例图片与参考文献结构',
    accent: '#dc2626', layout: 'stack', src: 'cumcm/main.tex',
    also: ['cumcmthesis.cls', 'cumcm2026.sty', 'figures']
  },
  {
    id: 'en-article', name: '英文论文', category: '英文论文', engine: 'pdflatex',
    description: '英文期刊/会议论文模板，含 abstract、references 结构',
    accent: '#0ea5e9', layout: 'stack', src: '英文论文.tex'
  },
  {
    id: 'ieee-conference', name: 'IEEE 投稿模板', category: '英文论文', engine: 'pdflatex',
    description: '基于官方 IEEEtran 的会议/期刊骨架（TeX Live 自带类文件）',
    accent: '#00629b', layout: 'stack', src: '英文论文/IEEE投稿模板.tex'
  },
  {
    id: 'elsevier-journal', name: 'Elsevier 投稿模板', category: '英文论文', engine: 'pdflatex',
    description: '基于官方 elsarticle 的预印本/期刊骨架',
    accent: '#ff6600', layout: 'stack', src: '英文论文/Elsevier投稿模板.tex'
  },
  {
    id: 'wiley-journal', name: 'Wiley 投稿模板', category: '英文论文', engine: 'pdflatex',
    description: 'Wiley 常见期刊结构骨架；正式提交请按目标期刊下载 Wiley class',
    accent: '#9b0000', layout: 'stack', src: '英文论文/Wiley投稿模板.tex'
  },
  {
    id: 'elsevier-cas-dc', name: 'Elsevier CAS 双栏', category: '英文论文', engine: 'pdflatex',
    description: 'Elsevier 官方 CAS 双栏模板（cas-dc），含类文件、示例图与参考文献',
    accent: '#ff6600', layout: 'column', src: '英文论文/Elsevier_CAS_双栏/cas-dc-template.tex',
    also: ['cas-dc.cls', 'cas-common.sty', 'cas-refs.bib', 'model1-num-names.bst', 'figs']
  },
  {
    id: 'elsevier-cas-sc', name: 'Elsevier CAS 单栏', category: '英文论文', engine: 'pdflatex',
    description: 'Elsevier 官方 CAS 单栏模板（cas-sc），含类文件、示例图与参考文献',
    accent: '#ff6600', layout: 'stack', src: '英文论文/Elsevier_CAS_单栏/cas-sc-template.tex',
    also: ['cas-sc.cls', 'cas-common.sty', 'cas-refs.bib', 'model1-num-names.bst', 'figs']
  },
  {
    id: 'ieee-conference-official', name: 'IEEE 会议论文（官方）', category: '英文论文', engine: 'pdflatex',
    description: 'IEEE 官方会议模板 conference_101719，自带 IEEEtran.cls 与示例图',
    accent: '#00629b', layout: 'stack', src: '英文论文/IEEE_Conference_Official/conference_101719.tex',
    also: ['IEEEtran.cls', 'fig1.png']
  },
  {
    id: 'ieee-journal-official', name: 'IEEE 期刊论文（官方）', category: '英文论文', engine: 'pdflatex',
    description: 'IEEE 官方期刊骨架 bare_jrnl（IEEEtran journal），依赖 TeX Live 自带类文件',
    accent: '#00629b', layout: 'stack', src: '英文论文/IEEE_Journal_Official/bare_jrnl.tex'
  },
  {
    id: 'resume-undergrad', name: '中文应届生简历', category: '简历', engine: 'xelatex',
    description: '单栏应届生简历，含教育、实习、项目、技能与奖项，适合校招投递',
    accent: '#1a56db', layout: 'side', src: '简历/中文应届生简历.tex'
  },
  {
    id: 'resume-tech', name: '中文技术双栏', category: '简历', engine: 'xelatex',
    description: '深色侧栏 + 主内容区双栏布局，适合社招技术岗',
    accent: '#3b82f6', layout: 'column', src: '简历/中文技术双栏简历.tex'
  },
  {
    id: 'resume-compact', name: '中文紧凑简历', category: '简历', engine: 'xelatex',
    description: '高信息密度单页简历，适合内容较多时控制在一页内',
    accent: '#0f766e', layout: 'side', src: '简历/中文紧凑简历.tex'
  },
  {
    id: 'resume-en', name: '英文简历', category: '简历', engine: 'xelatex',
    description: 'Awesome-CV 风格英文简历，含 Education、Experience、Projects、Skills',
    accent: '#5b21b6', layout: 'side', src: '简历/英文简历.tex'
  },
  {
    id: 'zh-resume', name: '中文简历（简洁）', category: '简历', engine: 'xelatex',
    description: '简洁中文简历模板，含教育背景、项目经历、技能板块',
    accent: '#10b981', layout: 'side', src: '中文简历.tex'
  },
  {
    id: 'beamer-madrid', name: 'Beamer 经典 Madrid', category: '幻灯片', engine: 'xelatex',
    description: '经典 Beamer Madrid 主题，适合通用学术报告入门',
    accent: '#8b5cf6', layout: 'stack', src: '幻灯片/Beamer经典Madrid.tex'
  },
  {
    id: 'slides-academic-metro', name: '学术研究汇报', category: '幻灯片', engine: 'xelatex',
    description: 'Metropolis 现代深色主题，适合组会/学术报告，含结果表与公式',
    accent: '#1e293b', layout: 'stack', src: '幻灯片/学术研究汇报.tex'
  },
  {
    id: 'slides-course', name: '课程报告', category: '幻灯片', engine: 'xelatex',
    description: '清新青绿双色课程展示，含流程图与作业提示结构',
    accent: '#0f766e', layout: 'stack', src: '幻灯片/课程报告.tex'
  },
  {
    id: 'slides-modern-cn', name: '现代中文报告', category: '幻灯片', engine: 'xelatex',
    description: '浅色现代 Metropolis 变体，适合项目进展与阶段汇报',
    accent: '#0ea5e9', layout: 'stack', src: '幻灯片/现代中文报告.tex'
  },
  {
    id: 'slides-minimal-en', name: '极简英文研讨会', category: '幻灯片', engine: 'xelatex',
    description: 'Arguelles 极简英文 seminar 风格，适合国际组会与 journal club',
    accent: '#334155', layout: 'stack', src: '幻灯片/极简英文研讨会.tex'
  },
  {
    id: 'lab-report', name: '实验报告', category: '报告', engine: 'xelatex',
    description: '大学物理/化学等课程实验报告模板，含实验目的、步骤、数据表格',
    accent: '#f59e0b', layout: 'stack', src: '实验报告.tex'
  }
]

if (!existsSync(source)) {
  console.error(`找不到模板源目录：${source}`)
  process.exit(1)
}

// 不删目录（沙箱/Windows 上删目录容易 EPERM，而且没必要）：逐个覆盖写就行
mkdirSync(target, { recursive: true })

const filesOf = (dir) => {
  const rows = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      rows.push(relative(dir, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return rows.sort()
}

/** 逐文件拷贝：不用 fs.cpSync —— 它在 Windows 上覆盖已有文件时会报 errno 0 的假错误 */
const copyOne = (from, to) => {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      copyOne(join(from, entry.name), join(to, entry.name))
    }
    return
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

const index = []
for (const item of CATALOG) {
  const srcMain = join(source, item.src)
  if (!existsSync(srcMain)) { console.error(`缺少主文件：${srcMain}`); process.exit(1) }
  const outDir = join(target, item.id)
  mkdirSync(outDir, { recursive: true })
  copyOne(srcMain, join(outDir, 'main.tex'))
  const base = dirname(srcMain)
  for (const extra of item.also || []) {
    const from = join(base, extra)
    if (!existsSync(from)) { console.error(`缺少附带文件：${from}`); process.exit(1) }
    copyOne(from, join(outDir, extra))
  }
  const files = filesOf(outDir)
  const bytes = files.reduce((sum, rel) => sum + statSync(join(outDir, rel)).size, 0)
  index.push({
    id: item.id,
    name: item.name,
    category: item.category,
    engine: item.engine,
    description: item.description,
    accent: item.accent,
    layout: item.layout,
    main: 'main.tex',
    files,
    bytes
  })
  console.log(`  ✓ ${item.id} — ${files.length} 个文件 / ${(bytes / 1024).toFixed(0)} KB`)
}

writeFileSync(join(target, 'index.json'), JSON.stringify({ templates: index }, null, 2) + '\n', 'utf8')
console.log(`\n共 ${index.length} 个模板 → ${relative(pluginRoot, target) || target}`)
