# DeepSeno 插件规范与开发指南

> 版本：2.0（统一插件系统）
> 更新：2026-04-06

---

## 一句话说明

一个插件 = 一段 JSON。粘贴到"添加插件"里就装好了。

---

## 插件配置规范

每个插件是一个 JSON 对象，格式如下：

```json
{
  "id":           "唯一标识符（必填）",
  "name":         "显示名称（必填）",
  "description":  "一句话描述",
  "version":      "版本号，如 1.0.0",

  "instructions": "注入给 AI 的系统提示词（可选）",

  "mcp": {
    "command":    "启动命令，如 npx",
    "args":       ["命令参数"],
    "env":        { "环境变量KEY": "值" },
    "autoStart":  true
  },

  "page": {
    "icon":           "lucide 图标名",
    "menuLabel":      "侧边栏标签",
    "welcomeMessage": "打开页面时的欢迎语"
  }
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 唯一标识，如 `meeting-expert`。只能包含字母、数字、`-`、`_` |
| `name` | ✅ | 在界面上显示的名称 |
| `description` | 否 | 一句话描述，显示在插件卡片上 |
| `version` | 否 | 语义化版本号，用于更新检测 |
| `instructions` | 二选一 | 注入 LLM 系统提示词的文本。启用后 AI 对话时会遵循这些指令 |
| `mcp` | 二选一 | MCP 工具服务配置（见下文）|
| `page` | 否 | 如果填写，插件会在侧边栏多一个专属入口 |

> **`instructions` 和 `mcp` 至少要有一个。** 可以两个都有（混合插件）。

### MCP 配置

| 字段 | 说明 |
|------|------|
| `mcp.command` | 启动命令：`npx`、`node`、`python` 等 |
| `mcp.args` | 参数数组。如果是 npx 包，第一个参数通常是 `-y`（自动确认），第二个是包名 |
| `mcp.env` | 环境变量，传给子进程。值为空字符串的键会在安装时提示用户填写 |
| `mcp.autoStart` | 是否随应用启动自动运行（默认 true） |

### Page 配置

| 字段 | 说明 |
|------|------|
| `page.icon` | [lucide-react](https://lucide.dev/icons/) 图标名，如 `clipboard`、`mail`、`brain` |
| `page.menuLabel` | 侧边栏显示的标签（默认用 `name`） |
| `page.welcomeMessage` | 打开页面时显示的欢迎语 |

---

## 安装方式

打开 DeepSeno → 插件市场 → 点右上角 **[+ 添加]** → 粘贴 JSON → 点"安装"。

也支持：
- 粘贴包含 ````json` 代码块的 Markdown 文本（会自动提取 JSON）
- 选择本地 `.json` 或 `.md` 文件

---

## 三种插件类型 + 完整示例

### 类型 1：纯提示词插件

只有 `instructions`，没有 `mcp`。让 AI 以特定角色/方式工作，零开销。

```json
{
  "id": "meeting-expert",
  "name": "会议专家",
  "description": "会议纪要提取与行动项整理",
  "version": "1.0.0",
  "instructions": "你是一位会议纪要专家。当用户提到会议内容时：\n1. 提取所有议题和讨论要点\n2. 明确列出做出的决策\n3. 整理行动项（负责人 + 截止日期）\n4. 按时间线组织内容\n5. 标注关键参与者和他们的观点",
  "page": {
    "icon": "clipboard",
    "menuLabel": "会议专家",
    "welcomeMessage": "我可以帮你整理会议纪要、提取行动项。把会议内容告诉我吧。"
  }
}
```

**安装后效果：**
- 侧边栏出现"会议专家"入口
- 进入后是专属对话界面，AI 始终以会议专家身份回答
- 在主助手对话中，AI 也会参考此指令

### 类型 2：MCP 工具插件

只有 `mcp`，没有 `instructions`。给 AI 增加一个外部工具能力。

```json
{
  "id": "filesystem",
  "name": "文件系统",
  "description": "读写本地文件",
  "version": "1.0.0",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
    "autoStart": true
  }
}
```

**安装后效果：**
- 后台自动启动 MCP 服务进程
- AI 获得文件读写工具（`read_file`、`write_file` 等）
- 用户问"帮我看看 Documents 里有什么文件"，AI 能直接操作

**另一个例子 — 带环境变量的插件：**

```json
{
  "id": "github",
  "name": "GitHub",
  "description": "GitHub API 操作",
  "version": "1.0.0",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": ""
    },
    "autoStart": true
  }
}
```

> `env` 中值为空字符串 `""` 的键，表示需要用户安装后手动填写。

### 类型 3：混合插件

同时有 `instructions` 和 `mcp`。既定义角色，又提供工具。

```json
{
  "id": "research-assistant",
  "name": "调研助手",
  "description": "联网搜索 + 专业分析",
  "version": "1.0.0",
  "instructions": "你是一位专业调研助手。收到用户的调研需求后：\n1. 先用搜索工具收集相关信息\n2. 对比多个来源，识别一致性和矛盾\n3. 提炼关键发现，标注信息来源\n4. 给出结论和建议\n5. 用结构化格式呈现（标题、要点、表格）",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@kazuph/mcp-fetch"],
    "autoStart": true
  },
  "page": {
    "icon": "search",
    "menuLabel": "调研助手",
    "welcomeMessage": "我可以帮你搜索、分析、整理调研资料。说说你想了解什么？"
  }
}
```

**安装后效果：**
- 侧边栏出现"调研助手"入口
- AI 具有网页抓取工具能力
- 对话时 AI 遵循调研专家的工作流程

---

## 旧格式迁移指南

### 旧 Skill → 新插件

**旧格式（settings.json 中的 skills 数组元素）：**

```json
{
  "id": "email_writer",
  "name": "邮件助手",
  "description": "专业邮件撰写",
  "instructions": "你是一位专业邮件撰写助手...",
  "enabled": true,
  "page": { "icon": "mail" }
}
```

**新格式（直接粘贴安装）：**

```json
{
  "id": "email_writer",
  "name": "邮件助手",
  "description": "专业邮件撰写",
  "version": "1.0.0",
  "instructions": "你是一位专业邮件撰写助手...",
  "page": {
    "icon": "mail",
    "menuLabel": "邮件助手",
    "welcomeMessage": "我可以帮你撰写专业邮件，告诉我邮件的要点。"
  }
}
```

**变化：** 加 `version`，去掉 `enabled`（安装即启用），其余完全一样。

### 旧 MCP Server → 新插件

**旧格式（settings.json 中的 mcpServers 数组元素）：**

```json
{
  "id": "memory",
  "name": "持久记忆",
  "description": "MCP 知识图谱记忆",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-memory"],
  "env": {},
  "enabled": true,
  "autoStart": true
}
```

**新格式：**

```json
{
  "id": "memory",
  "name": "持久记忆",
  "description": "MCP 知识图谱记忆",
  "version": "1.0.0",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "autoStart": true
  }
}
```

**变化：** `command`/`args`/`env`/`autoStart` 整体移入 `mcp` 对象中，去掉 `enabled`，加 `version`。

### 旧 Skill + 旧 MCP → 合并为一个混合插件

以前需要分别添加一个 Skill 和一个 MCP Server。现在可以合成一个：

```json
{
  "id": "browser-assistant",
  "name": "浏览器助手",
  "description": "智能浏览器操作 + 网页分析",
  "version": "1.0.0",
  "instructions": "你是一个浏览器操作专家。用户提供 URL 时：\n1. 使用浏览器工具打开页面\n2. 提取关键内容并总结\n3. 如需要可以截图保存",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@playwright/mcp", "--headless"],
    "autoStart": true
  },
  "page": {
    "icon": "monitor",
    "menuLabel": "浏览器助手"
  }
}
```

---

## 可用的 lucide 图标名

侧边栏 `page.icon` 支持以下图标（直接填名称字符串）：

`mail` `calendar` `brain` `sparkles` `pen` `book` `chart` `code` `search` `clipboard` `hash` `message` `lightbulb` `wrench` `globe` `bot` `monitor` `cpu` `folder` `presentation`

查看完整图标库：https://lucide.dev/icons/

---

## 内置工具列表

以下工具始终可用（无需安装插件），AI 会根据对话意图自动调用：

| 工具 | 功能 |
|------|------|
| `create_todo` | 创建待办事项 |
| `complete_todo` | 完成待办事项 |
| `delete_todo` | 删除待办/备忘 |
| `list_todos` | 列出待办事项 |
| `create_memo` | 创建备忘录 |
| `generate_report` | 生成报告（日报/周报/月报） |
| `query_knowledge` | 查询知识库（RAG） |
| `search_recordings` | 搜索录音记录 |
| `update_memory` | 更新 AI 记忆 |
| `list_memories` | 列出记忆条目 |
| `set_reminder` | 设置提醒 |
| `list_reminders` | 列出提醒 |
| `send_email` | 发送邮件 |
| `web_search` | 网页搜索 |
| `create_pptx` | 创建 PPT |
| `create_docx` | 创建 Word 文档 |
| `create_pdf` | 创建 PDF |
| `read_pdf` | 读取 PDF 内容 |
| `send_file` | 发送文件 |

插件安装的 MCP 工具会自动出现在 AI 的工具列表中，前缀为 `plugin_<插件id>_<工具名>`。

---

## 开发 MCP 插件

如果内置工具不够用，可以开发自己的 MCP Server 作为插件分发。

### 最小示例（Node.js）

```javascript
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "my-tool", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [{
    name: "hello",
    description: "Say hello to someone",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person's name" }
      },
      required: ["name"]
    }
  }]
}));

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "hello") {
    const name = request.params.arguments?.name || "World";
    return {
      content: [{ type: "text", text: `Hello, ${name}!` }]
    };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 发布为 npm 包

1. 在 `package.json` 中添加 `"bin": { "my-tool": "./index.js" }`
2. `npm publish`
3. 用户安装时粘贴：

```json
{
  "id": "my-tool",
  "name": "My Tool",
  "description": "A custom tool",
  "version": "1.0.0",
  "mcp": {
    "command": "npx",
    "args": ["-y", "my-tool-package"],
    "autoStart": true
  }
}
```

### MCP 协议参考

- 官方文档：https://modelcontextprotocol.io
- SDK：`@modelcontextprotocol/sdk`（npm）
- 现有 MCP Servers 列表：https://github.com/modelcontextprotocol/servers
