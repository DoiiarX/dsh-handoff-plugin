# @local/dsh-handoff-plugin

[English](README.md) | 中文

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

重启遗言（遗言）—— 每个会话的持久化"临终遗言"记录，加上 Host 重启恢复会话时的自动继续提醒。本包是一个 host 级函数插件：每个会话（任意 preset）都获得三个工具和重启提醒监听器。

## 工具

- `handoff_save(objective, progress?, next_step?, goal_id?, round?, note?)` 为当前会话写入持久 pending 记录，按 `agent.id`（= SessionId）存于 `<DSH_HOME>/.handoff/<sessionId>.json`。记录捕获会话自身的 preset 与 provider/model 路由，使自动恢复挂载相同组合并还原模型。当本会话是进行中重启广播的目标时，遗言还会携带该广播的 `requestId`，因此结算可以只接受当前重启请求产生的记录。
- `handoff_clear()` 移除当前会话的记录——其工作已完全恢复或完成后调用，避免之后无关重启再次提醒已结束的任务。在广播窗口内，它同时为当前广播结算本 agent（"没有进行中的工作——无需遗言"）。
- `handoff_at_restart(wait_seconds?)` 向每个可中断的在线 agent（运行中、有 pending 收件箱工作、或有活动目标）广播"重启在即，请留下你的遗言"请求，然后触发 supervisor 优雅重启 Host。发起者永远不会成为目标。每个 agent 自己写自己的遗言内容；本工具不代写。

## 事件驱动的广播

重启广播全程事件驱动，绝不轮询：

1. 每个目标先被取消（`keepInbox` 保留排队输入）。
2. 广播在发送任何内容前，通过 `Agent.whenIdle()` 等待每个目标真正静止，从而消除 cancel/send 竞态：请求只会落在真正到达 idle 的 agent 上，绝不会落在仍在从被取消活动收敛的 agent 上。
3. 每个目标收到一个独立的 handoff 回合（唯一消息是请求的普通 follow-up 回合）。
4. 目标的模型回合调用 `handoff_save` / `handoff_clear`，它们会携带广播 `requestId` 发出 `handoff/settled` 事件。
5. 广播监听该事件，并在每个目标都已结算时立即 resolve——没有任何轮询循环去重读文件或定时器来探测进度。
6. supervisor 重启文件（`<DSH_HOME>/.handoff/.restart-request`）只在所有目标都已结算时才写入，且以**带签名的 JSON 记录**写入（`{ attested: true, requestId, requestedAt, confirmed, unconfirmed }`）。若等待预算耗尽仍有未确认目标，工具会报告它们并且不重启——重启绝不会切断一个仍在工作的 agent 而不给它留下遗言的机会。

只有为当前广播结算（匹配其 `requestId`）的记录才算确认。早先重启留下的陈旧记录绝不能被误判为"已完成"——这正是过去把任何已存在的文件都当作证据的旧记录误判。

## 带签名的重启（统一入口）

`handoff_at_restart` 是重启 Host 的**唯一合法途径**；它的模型可见描述、广播请求正文、以及恢复提醒都明确声明了这一点。supervisor 只接受本广播写出的带签名 JSON 记录作为重启触发——记录携带广播 `requestId` **和发起者 session id**。裸 `touch .restart-request`——即 agent 或脚本绕过广播偷偷重启 Host——会被**忽略并删除**，因此非广播重启无法在没有遗言的情况下切断任何在线会话。未运行广播的正常重启（supervisor SIGTERM、用户按钮、计划任务）因此被视为未签名并拒绝；下面的 teardown 兜底仍会在 Host 以其他方式停止时保护这些会话。

## 提醒中的重启发起人

被恢复会话的 `<handoff_reminder>` 会**指名是谁重启了 Host**，让会话永远不会困惑为什么被切断：正规广播会把发起者 session id 记入每份遗言，提醒会显示"此重启由会话 X 通过 handoff 广播发起"。未签名重启（agent 绕过广播、用户按钮、supervisor SIGTERM）没有发起人，提醒会将其标注为 **UNEXPECTED** 并指向 `handoff_at_restart` 作为唯一合法路径。

## Teardown 兜底

无论 Host 以何种方式停止——优雅 SIGTERM、用户触发的重启、或 agent 绕过广播偷偷重启——插件的 teardown 钩子都会为每个**运行中且没有遗言**的 agent 写入一份通用 pending 遗言（`fallback: true`，"Host 重启时此会话仍在运行"）。"运行中"是从 `agent/status` 事件**实时维护**的事实（会话开始运行时加入、变 idle 时移除），绝不是 teardown 时的**事后 registry 查询**——到那时每个 agent 都已被取消为 idle 了。这填补了"重启从未运行 `handoff_at_restart`"的空档：这些会话在下次启动时仍会被恢复，而不是无声消失。已有的 pending 遗言永远不会被覆盖；idle 会话（没有会被打断的活动 driver）不受保护。

## 自动恢复

Host 启动后，插件扫描 `<DSH_HOME>/.handoff/` 并恢复任何持有**上一个 host 生命周期**写入的 pending 记录的会话，还原其记录的 preset 与 provider/model 路由。提醒**不会立即注入**：先等待恢复的 driver 达到静止（`Agent.whenIdle()`，有界）再加一段短静默窗口——这样上一个 Host 死亡时仍在向持久日志追加输出的工具回合会先排空，提醒才开启新回合；否则两条流会竞争下一个序列号并损坏日志（已观察到 seq-gap 损坏）。然后提醒才通过 `Agent.followup()` 投递（与 goal-round driver 使用的唤醒相同），pending 标志被翻转，之后的无关重启不会再次提醒同一任务。本 host 生命周期内写入的遗言保持 pending 不动：它们是为下一次重启的自动恢复准备的。广播窗口打开期间，idle→投递路径被完全抑制，因此按请求写下遗言的 agent 不会在它为之准备的重启之前就被消费掉。

## 模型体验

### 交接工具

#### 模型看到什么

生成的 `handoff_save`、`handoff_clear`、`handoff_at_restart` 工具 schema 在本包工具注册可见的作用域内渲染；本包不注册固定提示段落。成功结果是紧凑 JSON：`{ written, file }`、`{ cleared }`，以及 `{ broadcast, waitSeconds, requestFile, restarted, confirmed, unconfirmed }`。

#### Token 影响

在可见该插件工具注册的作用域内，工具 schema 每个请求增加少量固定成本；每次调用的结果属于普通工具历史。

#### KV Cache 影响

工具定义不变时 schema 前缀稳定；调用与结果追加在可复用请求前缀之后。

## 已知限制与推迟的工作

- **结算依赖目标的配合**——广播在预算内等待目标自己调用 `handoff_save` / `handoff_clear`；目标模型回合始终未结算遗言时会阻塞重启（按设计报告为未确认），直到调用方重试或在别处强制重启。
- **本包没有强制重启的逃生口**——即使存在未确认 agent 也必须重启的调用方，需要自己写 `.restart-request` 文件或加大 `wait_seconds`；工具绝不会静默跨过未结算目标重启。
- **自动恢复是恢复而非分叉**——pending 遗言投递到同一会话 id；没有"恢复到全新会话"的模式。
- **同一时刻只有一个广播**——一个广播进行中再次调用 `handoff_at_restart` 会返回 `restarted: false` 并把目标列为未确认，而不是排队。
