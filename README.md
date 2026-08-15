# dsh-subagent-watchdog

DSH 宿主插件：**子代理停滞检测器**。后台 subagent 静默超过阈值时，自动往其父会话注入一条 notice 提醒——老板不用再轮询 `list_agents` 催进度，卡了会自动知道。

## 解决的问题

DSH 里后台子代理**卡住**时（工具调用死等、LLM 挂起、自循环、等待永远不来的输入），父会话收不到任何信号：

- `subagent-settled` 通知只在子代理真正 settle 时才投递，而卡住的 agent 可以**永远不 settle**；
- `list_agents` 只返回 `running/idle/ready`，没有活动时间戳，"running" ≠ "活着"；
- 宿主没有 turn 级超时兜底（唯一的 5 分钟流空闲超时在 LLM 适配器，且流持续吐数据就永不触发）。

## 工作机制

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
bash scripts/build.sh   # 编译 src → lib
```

构建依赖 DSH checkout（`DSH_CHECKOUT` 环境变量或常见路径自动探测）。注入运行中的实例用 DSH 的 `dev_inject_plugin` / `dev_install_package`。
