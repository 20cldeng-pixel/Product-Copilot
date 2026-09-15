<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/appicon-dark.png" />
    <img src="assets/appicon-light.png" width="128" alt="EasyMint" />
  </picture>
</p>

<h1 align="center">EasyMint</h1>

<p align="center">
  <strong>内置 Pi Agent 的开源桌面 AI 编程平台。</strong>
</p>

<p align="center">
  <a href="https://github.com/tianemon/EasyMint/releases"><img src="https://img.shields.io/github/v/release/tianemon/EasyMint?style=flat-square&color=16a34a" alt="Version" /></a>
  <img src="https://img.shields.io/badge/Pi%20Coding%20Agent-0.85.1-blue?style=flat-square" alt="Pi Coding Agent" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

---

## 定位

EasyMint 是一个**内置 Pi Agent 的开源桌面 AI 编程平台**——[Pi Coding Agent](https://github.com/pi-ai-engineering/pi-coding-agent) 作为内置的 AI 编程引擎，其专业能力足以支撑完整的软件开发流程；EasyMint 在其上提供图形化界面、多 Agent 协作与项目引导，覆盖从需求采集到成品交付的完整链路。

面向两类使用场景：

- **编程新手**：通过对话引导完成需求采集、原型确认与技术方案确认，以点选和对话的方式驱动开发
- **开发者**：使用多 Agent 协作、会话管理与跨设备迁移等能力，作为日常的 AI 编程工作台

创建项目支持两条路径，均可随时切换：

- **对话直接创建**：不经过表单，直接描述想法。Mint 按引导流程主动补全信息，也支持跳过引导自由描述、由 AI 自行理解推进
- **表单创建**：通过结构化表单采集基本信息（名称/场景/功能/风格/预算），Mint 在对话中补全开放信息

## 核心特性

- **对话式项目引导**——双路径创建（对话直接创建 / 表单创建），按场景与认知水平自动调整引导深度；**7 道 Gate** 把关（需求意图 → 范围 → 原型 → 用户确认 → 技术方案〔能力 / 实时检索 / 成本三重验证〕→ 正式开发 → 成品对照已确认原型验证，仅验代码不算完）
- **原型先行**——中等及以上项目先产出可交互 HTML 原型（内置设计师 Agent 与品牌库），确认后才进入开发
- **多 Agent 协作**——项目经理 Agent 拆解需求、编码 Agent 实现、验收 Agent 检查、设计师 Agent 出原型，自动循环直至完成
- **子 Agent 委派**——查资料、读代码、分析问题等任务委派标准子 Agent 执行并回传摘要，避免挤占主会话上下文；委派过程可视化（进度卡片/过程弹层）
- **权限模式**——「标准 / 完全访问」两档：标准模式下命令在系统级沙盒中执行；完全访问前有一次风险确认，且系统核心、敏感凭据与 EasyMint 自身配置在两种模式下都始终禁止改写
- **Skill 生态互通**——自动发现并直接使用 Claude Code、Codex、GitHub Agent Skills 生态的 skill，兼容既有技能资产，不锁定单一工具
- **经验自沉淀**——开启后 Mint 在任务完成时自行判断并沉淀经验（直接入库、可改可删），后续会话按技术栈检索复用
- **上下文自管理**——上下文使用率实时显示，达到阈值弹窗确认整理，压缩过程透明可中断；长对话不「失忆」
- **Issue 闭环**——开发中的问题可记录、编辑、标记状态，Mint 读取清单并同步修复进度
- **会话管理**——多 Tab 会话、多窗口；会话状态（思考/工具/压缩）按会话隔离互不串扰；会话可归档与恢复
- **运行面板**——项目脚本一键检测/运行/停止/重启，端口占用实时监控，彩色日志输出窗口（ANSI 渲染），脚本可编辑与删除
- **历史输入检索**——当前会话提问记录一键回顾（右侧抽屉 + 关键词搜索），点击跳转对应消息
- **内容便签**——AI 输出的重要内容可一键钉成悬浮便签，调整大小、吸附固定、随会话持久化
- **数据主权**——项目文件与会话数据全部存储本地（`~/.easymint/` 与项目内 `.easymint/`），不上云、不锁定
- **跨设备迁移**——同一局域网内的设备自动发现，配对一次后长期免配对；项目与历史会话可整体投送到另一台设备，支持文件级选择、多会话迁移与忽略配置，对端需要确认接收；传输加密并带整包校验，中断不会留下半个项目目录

## 界面预览

| 主界面 |
|---|
| ![主界面](assets/screenshots/main.png) |

| 任务面板 | 运行面板 |
|---|---|
| ![任务面板](assets/screenshots/task-panel.png) | ![运行面板](assets/screenshots/run-panel.png) |

| 历史输入抽屉 | 内容便签 |
|---|---|
| ![历史输入抽屉](assets/screenshots/history-drawer.png) | ![内容便签](assets/screenshots/pin-notes.png) |

| 子 Agent 输出窗口 | Shell 输出窗口（ANSI 彩色） |
|---|---|
| ![子 Agent 输出](assets/screenshots/agent-output.png) | ![Shell 输出](assets/screenshots/shell-output.png) |

| 第三方视觉模型设置 | 输入卡片（Agent / Shell 状态胶囊） |
|---|---|
| ![视觉模型设置](assets/screenshots/vision-model.png) | ![输入卡片](assets/screenshots/agent-capsules.png) |

## 多 Agent 协作

- **Mint（项目经理）**——需求理解、任务拆解（task.json）、Agent 调度、进度把控
- **Builder（编码）**——按任务实现代码、运行测试、修复问题，支持 TDD
- **Evaluator（验收）**——对照需求检查产出，不合格退回重做
- **Mint-D（UI 设计）**——产出 HTML 原型，内置品牌库与设计规范
- **子 Agent（通用委派）**——探索、审查、实现等类型化委派，回传摘要不占主上下文

任务进度在面板实时展示；角色任务指定对应模板，通用任务使用标准子 Agent，委派深度与类型受控。

## 权限与安全

命令是否放行，由**实际执行时的操作系统沙盒**决定，而不是应用层的自我约束：

- **标准模式**——命令在系统级隔离环境中运行：macOS 用系统自带的 Seatbelt，Linux 用 bubblewrap，Windows 用独立沙盒账户配合内核级网络过滤
- **完全访问模式**——需要读写工作区之外的普通文件时使用；切换前有一次性的风险确认，写明所运行的命令、依赖安装脚本与子进程会获得相同权限，而系统核心、敏感凭据与 EasyMint 自身安全配置仍然禁止访问
- **状态一眼可见**——输入卡的盾形图标与配色随权限模式切换，完全访问档位用醒目配色标识（颜色本身也在表达「危险」）
- **判定口径克制**——只对确定目标的路径做提前判定，并拦截提权类命令；命令中的消息文本、正则与脚本内容不会被当成路径误判
- **环境自动就绪**——首次启动会检测这些系统组件，缺什么一键补齐（Windows 需过一次系统授权）；确实装不上时，可在「设置 → 环境检测」关闭沙盒运行，面板会写清后果，也可随时开回来

## 经验沉淀

Mint 可以把「这次踩的坑与解法」沉淀成经验，供后续项目复用（默认关闭，可在设置中开启）：

- **两级作用域**——全局经验（本机环境、协作方式）与项目经验分开存放，项目经验随项目走
- **只注入索引**——上下文里只放标题、标签与计数，正文按需读取，不挤占对话空间
- **按技术栈投递**——带技术栈或平台标签的经验只在匹配的项目里出现（Flutter 的经验不会跑进 React 项目）
- **可读可改可删**——经验就是 markdown 文件，沉淀时直接入库、无需确认，随时可改可删

## 项目管理

- 文件树 + Monaco 编辑器（语法高亮、智能提示）
- 多 Tab 会话、多窗口
- 项目重命名（会话数据自动迁移）/ 重新定位 / 导入已有目录
- Git 集成
- 跨设备项目迁移（文件与会话）

## 内容便签

AI 输出的重要内容可钉成悬浮便签固定在聊天区：一键钉住、可调大小、吸附成彩色贴纸、随会话持久化。

## Agent 模板

Mint / Builder / Evaluator / Mint-D 各有内置模板，除 Mint 外可编辑；可新建自定义模板，指定职责、供应商、模型与思考级别。

## Skill 生态

EasyMint 与主流 AI 编程工具的 skill 生态互通，已有的技能资产开箱即用：

- **自动发现**：Claude Code（`~/.claude/skills/`）、Codex（`~/.codex/skills/`）与 GitHub Agent Skills（项目 `.github/skills/`）目录下的标准 skill 自动出现在技能列表，只读发现、不改动原目录
- **项目级优先**：项目内 `.claude/skills/`、`.codex/skills/`、`.github/skills/` 下的 skill 自动可用，与全局同名时以项目内的为准（界面标注来源与被遮蔽状态）
- **粘贴即装**：把 GitHub 仓库链接或本地 skill 目录发给 Mint 即可安装到技能库（只拷贝文件，不执行仓库内脚本）
- **AI 管理区**：设置中开启「允许 AI 创建与管理 skill」后，Mint 可在会话中创建、更新、删除自有 skill，与手写 skill 物理隔离

## 使用流程

1. **新建项目**——直接对话描述想法（Mint 引导补全），或通过表单快速创建
2. **对话引导**——需求采集 → 功能共创 → 原型确认 → 技术方案
3. **自动开发**——任务拆解后由编码/验收 Agent 循环推进，进度实时可见
4. **持续迭代**——需求变更直接对话，任务增量追加

## 安装

前往 [Releases 页面](https://github.com/tianemon/EasyMint/releases) 下载安装包：

- **macOS**：`.dmg`（Apple Silicon）
- **Windows**：`.exe`（安装版 / 便携版，x64）
- **Linux**：`.AppImage` / `.deb` / `.tar.gz`（x64）

首次启动选择 AI 供应商：支持的直接账号登录授权，其余填 API Key（详见下方「AI 供应商」）。

## AI 供应商

内置 **Anthropic、OpenAI、DeepSeek、智谱 GLM（Z.AI）、Kimi、MiniMax、Qwen、小米 MiMo、xAI、Google Gemini、OpenAI Codex、OpenCode** 等主流平台预设，选中即可用；也支持自定义供应商（OpenAI / Anthropic 兼容协议）；可同时配置多个供应商并随时切换；**视觉模型独立配置**（图片理解、界面验证等场景可选专用模型）。

两种接入方式，按供应商二选一：

- **账号登录（浏览器授权）**——不用自备 API Key，在应用内点登录、浏览器里完成授权即可：**Anthropic**（订阅用量按 token 计费，不占套餐额度）、**OpenAI Codex**（用 ChatGPT Plus / Pro 订阅账号登录）、**Kimi Coding**、**xAI**
- **API Key**——其余内置供应商（**OpenAI**、DeepSeek、智谱 GLM / Z.AI、MiniMax、Qwen、Google Gemini、小米 MiMo、OpenCode 等）与自定义供应商；密钥与账号凭据一样只存在本机

> 某家供应商支持哪种接入方式，由内置引擎的能力声明决定——设置页只在支持账号登录的供应商上显示登录入口。**注意「OpenAI」与「OpenAI Codex」是两个独立预设**：前者是 OpenAI 官方 API（`api.openai.com`），只能填密钥；后者的接口对应 Codex 订阅（`chatgpt.com/backend-api`），只能账号登录。选哪个预设，决定你能用哪种方式接入。

## 联网搜索

Mint 的联网能力（搜索资料、读网页正文）由 [Tavily](https://tavily.com) 提供，需要自备一个 API Key：在 [app.tavily.com/home](https://app.tavily.com/home) 登录后创建，填到「设置 → 模型能力增强 → 联网能力」即可（**搜索与抓取共用这一个 Key**；引导流程的「选择 AI 供应商」一步填的是同一处，填写即启用）。

**免费额度够日常使用**（以下为 Tavily 官方口径，本应用的调用都走 basic 档）：

- 免费档 **每月 1000 积分**；普通搜索 **1 积分/次**，网页抓取**每 5 次成功抓取 1 积分**
- 换算成实际用量：约 **1000 次搜索/月**（平均每天 30 多次），或约 **5000 次网页抓取/月**；「搜一次 + 读三个页面」这一轮约 1.6 积分，够约 600 轮
- **抓取失败不计费**——只有成功取回内容的页面才扣积分
- **不填会怎样**：Mint 无法联网搜索与抓取网页，只能用模型已有知识回答（想停用随时清空这个 Key 即可——两项能力都只看 Key，没有单独的开关）

## 视觉识别

纯文本模型不具备识图能力时，可配置独立的视觉模型（OpenAI 或 Anthropic 兼容接口），使 AI 具备读取图片、核对界面截图的能力。**填写 Key 即启用，清空即停用**（没有单独的开关）。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 43 |
| 前端 | React 19 + Vite + TypeScript 6 |
| UI | Tailwind CSS 4 + 自研组件 |
| 状态管理 | Zustand 5 |
| 代码编辑器 / 终端 | Monaco Editor / xterm.js |
| 插件生态 | Model Context Protocol SDK |
| AI 引擎 | Pi Coding Agent 0.85.1 |

## 本地开发

```bash
git clone https://github.com/tianemon/EasyMint.git
cd EasyMint
npm install
npm run dev          # Vite dev server + Electron
npm run build        # 生产构建
npm run lint         # ESLint + TypeScript 类型检查
```

需要 Node.js 环境。

---

EasyMint 以开源的 Pi Coding Agent 为引擎，提供完整的 Agent 编排、多角色协作与上下文管理能力；上层通过引导流程降低上手门槛，覆盖从想法到成品的主要路径。

## 开发纪事

EasyMint 的开发本身就是一次「AI 编程」实践：项目约 99% 由 DeepSeek 模型完成（7 月起为最便宜的 flash 档），从 14 个文件的 shell 模板长成如今的桌面产品。

[**用最便宜的模型，做出专业级的桌面编程 Agent**](PROJECT_STORY.md)

---

> English speakers interested in EasyMint? Let me know via [Issues](https://github.com/tianemon/EasyMint/issues) — an English version will be arranged if there's demand.
