# dsh-subagent-watchdog

DSH 宿主插件：**Agent 看板 + 子代理停滞检测器**。

- **Agent 看板**（常驻悬浮窗）：以当前会话（主 agent）为根的子代理层级树——每个节点显示状态（running/idle/停滞高亮）、静默时长、最新答复节选，点击节点直达对应会话；
- **停滞检测**：后台 subagent 静默超过阈值时，自动往其父会话注入 notice 提醒——老板不用轮询 `list_agents` 催进度，卡了会自动知道。

## 解决的问题

DSH 里后台子代理**卡住**时（工具调用死等、LLM 挂起、自循环、等待永远不来的输入），父会话收不到任何信号：

- `subagent-settled` 通知只在子代理真正 settle 时才投递，而卡住的 agent 可以**永远不 settle**；
- `list_agents` 只返回 `running/idle/ready`，没有活动时间戳，"running" ≠ "活着"；
- 宿主没有 turn 级超时兜底（唯一的 5 分钟流空闲超时在 LLM 适配器，且流持续吐数据就永不触发）。

## Agent 看板（悬浮窗）

- 常驻右上角，**树形层级图**：根 = 当前会话（主 agent，蓝色「主」标记，固定不随跳转漂移），子代理按血缘发散（虚线树线、深度缩进）；
- 每个节点：状态点（绿 running / 灰 idle）、静默时长、**最新答复节选**（80 字符，悬停看全文）、停滞红色高亮；
- **点击节点跳转到对应会话**（优先 catalog 子代理地址，兜底普通 open）；
- 交互：标题栏拖拽移动、点击折叠、`×` 隐藏（右下角召唤按钮）、侧边栏「Agent 看板」按钮 toggle；位置/显隐 localStorage 持久化；标签页隐藏自动暂停轮询。

## 停滞检测

1. 监听全局 `session/event`（每个事件自带毫秒时间戳，精确到最后一条 chunk/工具事件），维护每个子代理的**最后活动时间**；
2. 定时扫描所有 `running` 的子代理，静默超过阈值（默认 10 分钟）时，向它的父会话注入一条 `{kind:'plugin', form:'notice'}` 消息；
3. notice 静默排队进父会话 inbox——**GUI 可见、不唤醒模型、不耗 API 额度**，老板在下一个自然 step 看到提醒，自行决定：`send_message` 催一下 / `interrupt_agent` 中断重派 / 确认是长任务则忽略；
4. 同一子代理重复提醒受节流（默认 10 分钟一次），子代理结束/销毁即清账。

## 配置

| 参数 | 默认 | 说明 |
|---|---|---|
| `scanIntervalMs` | 60000 | 扫描周期 |
| `stallThresholdMs` | 600000 | 静默多久算停滞（10 分钟） |
| `remindIntervalMs` | 600000 | 同一子代理两次提醒的最小间隔 |

环境变量覆盖（便于按任务调优、测试）：`DSH_WATCHDOG_SCAN_MS` / `DSH_WATCHDOG_STALL_MS` / `DSH_WATCHDOG_REMIND_MS`（毫秒）。

## 误报控制

- 默认阈值 10 分钟，高于 LLM 适配器的流空闲兜底（5 分钟断流），纯模型挂起会被适配器兜底（产生事件或 settle），不会误报；
- 主要误报来源是长时间无输出的工具调用（`sleep`、大构建、长测试），notice 文案会提示「可能是长任务」。

## 开发

```bash
bash scripts/build.sh   # 编译 src → lib + tsdown 打包 client
```

构建依赖 DSH checkout（`DSH_CHECKOUT` 环境变量或常见路径自动探测）。注入运行中的实例用 DSH 的 `dev_inject_plugin` / `dev_install_package`；更新代码用 `dev_build_plugin` + `dev_reload_package`（client 已在注册表时 reload 会自动联动新 bundle 到浏览器）。
