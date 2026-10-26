# cc-statusline-mod v3.8.0 安全与稳健性审查（05-safety-gate-io）

> 落盘说明（主审）：本代理无文件写入工具，全文由主审从其完成消息逐字落盘。
> **主审复核裁记（2026-10-27）**：版本归属纪律良好（本地 HEAD 2405819 / origin=0fa7ec3=3.7.0 未推送，明示）。
> Top 结论主审逐条取证：**T-C2 成立**（statusline.js:343-350 解析失败置 `{}` → :413 `writeFileSync(settingsPath, JSON.stringify(settings))` 整文件重写，损坏文件确认后清成两键）；
> **T-C3 成立**（:917 主 transcript 全量读无上限 vs :665-671 子代理路径有 10MB 尾窗，同文件不一致）；
> **T-B1 成立**（3.7.0 线上 `cmd /c start` 注入面；本地 3.8.0 已改 rundll32——register.mjs:1159 亲读确认；HTTPS:// 大小写误拒 :1042 无 /i 亦成立）；
> **T-C4 降级为部分成立/低危**（两处 resolvePricing 均用 `Object.keys` 自有键遍历，`__proto__` 键不可达；残余仅 `table['constructor']` 继承键 truthy 短路，触发面=敌意 transcript 的 model 字段串，影响=显示 NaN，无 RCE）；
> T-B5（statusline 子代理行 UTF-16 slice）未逐行复核，维持 Likely。

**版本裁决（先行）**：本地 HEAD 2405819；origin/main=0fa7ec3（VERSION 3.7.0）。**3.8.0（47200f3）与 docs 提交均未推送**——npm/GitHub 生效面仍是 3.7.0。本地 register.mjs 67026 字节、register() 跨 1186–1795 行；用户 ~/.claude/ccsl-buttons.json 含 hideBelow/git-log 按钮，为 3.8 模板产物，证实本地≠GitHub。本地 3.8 的 browserArgv/hostArgv 逐行代码**未能直读**（>64KB 无法映射；REA 语义图 string-seed 通道经校准证实不含源码字面量，零命中无证明力），3.8 行为依据=TODO.md C1+模板产物旁证。（主审：已代为直读补证——rundll32 在 :1159，hostArgv cmd /c 包装在位。）

## 摘要（Top 风险）
1. **T-B1 [高置信，3.7.0 线上]** win32 URL 经 `cmd /c start "" <url>` 派发：URL 含 `&` 且无空格时 Node 不加引号，`&` 后内容被 cmd 当新命令（作者已在 TODO.md 自述 echo 实测）；`\n` 变体同理。超出 README「url 仅 http(s)」暗示的安全语义，属未声明的 shell 注入面（威胁模型内仍需配置写权限）。3.8.0 声称改 `rundll32 url.dll,FileProtocolHandler`（不经 shell），但 **TODO C1 最后一项「宿主实机验证」复选框仍未勾**，且 3.8 未推送。
2. **T-C2 [高置信]** statusline.js `--install`：settings.json 解析失败时 catch 置 `{}`，用户确认（或 postinstall `--yes` 无人值守）后整文件重写，**静默清空 hooks/快捷键等既有配置，无备份、非原子写**。
3. **T-C3 [高置信]** 主会话 transcript 全量 `readFileSync`+逐行 parse，**无 10MB 上限**（agentTranscriptStats 有 SIZE_CAP=10MB，主路径不一致）；长会话下每次渲染（refreshInterval 5s）重复全量读。
4. **T-B6 [信息级]** `run`/`url` 点击即执行（README 明示）；ccsl-buttons.json 是模型可用普通 Write 工具修改的文件，session.start 自动加载 → 恶意按钮跨会话常驻、一键执行，链路成立但属已声明边界，建议加固。

## B 部发现（register.mjs）
- **T-B1** cmd-start 注入（上述）。复现输入 `{"url":"https://x.com/?a=1&calc"}`（通过 `/^https?:\/\//` 白名单）。修复：推送 3.8 rundll32 路径并实机验证；白名单追加 `\r\n` 过滤与 `/i` 大小写（`HTTPS://` 现被拒，兼容 bug）。
- **T-B3** 3.7 模板 win32 下 `npm` 等派发 ENOENT（作者自测）；3.8 改 `cmd /c` 包装（兼容动机，非注入——argv 直传，无权限增量，配置写入者本可直接 `run:["cmd","/c",...]`）。
- **T-B5** `label.slice(0,24)`/`activity.slice(0,47)` 按 UTF-16 码元裁剪，emoji 可裂为 U+FFFD（美观性；mod 侧按钮标签已用码点裁剪，statusline 子代理行未对齐）。
- run 溢出：mod 侧仅保留输出首行 ≈120 字符（内存驻留有限）；`timeoutMs:600000` 无取消 UI、同键并发双跑（后完成者覆盖显示）；`$.process.run` 引擎侧缓冲策略未验证。
- slash 白名单 `^[a-z0-9-]+$`（去 `/` 后小写校验）——`fast&evil` 被拒；prompt 填充 composer、`isFilled:false` 有 toast——均验证无问题。

## C 部发现
- **T-C2/T-C3** 见摘要。
- **T-C4 [低]** `resolvePricing` 用 `table[model]`/`lower.includes(key)` 无 hasOwnProperty 守卫，`model="__proto__"/"constructor"` 可命中原型成员 → `~cost:$NaN`（仅显示层，无 RCE）。（主审降级：Object.keys 自有键遍历使 `__proto__` 不可达；仅 `table['constructor']` truthy 短路残余。）
- **T-C5 [低]** ccsl-buttons.json 存在但不可读（特殊 ACL）→ `current=null` → session.start 会尝试用模板**覆写**该文件（读失败≠写失败）；BOM/截断 JSON → toast「配置无效」、不重写、无数据丢失（验证无问题）；模板升级写失败 → 下次会话幂等重试并再 toast（良性）。
- **T-C7 [低]** pricing-updater `fetchJson` 跟随重定向无深度上限（`--source` 自定 URL 时可被环）；https.get 拒绝 http:// 回退故降级面有限。合并保留用户键、失败不动目标文件、3s 超时静默——验证无问题；拉取表仅做算术，无 eval/shell，供应链影响限于成本显示。
- 隐私：mod 无网络调用；命令 argv/url/输出仅本地（store 仅 model/tokens/cost）；statusline payload 日志需 opt-in 哨兵文件、512KB 封顶、含 cwd/transcript_path——均为本地文件，验证与文档一致。

## 对抗样本表（静态推演+作者自测，未实机复演——环境无执行通道）
| 输入 | 当前行为(3.7) | 应然 | 判定 |
|---|---|---|---|
| `https://x.com/?a=1&calc` | cmd 拆分执行 `calc` | 原样打开 | 注入(T-B1) |
| `https://a.com/?x=1%26calc` | 编码 & 无害打开 | 同 | 通过 |
| `HTTPS://github.com` | 白名单拒（无 /i） | 放行 | 误拒 |
| `javascript:`/`file:///C:/x` | 白名单拒 | 拒 | 通过 |
| `https://a/?x=1\ncalc` | 疑似 cmd 二次命令 | 拒 | 注入变体(中置信) |
| slash `fast&evil` | 拒+丢弃 | 拒 | 通过 |
| run `["npm","run","build"]`(win32) | ENOENT | 执行 | 3.8 修复 |

## 被推翻的假设 / 已验证无问题
- **「DISALLOWED_PROTOCOLS 黑名单与 README 不符」——推翻**：3.7 代码即 http(s) 允许清单，与 README 一致（先前 denylist 印象来自更旧的缓存副本）。
- **「LEGACY byte-match 可降级攻击」——推翻**：旧模板清单内嵌代码、单向升级到当前版；写入旧模板只会被治愈。
- **「rundll32 后 URL 无注入面」——静态成立**（spawn argv 直传无 shell），但本地 3.8 代码未逐行复核+宿主实机项未勾，列部分证实。（主审：:1159 已代读，代码层面成立；实机勾选仍欠。）
- **「cmd /c 包装 npm 存在参数注入」——证伪为无新增能力**（见 T-B3）。
- mod 全部 mods-API 调用包 safe()、pricing-updater 无 shell、install 各写入独立确认、pricing 种子不覆写——验证无问题。

## 修复顺序
1. 推送 3.8.0 并实机勾掉 TODO C1 末项（线上仍是 3.7.0 注入面）。
2. statusline.js 主 transcript 加 10MB 尾窗（与 agent 路径对齐）。
3. --install：settings.json 解析失败拒写+备份/原子写。
4. url 白名单加 /i 与控制字符过滤（双保险）。
5. resolvePricing hasOwnProperty；标签裁剪统一码点。

## 未验证/局限
本地 3.8 register.mjs 逐行内容（主审已代读关键路径）、$.process.run/$.store 引擎侧缓冲与持久化、宿主 spawn 行为（无进程执行通道，对抗样本未实跑）；scripts/postinstall.js 本次未直读（依据 CLAUDE.md）；报告文件因无 Write 工具未落盘，全文以本回复交付（主审已代存）。

## 主审独立复核表（05 报告 Top 结论）

| 结论 | 代理判定 | 主审核验 | 裁决 |
|---|---|---|---|
| T-B1 3.7.0 cmd-start URL 注入 | 高置信 | 3.7.0 远端代码+作者自述；本地 3.8.0 :1159 rundll32 已修 | **成立**（线上面=3.7.0，修复已备未推送） |
| T-C2 settings.json 损坏→确认后整写清空 | 高置信 | :343-350 catch 置 {} → :413 全量 writeFileSync | **成立** |
| T-C3 主 transcript 无 10MB 上限 | 高置信 | :917 全量读；:665-671 子代理路径有尾窗 | **成立** |
| T-C4 resolvePricing 原型键 | 低 | Object.keys 自有键；仅 `table['constructor']` truthy 短路残余 | **部分成立/低危** |
| HTTPS:// 大写误拒 | 兼容 bug | :1042 `/^https?:\/\//` 无 /i | **成立**（微） |
| T-B6 buttons.json 持久注入链 | 信息级 | 机制成立，属已声明边界（README 有提示） | 维持信息级 |
