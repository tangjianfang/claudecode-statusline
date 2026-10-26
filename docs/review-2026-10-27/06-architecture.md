# cc-statusline 软件工程与可扩展性评审报告（06-architecture）

> 落盘说明（主审）：本代理无文件写入工具，全文由主审从其完成消息逐字落盘。
> **主审复核裁记（2026-10-27）**：本代理版本归属纪律良好（基线明示远端 0fa7ec3=3.7.0，3.8.0 增量标"未验证"）。
> Top 结论抽检：①pricing-updater.js:51 同键 `??`——主审 grep **成立**（`cacheRead: perM(e.cache_read_input_token_cost ?? e.cache_read_input_token_cost ?? 0)`）；
> ②"面板标题/inline 提示仍用 ✳"——本地 3.8.0 仍在（register.mjs:1345/1606/1711/1759，另 :397/537/688 属 LEGACY 字节冻结资产**不可改**）；
> ③CLAUDE.md 头部 v3.8.0 vs 概览条 v3.5.0 自相矛盾——**成立**；
> ④"usage-history 只读不写"——与 03/02/04 三路交叉一致，主审 grep 终裁 **Confirmed**（3.7.0 debc0ec 引入，仅 :1190/:1736 两处 get）；
> ⑤npm latest=2.0.0 registry 实测、1.1.0 未遂发布——**成立**（06 是唯一真查 registry 的代理）。
> 其"22 buttons"差评基于 3.7.0 实数 21；本地 3.8.0 = 22 按钮 + toggle，CLAUDE.md 对 3.8.0 **不漂移**。

**评审基线**:本地 HEAD `2405819`(main,含 2 个未推送 commit)→ 评审实际读取的是 **远端 main HEAD `0fa7ec3659b8222`(=3.7.0+TODO+merge)**,与本地差异 = 未推送的 `47200f3`(feat 3.8.0)与 `2405819`(docs)。除特别标注外,所有代码结论基于 `0fa7ec3`,涉及 3.8.0 增量的部分标注「未验证」。
**证据来源**:GitHub raw/contents API(钉 commit)、npm registry、逐字读取的文件清单见附录;每项量化均给出处。行号/行距为静态粗估(无本地工具跑 wc)。

## 一、度量表

### 1.1 文件规模(远端 0fa7ec3,GitHub trees API 实测字节)

| 文件 | 字节 | 备注 |
|---|---|---|
| mod/hooks/register.mjs | 55,731 | 本地 1795 行(任务给定);远端估算 ~1650-1750 行 |
| statusline.js | 51,948 | 本地 1213 行(任务给定) |
| pricing-updater.js | 14,700 | ~355 行 ✓ |
| pricing.json | 30,754 | 数据资产 |
| README.md | ~13,400 | |
| TODO.md | ~21,900 | v3.2.0 外部评审,基线 499 行 |
| .github/workflows/publish.yml | 5,091 | |
| scripts/postinstall.js | 4,083 | |
| CHANGELOG.md | 9,172 | |
| scripts/check-version.js | 1,171 | |
| mod/.claude-plugin/plugin.json | ~460 | version 3.7.0 |
| mod/hooks/hooks.json | 36 | `{"modules":["./register.mjs"]}` |
| .github/workflows/check.yml | 278 | |

### 1.2 register.mjs 结构(全文逐字读取)

**模块级可变状态实测 = 10 个 `let`**(全部亲读):`history`、`pricing`、`costAll`、`ctxWindow`、`warnedCtx`、`buttons`、`toggle`、`paneUp`、`inlineUp`、`lastRun`。
→ **「14 个」假设修正**:多出的 `hideBelow`、`configNote`、`runningCmd`、`bandOn` 应为未推送 3.8.0(`47200f3`,commit msg 即含 hideBelow)新增,未能读到代码。即便 14 个,聚合度仍可控:usage 域 4 个(history/pricing/costAll/ctxWindow)、launcher 域 4 个(buttons/toggle/paneUp/inlineUp)、杂项 2 个(warnedCtx/lastRun)。**判定:接近 God-state 阈值但尚未失控;建议按域分组而非现在加第 15 个。**

**函数长度 Top(行距粗估,含区间归属)**:

| # | 单元 | 估行数 | 圈复杂度粗估 |
|---|---|---|---|
| 1 | 模板区(configTemplate ~100 + LEGACY_TEMPLATES 5×~75) | ~480 | 1-2 |
| 2 | ui.render AbovePrompt(band+inline+第 2 份 pressButton ~60) | ~150 | ~14 |
| 3 | ui.render Pane BUTTONS_PANE(卡片+第 1 份 pressButton ~60) | ~140 | ~12 |
| 4 | ui.render Pane 用量面板 | ~85 | ~11 |
| 5 | session.start | ~60 | ~11 |
| 6 | turn.step | ~55 | ~10 |
| 7 | normalizeButton | ~45 | ~14 |
| 8 | defaultButtons | ~45 | 1 |
| 9 | sectionModel | ~40 | ~11 |
| 10 | applyConfigText | ~30 | ~6 |
| 11 | pressButton(×2,闭包) | 60×2 | ~16 各 |

复杂度粗估口径:if/for/while/&&/||/?: 计 1,静态数出,误差 ±2。
**边界判定:纯函数(约 22 个:safe/usageFrom/totals/resolvePricing/computeCost/fmt/spark/clip/defaultButtons/defaultToggle/configTemplate/templateUpgrade/normalizeButton/normalizeToggle/applyConfigText/sectionKey/sectionModel/pairRows/displayUrl/displayRun/browserArgv/launcherRows)与 hook 内闭包的边界总体清晰**——纯函数不触 `$`,hook 内只剩「取 `$`→调纯函数→画元素」;唯一越界是 pressButton 闭包把「派发决策」和「`$` 调用」焊在一起,导致无法复用(见二)。

**statusline.js 函数长度分布(全文已读,行距粗估)**:~50 个函数,<20 行约 6 成,20-50 行约 3 成,>50 行集中在 5-8 个(render 两行的段拼装、transcript 解析循环、agentTranscriptStats、installStatusLine、TPS 配对),最长 ~110-130 行(安装流程:三段独立确认+settings diff+pricing 播种)。段级扩展点(fitLine/LINE1_DROP/LINE2_DROP)是全仓最好的开闭结构。

## 二、重复代码

1. **两份 dispatch(实测)**:Pane 与 AbovePrompt inline 各有一份 `pressButton` 闭包,除 1 行注释(`pane button` vs `inline (narrow terminals)...`)外**逐字相同**,各 ~60 行,合计 ~120 行,重复度 ≈98%。根因是 mods `$` 纪律(`$` 名词不能传出 hook,工厂函数即违规)——**该重复是平台约束下的正当解,不建议强行消除**;建议改为「孪生段」治理:两份头部互相锚定注释 + 在冒烟脚本里做双向 diff 断言,防止日后各自漂移。
2. **LEGACY_TEMPLATES 维护成本模型(实测 5 个,共 ~15KB)**:每次改 configTemplate 的完整步骤 = ①改模板 ~②把**改前模板逐字节**追加进 LEGACY(~75 行/3KB)③三处版本号④CHANGELOG⑤README 模板描述⑥CLAUDE.md 描述⑦(本地)TODO 处置表——**7 个触点、~90 行新增/次**,且②要求字节级精确(手工复制易错,打错一个空格 = 旧文件永不升级)。这是「不出库测试设施」下换来的用户态升级能力,值得保留但应脚本化(见 R3)。
3. **文档同步点清单**:同一事实「默认按钮模板」同步在 configTemplate(代码)、README(What's on it 表)、CLAUDE.md(模板描述)、TODO(B/C 节)四处;「版本号」同步 package.json / statusline.js VERSION / mod plugin.json 三处(check-version.js 校验);「发布流程」同步 CLAUDE.md、README、publish.yml 注释三处。

## 三、可测试性

- 纯函数占逻辑区(扣除 ~500 行模板字符串与 hook 壳)约 **60%+**,且全部无 `$` 依赖 → **可直接 `export`**(如 `export const _test = {...}`)而**不违反 `$` 纪律**(纪律只禁传 `$` 名词,不禁导出纯函数)。mods loader 以 default export 为契约,附加命名导出大概率惰性(待真机验证,TODO D1 亦持此观点)。
- TODO D1 已记录官方路径:`claude plugin test`(参照 `pane.test.tsx`)+ 至少覆盖 `normalizeButton/applyConfigText/fmt/sectionOrder`。**结论:现有 %TEMP% stub 冒烟脚本可以且应该迁移为 `claude plugin test`(或 `claude plugin eval`)套件**——它恰好就是 stub 驱动的;迁移后回归「同步派发根因」这类历史 bug(3.3.0 spec 的验证清单里点名过)才有自动化兜底。此为静态推断,未实机跑过。
- 现状短板:`npm run check` 只 `node --check` 3 个 .js + check-version,**register.mjs 无任何语法/行为检查入 CI**,check.yml 也未跑 `claude plugin validate mod`(validate 目前是 TODO F 里的手工步骤)。

## 四、扩展性走查表(逐个追踪,改动点+估行+灯)

| 场景 | 改动点清单(实测定位) | 估行 | 灯 |
|---|---|---|---|
| (a) 新动作类型 `confirm:true` | normalizeButton 校验+透传(~10);**pressButton ×2**(待确认态+重按窗口+超时复位,~15×2);README/CLAUDE.md;新增 1 个模块 let(第 11/15 个) | 40-60 | 🟡 双写派发 |
| (b) 新渲染 surface(desktop props) | 新 ui.render 分支或 matcher;若新 surface 有独立 `$` 作用域 → **第 3 份 pressButton**;launcherRows/宽度逻辑再适配一遍 | 80-150 | 🔴 派发三写+宽度魔数分散 |
| (c) 模板再演进一次 | 见二.2 的 7 触点模型 | ~90 新增 | 🟡 机械但字节级易错 |
| (d) 新命令 /ccsl-xxx | session.start 内 command.register(~3);'command.run' handler(~5-15);两处文档 | 10-20 | 🟢 |
| (e) 新配置字段(如 hideBelow) | applyConfigText 解析+默认(~5);消费点(~5-10);README+CLAUDE.md;模板不变则**无需** LEGACY 追加(3.8.0 的 hideBelow 即此形态,佐证模型) | 15-25 | 🟢 |
| (f) usage 并入启动器(TODO B6) | sectionModel 加 usage 分区(totals/pricing 是模块状态,**无 `$` 障碍**);launcherRows 行数模型扩一档;inline 窄视图同步加卡(**又一处复制点**);用量面板保留为详情页 | 80-150 | 🟡 |
| (g) statusline.js 新状态栏段 | 计算段(~10-30);push 进 line1/2 段数组;**必须**同时登记 LINE1_DROP/LINE2_DROP 丢弃序(或显式永不丢弃);README 段表+CLAUDE.md | 20-40 | 🟢 全仓最佳扩展点 |

## 五、横切一致性

- **safe() 吞异常反噬「每路径 toast」纪律**(亲读定位):①`session.start` 里 command.register 失败 → `/ccsl-usage`、`/ccsl-buttons` 整条静默消失,无 toast;②配置文件读取/解析失败 → 静默落默认模板,仅 `/ccsl-buttons` 手动触发时才报 "could not load"(TODO A3 的"静默丢弃"在 3.7.0 仍只算半修:重载路径有报错,启动路径没有);③turn.step 的 `store.set('usage-cost-total')` 失败 → 累计成本丢一轮,无提示;④ui.render 内 `ui.resolve` 失败 → band/面板空白。**建议:safe() 增加可选 toast-on-error 参数,只在启动/持久化路径启用**(渲染路径保持静默以免每帧刷 toast)。
- **toast 中英混杂清单**(实测):中文:`ccsl: 未修改的旧按钮模板已自动升级`、`上下文已用 N%…`、`已填入 — Enter 执行`、`无法填入(…)`、`面板暂不摆放 (reason) — 已在带内展开`、`再按一次 ✳ 收起`(提示行)、`· 运行中`、`编辑 ~/.claude/… · /ccsl-buttons 重载 · Esc 关闭`、面板标题 `✳ 启动器`;英文:`opening ${url}`、`${label}: running…`、`${label}: exit N`、`${label}: opened`、`ccsl: ${err.message}`、`cc-statusline: opening the usage pane...`、`loaded N button(s)`、`Esc closes · /ccsl-usage reopens`。**约 8 中 : 8 英,同一界面内混排**(TODO B7 已立项未做)。
- **魔数集中度**:register.mjs 命名常量只有 `MAX_POINTS=240`、`PANE`、`BUTTONS_PANE`;其余散落:600000(超时)、48/20/42/36/24/6(四处裁剪宽)、34/6(launcherRows 边界)、60/160(spark 切片)、200000(ctx 默认)、0.8/0.9/0.7(告警阈值)、99(ctx 封顶)。**建议集中为 CONFIG 常量块,一处注释**。statusline.js 侧同类(512KB 日志帽、48h、2min TPS 陈旧、80/50 配色阈)有注释,密度可接受。

## 六、版本与发布工程

- **三处联动实测一致**:package.json=plugin.json=statusline.js `VERSION`='3.7.0';check-version.js 对 statusline.js 硬校验、对 plugin.json 存在才校验(mod 可整体 absent,合理)。
- **registry 实测(2026-10-27)**:`@tangjianfang/claudecode-statusline` dist-tags.latest=**2.0.0**(2026-09-30T15:29:56Z);全部版本 1.0.0/1.0.1/1.0.2(2026-07-22)、2.0.0。**任务提示"3.2.0 起发布全失败"获证:3.0.0-3.8.0 零发布**;GitHub tags 亦止于 v2.0.0(tag 由同一工作流推送,token 失败即整链不走)。
- **更早的静默失败**:[CHANGELOG 1.1.0 - 2026-08-29] 存在,但 npm 无 1.1.0、GitHub 无 v1.1.0 标签 → **令牌 2026-10-07 过期之前发布链就失败过一次且无人察觉**。根因是旧工作流在 publish 步才 403、且 needs_publish 逻辑对"已发布"误判时静默跳过;现 publish.yml 已有 `npm whoami` 快速失败 + `NPM_TOKEN_EXPIRES` 仓库变量 14 天预警(CLAUDE.md/README **均未记载此步**,漂移 #4)。
- **单点清单**:NPM_TOKEN 一证双包;到期靠手工变量;无发布后 npm 视角回读校验;2FA-bypass 令牌 2027-01 起直发将死(README 已记)。**改进**:迁 OIDC trusted publishing(README 已计划)+ CI 末尾加 `npm view` 回读断言 + 1.1.0 式"CHANGELOG 有而 registry 无"对账(一条 grep 即可)。

## 七、文档漂移清单(≥10,均亲读对照)

| # | 位置 | 漂移内容 |
|---|---|---|
| 1 | CLAUDE.md 自身 | 开头 "mod v3.7.0" vs 中段 "**mod/** (v3.5.0)" 自相矛盾（主审：本地版头部已是 v3.8.0，条目仍 v3.5.0，矛盾依旧成立） |
| 2 | CLAUDE.md vs code | "22 buttons":0fa7ec3 实数 **21** 个按钮(5+10+2+4)+1 个 toggle;README 表亦 21（主审：本地 3.8.0=22，对 3.8.0 不漂移） |
| 3 | code 内部 | toggle 已换 **＊**(defaultToggle),但面板标题 `'✳ 启动器'`、inline 提示 `再按一次 ✳ 收起`、README 示例 `"label": "✳"` 仍是 ✳——恰是 CLAUDE.md 自己宣布淘汰的漂移字形（主审：本地 3.8.0 仍在 :1345/:1606/:1711/:1759，成立） |
| 4 | CLAUDE.md/README vs publish.yml | 均未记载 NPM_TOKEN 校验步与 NPM_TOKEN_EXPIRES 预警变量 |
| 5 | CHANGELOG | 3.0.0→3.7.0(整个 mod 系列)零条目;[Unreleased] 还停在 2.x 时代的 status 提示项 |
| 6 | CHANGELOG vs registry/tags | [1.1.0]-2026-08-29 无对应 npm 版本与 git 标签(未遂发布) |
| 7 | CLAUDE.md vs code | "cumulative persisted via `$.store`":`usage-cost-total` 有写;但 **`usage-history` 只在 session.start 与面板自愈两处读、全文件无写**——重启即丢 sparkline,恢复路径是死代码(本地 2405819 提交主题恰为 usage-history,可能已修,未验证)（主审：未修，Confirmed，四代理交叉一致） |
| 8 | pricing-updater.js | `entryFromLitellm` 中 `e.cache_read_input_token_cost ?? e.cache_read_input_token_cost` **同键重复**(真 bug,无害但表明 fallback 意图未达成)（主审 grep：**成立**，pricing-updater.js:51） |
| 9 | README | Quick start 未提 `m` 仅在 band 聚焦时生效(TODO A5 已知限制,文档缺) |
| 10 | package.json | description 只提 "plus a pricing updater",未提随包发行的 mod(files 含 `mod/`) |
| 11 | npm registry | dist 显示 2.0.0,而 README/CLAUDE.md 讲的是 3.7/3.8 世界——npm 用户视角与仓库文档完全脱节 |
| 12 | TODO.md | 远端版本无处置表(表在未推送 commit),远程读者看到的全是"待办",与实际已修状态漂移 |
| 13 | spec 文档 | `2026-10-26-launcher-tabs-design.md` 描述的 tabs 结构一版后被卡片单视图取代,文档未加"已废弃/被 X 取代"头注(CLAUDE.md 仍列为必读) |

## 八、值得保留的实践

1. **零依赖/零构建原则**——三天 9 版的交付速度直接受益,勿加框架;
2. **LEGACY_TEMPLATES 出厂文件自动升级**——解决真实野问题(3.1.0 demo 文件压住新功能),方向正确,只需工具化字节复制;
3. **`$` 纪律内联**——平台约束下正确;重复是代价而非错误;
4. **真机反馈循环 + TODO 外部评审**——A2(isFilled/A2 漏洞)、A6 等在后续版本逐条兑现,闭环健康;
5. statusline.js 的 fitLine/丢弃序与"缺数据不渲染零"两条设计,是全仓工程质量最高的部分;
6. publish.yml 的 whoami 快速失败+到期预警,是事故后正确的工程响应。

## 九、演进路线图(ROI 排序,均可独立 commit)

| # | 项 | 动机 | 做法 | 规模 | 风险 | 收益 |
|---|---|---|---|---|---|---|
| R1 | 修复发布链 | npm 停在 2.0.0,9 版未发 | 旋转 NPM_TOKEN → push 触发验证 → 补发 3.8.0;随后迁 OIDC | S | 低 | 用户可升级;CHANGELOG/README 与现实重新对齐 |
| R2 | 文档债清偿 | 漂移 #1-#6、#13 | CHANGELOG 补 3.x 系列条目;CLAUDE.md 版本/按钮数/✳ 三处;spec 加废弃头注 | S | 无 | 评审/贡献者入口可信 |
| R3 | 纯函数导出+冒烟测试固化 | 现状 0 自动化 | `export const _test={...}`;把 %TEMP% stub 迁 `claude plugin test`;CI(check.yml)加 `claude plugin validate mod` + `node --check mod/hooks/register.mjs`;LEGACY 追加改为脚本生成 | M | loader 对附加导出的容忍度需真机验证 | 回归兜底;模板演进从 7 触点降 4 |
| R4 | 派发孪生段治理 | (a)/(b) 双写 | 两份 pressButton 头部互锚注释+测试双向 diff;safe() 加可选 toast;魔数集中 CONFIG 块 | S-M | 低 | 边际成本下降,防漂移 |
| R5 | usage 并入启动器(TODO B6) | 消 A4 切换之绕 | sectionModel 增分区+行数模型;inline 卡片复用 sectionModel;`/ccsl-usage` 留详情 | M | 中(行数估算/窄屏) | 面板二合一 |
| R6 | 状态域分组 | let 逼近 14+ | 按域改对象(history/cost 域、launcher 域),纯机械 | M | 低 | 为 3.9+ 新功能续命 |
| R7 | 确认流(confirm:true) | TODO A6 | 见四(a) | S | 中(交互态) | 误触保护 |
| L | surface 抽象(b) | 桌面端等 | 待 mods API 提供 matcher 后再议,现做必三写 | L | 高 | 暂缓 |

## 十、被推翻的假设 / 已验证无问题

**被推翻/修正**:①「模块级可变状态 14 个」→ 远端实数 **10**,另 4 个属未推送 3.8.0(未读到);②「TODO.md 含处置表」→ 远端无(表在未推送 commit);③「npm dist 显示 2.0.0 待核」→ **已核**:latest=2.0.0(2026-09-30);④「发布失败始于 3.2.0/令牌过期」→ **更早**:CHANGELOG 的 1.1.0(2026-08-29)从未上 npm/打标签。
**已验证无问题**:三处版本号一致;check-version 校验范围与文档相符;pricing-updater 裸跑=merge(2.0.0 修复在位)、--list 只读、离线 3s 超时静默;postinstall `--yes` 仅由脚本传入、失败非致命 exit 0、loopctl 清理只匹配自身命令;hooks.json 单模块;publish.yml 并发队列/双包/tag+release 与文档相符;register.mjs 内确无裸 `prompt.submit`(fill+isFilled 检查在位,README"every call feature-checked"在 3.7.0 已成立)。

## 十一、未验证 / 局限

1. **本地 2 个未推送 commit(47200f3 3.8.0、2405819)未读到**——hideBelow、configNote、runningCmd、bandOn、TODO 处置表、usage-history 写入点、/ccsl 键位文档均为任务提示+commit msg 佐证,代码未亲读。本地行数(1795/1213/355)取任务给定,未实测。
2. **statusline.js 逐函数精确行距**为粗估(全文已读但未跑工具计数);register.mjs 各函数行距同。
3. `--install` 是否复制 `mod/`→`skills/`(CLAUDE.md/README 声称)未在代码中定位到具体行,标注待复核。
4. 所有「测试/CI 可行性」结论为静态推断;`claude plugin test` 迁移未实机验证。
5. **环境限制(重要)**:本子代理会话无 Read/Write/Bash 工具,Windows 主机进程采集不可用,file:// 被浏览器工具 schema 拒绝,故报告无法写入 `C:\Users\tjf\AppData\Local\Temp\ccsl-review\06-architecture.md`,全文以本消息返回;仓库零改动。父代理可读的完整原文落盘件:`C:\Users\tjf\.claude\projects\C--tjf-github-CCStatusLine\69d3be65-46a0-48a1-9bca-00f9c04aa717\tool-results\call_a1d3a35e49464aa0921333c9.txt`(statusline.js 完整 DOM)及同目录 `mcp-rea-capture_browser_scenario-1793035060477.txt`(blob 页)。

## 分维度评分

结构 6/10 · 重复 5/10 · 可测试性 7/10(潜力)/4(现状) · 扩展性 7/10 · 横切一致性 6/10 · 发布工程 3/10 · 文档 4/10。总评：健康度 **B** / 可用但边际成本开始上升。

## 主审独立复核表（06 报告 Top 结论）

| 结论 | 代理判定 | 主审核验 | 裁决 |
|---|---|---|---|
| pricing-updater 同键 `??` | 真 bug | pricing-updater.js:51 原文确认 | **成立** |
| ✳ 残留 UI 字符串 | 漂移#3 | register.mjs:1345/1606/1711/1759（3.8.0 仍在）；:397/537/688 为 LEGACY 冻结资产 | **成立**（冻结资产除外） |
| usage-history 只读不写 | 漂移#7 | grep：仅 :1190/:1736 两 get | **Confirmed**（3.7.0 引入回归） |
| CLAUDE.md v3.8.0 vs v3.5.0 自相矛盾 | 漂移#1 | CLAUDE.md:7 vs :11 | **成立** |
| npm latest=2.0.0、tag 止 v2.0.0、1.1.0 未遂发布 | 发布工程 | registry/tags 实测（代理亲查）+ CHANGELOG 佐证 | **成立** |
| "22 buttons"漂移 | 漂移#2 | 3.7.0=21 真；3.8.0=22（本地模板 23 键含 toggle，零重复） | **仅对 3.7.0 成立**（对 3.8.0 不漂移） |
| 模块级 let=10（远端）/14（本地） | 修正假设 | 本地 1795 行版含 hideBelow/configNote/runningCmd/bandOn | 与 3.8.0 架构一致 |
