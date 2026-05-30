# opencode-bridge

将 opencode headless 服务桥接到 Web / 手机客户端的 WebSocket 服务器。

## 架构

```
手机/网页 (web-client/agent.html)
       │  WebSocket (ws://host:9001)
       ▼
  opencode-bridge  (Node.js)
       │  HTTP/SSE
       ▼
  opencode serve  (本地)
```

## 运行要求

- **Node.js ≥ 22.6**（支持 `--experimental-strip-types`，无需 tsc 编译）
- **opencode** 已安装并在 PATH 中（`npm install -g opencode-ai`）

## 快速开始

### Windows
```bat
agent.bat C:\your\project 9001
```

### macOS / Linux
```bash
./agent.sh /your/project 9001
```

启动后，用手机或电脑浏览器打开 `web-client/agent.html`，连接地址填 `ws://<局域网 IP>:9001`。

## 手动运行

```bash
cd opencode-bridge
npm install
# 让 bridge 自己启动 opencode serve：
node --experimental-strip-types src/index.ts --dir /your/project --port 9001

# 或连接已运行的 opencode serve：
node --experimental-strip-types src/index.ts --dir /your/project --port 9001 --opencode-url http://127.0.0.1:4000
```

## Bridge 协议

### Server → Client
| type | 说明 |
|------|------|
| `bridge.ready` | 连接成功，含 opencode URL |
| `session.list` | 现有会话列表 |
| `session.created` | 新会话创建 |
| `session.status` | `idle`/`busy`/`retry` |
| `text.delta` | LLM 文本增量 |
| `text.done` | 文本部分结束 |
| `reasoning.delta` | 思考过程增量 |
| `tool.pending/running/done/error` | 工具调用状态 |
| `permission.asked` | 需要用户授权 |

### Client → Server
| type | 说明 |
|------|------|
| `session.create` | 创建新会话 |
| `session.prompt` | 发送 prompt |
| `permission.reply` | 授权回复（once/always/reject）|
| `session.abort` | 中止当前任务 |
