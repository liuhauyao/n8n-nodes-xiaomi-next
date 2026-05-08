# n8n-nodes-xiaomi-next

面向 **n8n** 的社区节点包：通过小米 **MiMo** 平台提供的 **OpenAI 兼容 Chat Completions** API，将 **Xiaomi MiMo Chat Model (Next)** 接入 **AI Chain** 与 **AI Agent**（LangChain `@langchain/openai` 的 `ChatOpenAICompletions` 实现）。

## 功能概览

- **OpenAI 兼容**：调用 `https://api.xiaomimimo.com/v1` 等与官方示例一致的 HTTPS 接口。
- **思考模式**：通过请求体中的 `thinking: { type: enabled | disabled }` 开关；启用后响应中可出现 `reasoning_content`。
- **多轮工具调用与 reasoning**：在多轮 Agent / 工具调用场景下，对 `reasoning_content` 做注入与缓存，避免因 n8n 多次 `supplyData` 清空实例状态而丢失推理上下文（思路对齐自研 DeepSeek 节点）。
- **流式镜像**：关闭思考模式时，可将推理流增量映射到常规文本内容，便于 n8n AI Agent 的流式汇总。
- **联网搜索**：可选向请求注入 MiMo 内置 `web_search` 工具（须在控制台开通联网插件）。
- **代理**：读取环境变量 `HTTPS_PROXY` / `HTTP_PROXY`，经 `undici` 转发。

## 环境要求

- **Node.js**：`>= 22.16`（与依赖及 n8n 新版运行环境一致）。
- **n8n**：需支持社区节点与本包声明的 `n8n-workflow` peer（见 `package.json`）。

## 安装方式

### 1. 在 n8n 界面安装（推荐）

若包已发布到 npm：进入 **设置 → 社区节点**，填写包名 `n8n-nodes-xiaomi-next` 并安装（具体以 [n8n 社区节点说明](https://docs.n8n.io/integrations/community-nodes/installation/) 为准）。

### 2. 在 `~/.n8n/nodes` 下用 npm 安装

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-xiaomi-next
```

### 3. 本地打包安装（内网或未发 npm 时）

```bash
cd n8n-nodes-xiaomi-next
npm install
npm run build
npm pack
cd ~/.n8n/nodes
npm install /path/to/n8n-nodes-xiaomi-next-1.0.0.tgz --legacy-peer-deps
```

安装后**重启 n8n**（或 PM2 / 容器内进程），再在节点面板中搜索 **Xiaomi MiMo**。

## 凭证配置

| 字段 | 默认值 | 说明 |
|------|--------|------|
| API Key | （必填） | 在 [MiMo 控制台 - API Keys](https://platform.xiaomimimo.com/#/console/api-keys) 创建 |
| Base URL | `https://api.xiaomimimo.com/v1` | OpenAI 兼容根路径；勿多写末尾斜杠（节点内会做规范化） |

凭证测试使用 `GET {baseUrl}/models`。鉴权方式为 **Bearer**，与小米文档中 OpenAI SDK 示例一致。

## 节点说明

节点类型为 **语言模型**，须连接到 **AI Chain** 或 **AI Agent**。主要参数：

| 分组 / 选项 | 说明 |
|-------------|------|
| **Model** | 优先从 `/models` 动态加载；失败时使用内置静态列表。 |
| **Thinking Mode** | `enabled` / `disabled`，默认关闭以控制成本与延迟。 |
| **Web Search** | 打开后写入 `tools: [{ type: 'web_search', force_search?: boolean }]`；需控制台开通插件。 |
| **Stream** | 是否流式；Agent 界面建议开启。 |
| **Parallel Tool Calls** | 是否并行工具调用；默认关闭以降低 Tools Agent 迭代压力。 |
| **Temperature / Top P** | 采样参数；MiMo 文档中 temperature 范围多为 `[0, 1.5]`，Top P `[0.01, 1.0]`。 |
| **Response Format** | `text` 或 `json_object`；若为 JSON，请在提示词中按要求包含 “json” 等关键词（以官方文档为准）。 |
| **Additional Model Arguments** | JSON 对象，浅合并进 `modelKwargs`（在 thinking / response_format 等之后）。 |

## 模型与能力对照（静态兜底）

动态列表成功时以接口为准；下方为离线兜底 ID：

| 模型 ID | 定位 | 能力摘要 |
|---------|------|----------|
| `mimo-v2.5-pro` | Pro 推理 | 文本、工具调用、联网搜索、思考模式 |
| `mimo-v2.5` | Omni 多模态 | 文本 + 图像 / 音频 / 视频、思考模式 |
| `mimo-v2-pro` | 上一代 Pro | 文本、工具调用、联网搜索 |
| `mimo-v2-omni` | 上一代 Omni | 文本 + 多模态理解 |
| `mimo-v2-flash` | 轻量 | 文本、工具调用、联网、低延迟 |

官方对 **temperature** 的默认值与取值范围因模型而异，文档建议 Pro / Omni 类常用约 `1.0` / `top_p≈0.95`，Flash 类 temperature 可更低；节点内已按文档设置合理默认与范围，可按任务再调。

## 多模态说明

**图像 / 音频 / 视频** 由 **消息内容结构** 传入（如 OpenAI 式 `image_url`、`input_audio`、`video_url` 等），一般由 **Agent / Chain** 侧组消息完成；本 Chat Model **节点不包含**单独的「上传文件」表单。限制与 MIME、大小等请以小米文档为准，例如文档中提及：图像单张 URL 可达约 50MB、音频 URL 约 100MB、视频 URL 约 300MB（Base64 另有上限）。

## 联网搜索插件

使用前请在 [控制台 - 插件](https://platform.xiaomimimo.com/#/console/plugin) 开通 **联网服务**。官方说明当前支持联网的模型包含：`mimo-v2.5-pro`、`mimo-v2.5`、`mimo-v2-pro`、`mimo-v2-omni`、`mimo-v2-flash`。计费含插件调用次数与上下文 Token，详见 [定价与限速](https://platform.xiaomimimo.com/docs/zh-CN/pricing)。

## 本地开发

```bash
git clone https://github.com/liuhauyao/n8n-nodes-xiaomi-next.git
cd n8n-nodes-xiaomi-next
npm install
npm run build
```

开发时可 `npm run dev`（`tsc --watch`）。

## 官方文档链接

- [欢迎与总览](https://platform.xiaomimimo.com/docs/zh-CN/welcome)
- [首次调用 API](https://platform.xiaomimimo.com/docs/zh-CN/quick-start/first-api-call)
- [模型超参](https://platform.xiaomimimo.com/docs/zh-CN/quick-start/model-hyperparameters)
- [错误码](https://platform.xiaomimimo.com/docs/zh-CN/quick-start/error-codes)
- [联网搜索](https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/tool-calling/web-search)
- [图片理解](https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/multimodal-understanding/image-understanding)
- [音频理解](https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/multimodal-understanding/audio-understanding)
- [视频理解](https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/multimodal-understanding/video-understanding)

## 开源协议

MIT
