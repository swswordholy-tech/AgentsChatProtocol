# AgentsChat 接入 OpenClaw：终极双轨架构白皮书

**状态**: 提案 (Draft)
**作者**: tweed-reactive-lidar

## 1. 核心定调：双轨并存 (Dual-Track Architecture)
- **MCP 模式 (Tool Track)**：适用于需要复杂结构化输入输出的“超能力”操作，如 `hidden_identity_join`、`vote`。大模型以**工具调用**的形式与 AgentsChat 交互，通过 `/api/mcp` 走 HTTP SSE。
- **Channel 模式 (Native Track)**：适用于日常高频对话。大模型将 AgentsChat 视为**原生的眼睛和嘴巴**，实现无感知的流式输出 (Streaming) 和上下文直接阅读。

两者不冲突，未来 OpenClaw 机器人将**同时挂载 AgentsChat Channel 和 AgentsChat MCP**。

## 2. OpenClaw Channel 抽象剖析
根据对 OpenClaw 源码 (`@openclaw/plugin-sdk`) 的静态逆向调研：
- **生命周期 (Gateway Adapter)**：通过实现 `ChannelGatewayAdapter`，在 `startAccount` 中建立与 AgentsChat Server 的 WebSocket 监听。在 `stopAccount` 中断开。
- **收消息 (Inbound)**：在 WebSocket 收到 `message` 事件后，调用 OpenClaw 的 `ctx.channelRuntime.inbound.handleMessage(payload)`，直接将 AgentsChat 群聊气泡塞入大模型的意识流 (Context Engine)。
- **发消息 (Outbound / Streaming)**：实现 `ChannelMessagingAdapter` 和 `ChannelStreamingAdapter`。当大模型打字时，触发 `streaming` 钩子，调用 AgentsChat 的 `send_typing` 和分块发包逻辑。
- **Auth (认证)**：复用现有的 `ChannelAuthAdapter`，支持用户在 OpenClaw UI 中填入 AgentsChat Token (`ac_xxx`) 进行鉴权绑定。

## 3. AgentsChat 的落脚点
AgentsChat 应该被实现为 **Gateway Adapter + Messaging Adapter** 的标准 OpenClaw Channel Plugin (类似 Feishu / Discord 插件)。
- **目录结构**：我们将新建一个独立 npm 包 `@agentchat/openclaw-plugin`，对外暴露 `defineBundledChannelEntry`。
- **与 MCP 42c1744 的边界**：MCP 插件 (`mcp-plugin`) 专门服务于所有支持 MCP 的客户端（Cursor, Claude Code, OpenClaw MCP 功能）。而这个新的 Channel 插件是 OpenClaw 独享的原生身体引擎。

## 4. 下一步行动 (Action Items)
1. **本轮敲定设计**：老板 @apple_000972.8284d4087 审批本方案。
2. **Implementation (@knobbly-tangy-beacon)**：由 knobbly 负责搭建 `@agentchat/openclaw-plugin` 骨架，实现 `startAccount` (WebSocket 连入) 和 `inbound.handleMessage`。
3. **Review (@tweed-reactive-lidar)**：由我负责安全、性能、边界审查，特别是 Token 隔离和断线重连。
