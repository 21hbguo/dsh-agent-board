# 吸收报告：dsh-agent-board 四色状态语义

> 吸星大法（xixing-dafa）实战 · 目标：让看板颜色真正「用起来」——working 一种、done 一种、done 点击后（已读/空闲）一种。

## 调研范围

深度吸（快速版）：重点调研「状态颜色语义」设计惯例，共 8 个对象——4 个 GitHub 平台事实 + 2 个设计系统 + 1 个同类工具 + 1 个反面案例。全部经 gh CLI / searxng 免费渠道获取，零第三方搜索额度消耗。

## 对比矩阵

| 候选 | 定位 | 状态色设计 | ⭐/维护 | 许可证 | 可借鉴点 |
|---|---|---|---|---|---|
| [GitHub Actions](https://graphite.com/guides/github-actions-status)（Graphite 指南） | CI 状态 | queued=黄闪 / in_progress=黄 / success=绿 / failure=红 | — | — | 运行中=黄（暖色提醒）、完成=绿、失败=红 |
| [GitHub Actions :visited 现象](https://github.com/orgs/community/discussions/188130) | 平台行为 | 运行状态图标**点击查看后**失去红绿、变灰 | — | — | **「查看过=弱化变灰」是平台级用户心智**（用户诉求的直接先例） |
| [GitHub issue 图标色调整](https://github.blog/changelog/2021-10-26-updates-to-our-issue-status-icons-and-colors/) | 平台设计 | open=绿/closed=红曾引发困惑，官方调整 | — | — | 状态色语义要谨慎，避免与错误色混淆 |
| [SAP Fiori 语义色](https://www.sap.com/design-system/fiori-design-web/v1-96/foundations/best-practices/ui-elements/how-to-use-semantic-colors) | 设计系统 | 绿=positive / 红=negative / 黄=critical / 灰蓝=neutral；**unactivated=未激活态用中性色** | — | — | 空闲/未激活=中性灰；语义色只在表达语义时用 |
| [AIA Design 状态指示器](https://design.aia.com/component/status-indicator) | 设计系统 | 绿=complete/approved/ready；有 unactivated（未激活）版本 | — | — | 完成=绿 + 未激活降级表达 |
| [Tracim #4883](https://github.com/tracim/tracim/issues/4883) | 协作平台 | **未读通知用蓝色**（提及 lightBlue 40% 透明度） | 活跃 | AGPL | 未读/新=蓝 |
| [微信未读语音变灰](http://m.szhk.com/news_31808449821453754.html)（反面案例） | IM | 未读用浅灰导致用户误判为已读，被全网吐槽 | — | — | **未读必须醒目，已读才能用灰**——方向反了会翻车 |
| [BlackBeltTechnology/pi-agent-dashboard](https://github.com/BlackBeltTechnology/pi-agent-dashboard) | agent 实时看板 | 多会话实时镜像/终端/diff 查看 | ⭐247/活跃 | — | 同类形态参考（本次不吸其功能，仅记录） |

## 可吸收点清单

| # | 吸收点 | 来源 | 为什么吸 | 吸收方式 | 落地情况 |
|---|---|---|---|---|---|
| 1 | **完成（未查看）= 蓝**：done 是「新结果」，用醒目色（蓝）吸引注意 | Tracim 未读蓝 + 邮件客户端惯例 | 老板视角需要一眼看到「有新完成的子代理」 | 借鉴改造 | ✅ client 保持 `swd-st-finished`（#60a5fa 蓝）+「完成」文本 |
| 2 | **完成且已点击（已读/空闲）= 灰**：打开过会话=看过了=弱化，颜色从蓝变灰 | GitHub Actions :visited 现象 + SAP neutral/unactivated | 用户明确诉求「done 完点击后的空闲是一种」；已读弱化是平台级心智 | 借鉴改造 | ✅ 新增 viewed 集合，双击打开标记已读，蓝→灰（`swd-st-idle` #6b7280）+「空闲」文本 |
| 3 | **working = 绿 + 停滞 = 红**：运行中/告警两极保持既有色 | GitHub Actions success=绿/failure=红 + SAP positive/negative | 红=出错、绿=在跑是既有承诺与用户心智，不动 | 直接沿用 | ✅ 未改动（#4ade80 / #f87171） |
| 4 | **已读持久化**：跨刷新不丢（localStorage，上限 500 防膨胀） | 项目既有位置持久化机制（`dsh.agentBoard.v1`） | 刷新页面后已读反馈不能丢；复用既有存储模式 | 直接复用（自家模式） | ✅ `dsh.agentBoard.viewed.v1`，cap 500 |

## 丢弃/降级说明

- **GitHub Actions 黄色=in_progress**：未采用——本看板 working 已是绿色且 README 承诺在先（绿=working），黄色会让用户困惑；「running=绿」在本场景语义自洽（红=停滞告警与绿形成两极）。
- **微信未读灰**：未采用——作为反面案例记录，正好佐证「未读醒目、已读灰」的方向正确。
- **pi-agent-dashboard 功能**（终端/diff 查看）：与本次目标（颜色语义）无关，按铁律 6 丢弃，仅入矩阵。

## 落地对照

| 吸收点 | 实际改动 |
|---|---|
| 1/2 | `src/client/index.tsx`：新增 `VIEWED_KEY`/`loadViewed`/`markViewed`/`isViewed`（约 40 行）；`statusText` 的 finished 分支按已读返回「空闲/完成」；`renderNode` 的 stClass 按已读选择 `swd-st-idle`/`swd-st-finished`；`openSession` 打开前 `markViewed(id)`；`apply` 初始化 `loadViewed()` |
| 4 | 同一处：localStorage `dsh.agentBoard.viewed.v1`，数组+Set 双结构，500 上限裁剪 |
| 文档 | `README.md`：颜色行改为「四色状态语义」（🟢working/🔵完成未读/⚪已读空闲/🔴停滞），交互行补「双击打开=已读」 |

自检结果：tsc 构建零错误（dev_build_plugin 通过）；lib/client.js bundle 确认含新逻辑（8 处引用）；热重载成功（fiber active）；原功能（单击折叠/双击打开/SSE/告警）未触碰。

## 结论与下一步

目标达成：看板颜色从「静态四色」升级为「**有交互语义的四色**」——working 绿、done 蓝、done 点击后灰（已读空闲）、停滞红，与 GitHub 平台「查看过即弱化」的心智一致。刷新浏览器页面即可看到：双击打开某个蓝色「完成」节点，它变灰、文本变「空闲」。

下一步可选：① 已读节点支持「一键全部已读」；② 子代理树「全部完成且已读」的根节点提前折叠；③ 把本次「已读持久化」模式沉淀为插件通用工具。
