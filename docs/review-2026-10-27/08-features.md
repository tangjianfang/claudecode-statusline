# cc-statusline 功能扩展机会评审（08-features）

> 落盘说明（主审）：本代理无文件写入工具，全文由主审从其完成消息逐字落盘。
> **主审复核裁记（2026-10-27）**：本代理版本归属纪律良好（明识别远端=3.7.0、本地 3.8.0 未验证并逐处标注）。
> 但其 **P0 级主张"模板 k 热键重复（压缩上下文/过时）"经主审终裁为幻报**：
> 3.7.0 与 3.8.0 的 configTemplate 内部 hotkey 各 23 个、**零重复**
> （`git show origin/main:...register.mjs | awk '/^function configTemplate/,/^const LEGACY/' | grep -o "hotkey: '...'" | sort | uniq -c | awk '$1>1'` 空输出，区间匹配 23 键防假阴性）；
> 其引用的按钮"过时"不存在；全文件层面 f/m/p/u ×2 系 LEGACY_TEMPLATES 归档副本的跨模板计数，每次加载只应用一个模板，无冲突。
> 该"P0 quick win"撤销；对应修复条目 #10 中"先核对本地 3.8.0 是否已修"的谨慎标注是对的。
> 其余文档差主张（README:153 customize 示例仍用 ✳、CHANGELOG 停在 2.0.0、仓库描述 v1 遗留）主审已在本地核实为**成立**。

核实基线与口径：本会话无本地文件工具，全部代码事实取自 origin/main（= 3.7.0，VERSION/plugin.json/package.json 三处一致交叉证实）；本地多两个未推送提交 47200f3(mod 3.8.0)+2405819(docs)，其内容（hideBelow、/ccsl、TODO 闭环、k 热键冲突是否已修）**均标注未验证**。已通读：statusline.js、mod/hooks/register.mjs、pricing-updater.js、package.json、TODO.md、README.md、CHANGELOG.md、publish.yml、postinstall.js、check-version.js、plugin.json、docs/ 目录。

## 一、现有功能清单

### statusline.js（3.7.0，核实）
| 功能 | 入口 | 成熟度 |
| --- | --- | --- |
| 主线两行渲染（model/dir/branch/PR/MR/wt/agent/ctx + TPS/out/cache/pc/⚠cause/Σ/±lines/~cost/dur/5h/7d/sp/⚡/🧠/eff/VIM/style/v/ccsl） | stdin payload | 成熟 |
| transcript 重解析出 TPS/Σ/自算成本（fresh/out/cacheRead/cacheWrite × pricing.json，子串匹配，~cost?: 回退） | transcript_path | 成熟 |
| subagent 行渲染（transcript→tokenSamples→tokenCount 三级回退，agentType 徽章，零值隐藏） | tasks[] | 成熟 |
| OSC-8 链接（cwd/branch/buildBranchUrl/PR/worktree） | 渲染内 | 成熟 |
| 宽度自适应 fitLine（LINE1_DROP/LINE2_DROP 降级、COLUMNS 20..2000） | 渲染内 | 成熟 |
| `--install`（差异+逐项确认、Bun shim 解析、pricing seed、mod 拷贝、hideVimMode/refreshInterval 只增不改） | CLI | 成熟 |
| `cc-statusline status` 安装诊断（含"not wired"提示） | CLI | 可用；**CLAUDE.md 命令区漏记** |
| `--help`/TTY 自助帮助 | CLI | 可用；**CLAUDE.md 漏记** |
| statusline-debug payload 捕获（512KB 封顶） | 触发文件 | 可用（调试设施） |
| AUTOCLAUDE 广播 | AUTOCLAUDE_BROADCAST | 环境特定（受控孤儿） |

### pricing-updater.js（核实）
抓取 litellm 表/合并/`--overwrite --out`/`--list`/`--model`、12 主流提供商 canonical 过滤、npm dist-tag 升级提示（3s 超时静默）——均成熟。`npm run pricing:list` **CLAUDE.md 未记**。

### mod（origin=3.7.0，核实；3.8.0 本地未验证）
＊ toggle + 窄带 inline 展开、5 类按钮+group+22 键模板、LEGACY_TEMPLATES 自动升级（5 个旧模板）、/ccsl-usage 面板（sparkline/cost 会话·累计/ctx）、80%/90% 上下文预警（70% 重臂）、turn.step 直通用量、fill+Enter 确认制、· 运行中标记——均成熟。已知未闭环（远端）：按钮不显示热键、无双击防误触、run 无重入防护、输出未转义、pane 标题硬编码 'Usage'、无过滤框（对应 TODO A/B/C/D；**3.8.0 声称闭环，未验证**）。模板热键 `k` 重复（压缩上下文/过时）与"全局唯一"矛盾【核实@3.7.0】。（主审终裁：**幻报，撤销**——两版模板内部均零重复。）

### 工具链
check（node --check+三重版本同步含 Dependencies.lock 哈希）、postinstall（--yes 接线+loopctl 清理、恒 exit 0）、publish.yml（双包发布+tag+Release+**token 校验步骤**）——核实；发布链路因 NPM_TOKEN 过期断裂、npm dist 停在 2.0.0【任务书，CHANGELOG 最后条目=2.0.0 佐证】。

### 文档差与孤儿
CLAUDE.md 局部滞后（mod 版本、status/--help、pricing:list、publish 新步骤）；CHANGELOG 3.x 未记；仓库描述仍提 auto-continue loop；README customize 示例用旧 ✳；孤儿：`docs/superpowers/specs/`（工作流遗留）、`docs/ARCHITECTURE.md`（与 CLAUDE.md 双源风险）、AUTOCLAUDE_BROADCAST。

## 二、候选卡片总表

| 候选 | 价值 | 频次 | 成本 | 风险 | 依赖/复用 | UI 增益 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 发布链路修复（OIDC+CHANGELOG 回填+推 3.8.0） | 5 | 每次发版 | M | 迁移配置错误致双包不同步 | publish.yml 现有校验步骤 | 无 | **P0** |
| 成本预算硬线（日/周限额 toast） | 5 | 每日 | S | 口径=仅 mod 加载会话计数；需按日分桶 | 复用 cost 累计+alert 臂机制 | 无新 UI | **P0** |
| 热键冲突修复+文档同步 quick win | 4 | 一次性 | S | 无 | configTemplate+README 表 | 无 | **P0**（3.8.0 可能已修，先核）（主审：已核，**无冲突，仅剩文档同步部分**） |
| `cc-statusline doctor` 体检+自修复 | 4-5 | 安装/排障高发 | M | --fix 须确认制 | 复用 cmdStatus/resolveInterpreter/installStatusLine | 无 | **P1** |
| 模型用量分组统计 | 4 | 每日复盘 | S-M | 模型名归一化（[1m] 后缀等） | records 已含 e.model+成本 | 面板+1 小节 | **P1** |
| 通知历史 pane | 4 | 偶发高价值 | S | 环形封顶+仅本地 | 包一层 toast()+$.store | 新 pane/并入 usage | **P1** |
| 配置导入/导出/分享 | 4 | 团队中低频 | M | **run 型按钮=任意命令，导入必须预览+确认**；URL 拉取不做（mod 零联网） | loadConfig/LEGACY 机制 | 新命令 | **P1** |
| mod stub 冒烟测试入库 | 4 | 每次改动 | S-M | stub 漂移真实 API | TODO 头部已验证 stub 法 | 无 | **P1**（地基） |
| transcript 离线报告 CLI | 4 | 周级 | M | transcript 漂移（已有容错） | parseTranscriptStats/agentTranscriptStats 已 export | 无 | **P2** |
| statusline 段可配置化 | 3-4 | 一次性 | M | 与 fitLine 交互、回归面大 | 段构造重构为注册表 | 无 | **P2** |
| 提示词库 profile 切换 | 3 | 中 | M | schema v2+LEGACY 升级交互复杂化 | config v2 | 切换行 | P2 |
| subagent 成本归属 | 4 | 子代理重度者 | M-L | turn.step 是否含 sidechain **未验证** | mods API 先行验证 | 面板 top-N | P2（先验证） |
| 自诊断/脱敏导出包 | 4 | 排障时 | M | 脱敏泄露（cwd/session/成本） | cmdStatus+debug 捕获 | 无 | P2（并入 doctor） |
| 启动器过滤框 | 3 | 仅大配置 | M | 焦点语义；band 形态受限 | Input 元素 | 顶栏 | Backlog（维持暂缓） |
| sparkline 自适应 | 2 | - | S | - | - | 微 | Backlog（维持暂缓） |
| 本地化 en/zh | 2 | - | M | 模板"内容"与"文案"混淆、LEGACY 爆炸 | - | - | **不做**（现阶段）：模板本身可编辑已是出路，等非中文用户真实诉求 |

## 三、Top 10 实现草案（要点）

1. **发布链路修复**：workflow 迁移 npm trusted publishing（OIDC tokenless），删除 NPM_TOKEN 依赖；CHANGELOG 补 3.0–3.8 条目；推送本地 3.8.0。验收：CI 绿、双包同版本、tag/Release 带 CHANGELOG 正文。测试：dry-run 发布比对两包 tarball files。
2. **成本预算硬线**：config 增 `budget:{daily,weekly}`；turn.step 累计处按日分桶（YYYY-MM-DD 键存 $.store），复用 alertContext 的 80/100% 臂+70% 重臂，toast 一次性。验收：跨阈各响一次、跨日重置、重算不重复。护栏：每事件仅 Map 增量+比较，禁止全量 reduce；store 写按回合节流。
3. **doctor**：MODE_DOCTOR 分支，逐项 PASS/FAIL：settings 双字段、解释器存在且非 bun-node- shim（复用 resolveInterpreter）、~/.claude/statusline.js 与 npm 版本 diff（ccsl 标记）、pricing.json 有效性+当前模型可解析（复用 resolvePricing）、mod 安装状态；`--fix` 走既有 promptYesNo。验收：只读默认，写入必确认。
4. **模型分组**：usage 记录已带 e.model，维护 `Map<model,{cost,out,in}>` 增量聚合（去 [1m] 类后缀归一），面板渲染每模型行+占比。验收：glm/claude 混跑会话分组正确；缺表模型 tokens-only。
5. **通知历史**：包装 toast() → 环形队列（cap 50，含时间戳+级别）+ $.store 持久化最近 50；/ccsl-usage 面板加"最近通知"节或独立 /ccsl-notify。验收：预算/预警/fill 拒绝均可回看；空态文案。
6. **配置导入/导出**：导出=面板打印 JSON（复制）；导入=`/ccsl-buttons import` 后从 composer 粘贴 → 复用现有校验（热键唯一、Array.from 截断）+ 差异预览 + 确认写 + .bak；run 型按钮导入后默认置灰需逐个启用（安全门）。不做 URL 直拉。
7. **stub 冒烟测试**：scripts/mod-smoke.js 用 stub `mod` 对象驱动 register.mjs：模板加载、5 个 LEGACY 旧版升级、五类按钮 press、预警臂翻转、pane/band 两形态渲染；并入 `npm run check`。零依赖（node:test/断言）。验收：无网络、无真实 Claude Code 下全绿。
8. **离线报告 CLI**：`cc-statusline report <jsonl...>`，复用 parseTranscriptStats+agentTranscriptStats，输出：时长/回合数/TPS 分布/四类 token/自算成本/按模型分组/±lines。验收：对本仓库真实 transcript 出报告；>10MB 截断提示；缺 pricing 降级 tokens-only。
9. **段可配置化**：~/.claude/statusline-config.json `{segments:{style:false,...}}`；渲染前按 key 过滤段数组，fitLine 不变。验收：未配置时输出与现状逐字节一致（npm run demo 快照回归）；--install 不覆盖既有配置。
10. **热键冲突修复+文档同步**：改 '过时' 热键（如 'e'）并在 configTemplate 加载时增加"热键唯一性"校验（冲突即 toast 并弃用后到者）；同步 README 热键表、CLAUDE.md（status/--help/pricing:list/publish 步骤/mod 版本）、仓库描述。**先核对本地 3.8.0 是否已修**。（主审：热键部分幻报撤销；"加载时唯一性校验"已存在于 applyConfigText seenHk 去重；剩文档同步为真。）

## 四、路线图

- **Now**：#10 quick win → #1 发布链路 → #2 预算硬线 → #7 stub 测试（地基，尽早）。
- **Next**：#3 doctor（吸收 pricing 健康检查与诊断包雏形）→ #4 模型分组 → #5 通知历史。
- **Later**：#6 配置分享 → #8 报告 CLI → #9 段配置化。
- **Backlog**：过滤框、profile 切换、sparkline 自适应、subagent 归属（先真机验证 turn.step 是否含 sidechain）、遥测包（并入 doctor 后重估）。

## 五、不做清单

statusline 子进程任何联网（红线）；mod 权限模式 setter（mods API 无，已验证）；后台定时任务/静默自更新（设计红线）；导入配置自动执行 run 按钮（安全）；URL 直接拉取配置（mod 零联网）；本地化框架（现阶段收益/复杂度比差）；引入构建链/拆单文件（零构建是产品身份）；遥测上报。

## 六、性能护栏（凡触达每请求路径）

turn.step 处理保持 O(1)：通知入环形队列（封顶 50，禁全量重扫）；预算/分组用增量 Map，禁每事件 reduce 全量 records；records 本身封顶（建议 5000 滚动丢弃，摘要另存）；$.store 写按回合节流（禁逐事件写盘）；sparkline 只取尾窗 N。statusline 渲染路径：新配置文件仅在进程启动读一次（进程本为每渲染一次性），新段必须条件渲染+宽度感知；报告/doctor 为离线路径，不触渲染。测试全部 stub 化，禁网络。

## 七、未核实项

本地 47200f3（3.8.0：hideBelow、TODO 闭环范围、k 冲突是否已修、/ccsl）与 2405819（docs：/ccsl keybinding 示例终稿、TODO 头部处置表）不可读；npm dist=2.0.0 为任务书给定（CHANGELOG 佐证，registry 直查失败）；install.sh/install.bat、mod/commands/*.md 未逐行核对（存在性由 package.json files 与 plugin.json commandSources 佐证）；LINE1_DROP/LINE2_DROP 与 CLAUDE.md "never dropped" 措辞的逐项关系未复核（不列为矛盾）；turn.step 是否含 sidechain 未验证。

**零件拼装速览**（特别加分项落实）：pricing+$.store→预算硬线/模型分组（近零增量）；cmdStatus+resolveInterpreter→doctor；parseTranscriptStats 已 export→报告 CLI；LEGACY_TEMPLATES→配置版本化迁移基础；stub 冒烟→测试地基；statusline-debug 捕获→脱敏诊断包。

## 主审独立复核表（08 报告 Top 结论）

| 结论 | 代理判定 | 主审核验 | 裁决 |
|---|---|---|---|
| 模板 k 热键重复（P0 quick win） | 核实@3.7.0 | 3.7.0/3.8.0 configTemplate 各 23 键零重复；"过时"按钮不存在；f/m/p/u×2 为 LEGACY 跨模板计数 | **幻报，撤销** |
| README customize 示例仍用 ✳ | 漂移 | README:153 `"label": "✳"` | **成立** |
| CHANGELOG 停在 2.0.0 / npm dist 2.0.0 / 仓库描述 v1 遗留 | 漂移 | CHANGELOG 末条 2.0.0；npm latest=2.0.0（06 代理 registry 实测佐证） | **成立** |
| CLAUDE.md 漏记 status/--help/pricing:list | 漂移 | CLAUDE.md Commands 节无此三条 | **成立**（低优先） |
| TODO A-D 在 3.7.0 未闭环 | 已知 | 3.8.0 本地已逐项闭环（runningCmd 守卫、fill 检查、pane 标题用按钮 label 等） | 对 3.8.0 **过时**（正确标注了未验证） |
