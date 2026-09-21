# Product Copilot

把自然语言需求变成可确认的范围、可追溯的变更和有证据的验收。

Product Copilot 是一个本地桌面 AI 产品工作台。它面向需要把想法落地的小型项目：用户先确认需求与原型，再让 Agent 开发；需求变化时，系统保留变更前后差异，并使过期批准和验收结果失效。

![Product Copilot 产品计划界面](assets/screenshots/product-copilot-plan.png)

## 核心体验

`Idea → 需求分析与资料记录 → PRD / 优先级 → 原型确认 → Agent 开发 → 验收证据 → 数据复盘`

交付后的需求通过变更提案继续推进：`提出变更 → 影响与保留项 → 确认范围 → 更新原型 → 开发 → 回归验收`。

- **产品计划**：结构化需求、验收条件、资料来源及待回答问题；资料不足时明确按假设继续。
- **需求变更**：保存前后差异、受影响文件和需保留的规则；需求、原型或产物变化后重新检查批准与证据是否有效。
- **开发控制**：Builder 通过已批准范围执行，运行状态与验收结论分开，支持取消及中断记录。
- **证据验收**：运行实际测试，并将用例关联到需求条件；未关联、环境失败、过期证据均不能直接变成通过。人工核验单独留痕。
- **本地复盘**：汇总交付记录与样例事件，区分合成数据和本地试用；缺失成本或人工耗时保持未知。

## 已验证的案例

活动报名应用 Gather 从“每人只能报名一场”改为“每人每场只能报名一次”，保留容量、关闭规则和旧报名。

| 验证 | 当前证据 |
|---|---|
| 改进版完整变更链 | 26 项 P0 条件关联检查通过，Gather 36 项测试通过 |
| 旧数据与业务回归 | 独立领域探针 7 项通过，另有真实页面操作记录 |
| 验收器校准 | 正确样本通过，4 类已知缺陷样本被识别 |
| 对照预实验 | 原版与改进版各一次独立页面评分，均为 11/11；尚不能证明改进版更优 |
| 工作台可靠性 | 已实测初始化取消、缺依赖未判定、批准失效；自动化覆盖写后取消、孤儿运行恢复和预算/供应商异常终态 |

这些是本地开发验证与预实验，不是线上用户增长、生产可靠性或统计显著的对照结论。

- [项目案例与产品决策](PROJECT_STORY.md)
- [产品规格与开发记录](docs/product/README.md)
- [对照评测运行册](evaluation/T7_对照评测运行册.md)
- [首轮预实验记录](evaluation/pilot-20260921/README.md)
- [异常路径记录](evaluation/reliability/20260921.md)

## 本地运行

准备 Node.js 与 npm，克隆仓库后启动：

```sh
git clone https://github.com/20cldeng-pixel/Product-Copilot.git
cd Product-Copilot
npm ci
npm run dev
```

在设置中配置供应商并完成登录或密钥配置，打开项目后点击“产品计划”。本项目验证使用了 OpenAI Codex 供应商；模型可用性以实际账户为准。界面部分基础模块仍保留 EasyMint 名称。

```sh
npm run lint
npm test
node --test evaluation/summarize-session.test.mjs
npm run build:renderer
npm run build:main
npm run build:preload
```

本地开发验证使用 Node.js 24；CI 配置使用 Node.js 22。[首次公开 CI 运行](https://github.com/20cldeng-pixel/Product-Copilot/actions/runs/35552859292)已通过主项目质量门禁与 Gather 示例检查。桌面安装包和代码签名不在上述检查范围内。

## 运行 Gather 示例

```sh
cd examples/gather
npm ci
npm test
npm run dev
```

示例使用固定模拟身份和浏览器本地存储；包含已验证的 V2 代码及本地事件导出。源码快照摘要见 `examples/gather/SOURCE.json`。

## 结构

| 路径 | 职责 |
|---|---|
| `app/main/services/product-*` | 产品状态、批准、开发、证据与复盘服务 |
| `app/shared/product-*` | 数据契约与共享逻辑 |
| `app/renderer/src/components/Product*.tsx` | 产品计划界面 |
| `evaluation/` | 校准、预实验及证据索引 |
| `docs/product/` | PRD、需求合同和开发记录 |

技术栈：Electron、React、TypeScript、Vite、Vitest，以及 Pi Agent 引擎。计划和会话保存在本机；调用模型或联网工具时，相关上下文会发送至所配置的供应商。不要将凭据、私人会话或真实用户事件提交到仓库。

## 当前边界

仍需补齐正式重复配对评测、未见案例，以及页面和操作系统进程级的写入取消/强制中断实验。现有自动化已验证写入后保留产物、孤儿运行转为 interrupted 并可显式重试，但不等同真实 SIGKILL 或全部 UI、生产环境正确。示例事件使用模拟身份，不支持真实业务转化率结论。

## License

基于 [EasyMint](https://github.com/tianemon/EasyMint) 开发，沿用 MIT 许可；原始版权声明见 [LICENSE](LICENSE)。
