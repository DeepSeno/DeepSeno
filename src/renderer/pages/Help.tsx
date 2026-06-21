import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BookOpen, Puzzle, Terminal,
  Globe, HelpCircle,
} from 'lucide-react';
import { useI18n } from '../i18n';

interface Section {
  id: string;
  icon: React.ReactNode;
  titleKey: 'section_plugin' | 'section_builtin' | 'section_faq';
  content: { zh: string; en: string };
}

const SECTIONS: Section[] = [
  {
    id: 'plugin-dev',
    icon: <Puzzle size={15} />,
    titleKey: 'section_plugin',
    content: {
      zh: `## 什么是插件

插件是一段 **JSON 配置**，粘贴到"添加插件"里就能安装。一个插件可以包含：

- **提示词（inject_prompt）** — 注入 AI 系统提示词，改变 AI 的行为方式
- **MCP 工具（mcp）** — 启动外部工具进程，扩展 AI 的操作能力
- 两者都有（混合插件）

## 完整格式

\`\`\`json
{
  "id":           "唯一标识符",
  "name":         "显示名称",
  "description":  "一句话描述",
  "version":      "1.0.0",
  "inject_prompt": "系统提示词（可选）",
  "mcp": {
    "command":    "npx",
    "args":       ["-y", "包名"],
    "env":        { "API_KEY": "" },
    "autoStart":  true
  },
  "page": {
    "icon":           "lucide 图标名",
    "menuLabel":      "侧边栏标签",
    "welcomeMessage": "欢迎语"
  }
}
\`\`\`

> \`instructions\` 和 \`mcp\` **至少要有一个**。\`page\` 可选。

## 示例 1：纯提示词

\`\`\`json
{
  "id": "meeting-expert",
  "name": "会议专家",
  "description": "会议纪要提取",
  "version": "1.0.0",
  "inject_prompt": "你是一位会议纪要专家。提取议题、决策和行动项。",
  "page": { "icon": "clipboard", "menuLabel": "会议专家" }
}
\`\`\`

## 示例 2：MCP 工具

\`\`\`json
{
  "id": "filesystem",
  "name": "文件系统",
  "description": "读写本地文件",
  "version": "1.0.0",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/"],
    "autoStart": true
  }
}
\`\`\`

## 示例 3：混合插件

\`\`\`json
{
  "id": "research-assistant",
  "name": "调研助手",
  "description": "联网搜索 + 分析",
  "version": "1.0.0",
  "inject_prompt": "你是一位调研助手。先搜索再分析，标注来源。",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@kazuph/mcp-fetch"],
    "autoStart": true
  },
  "page": { "icon": "search", "menuLabel": "调研助手" }
}
\`\`\`

## 编写 inject_prompt 的要点

**1. 明确角色：** \`你是一位 [角色]。\`

**2. 列出步骤：**
\`\`\`
当用户 [触发条件] 时：
1. [第一步]
2. [第二步]
\`\`\`

**3. 结合内置工具：**
\`\`\`
当用户要求生成报告时，使用 create_docx 工具。
\`\`\`

**建议：** inject_prompt 控制在 500 字以内，太长会占用 LLM 上下文窗口。

## 开发 MCP Server

如果需要自定义工具，可以用 Node.js 或 Python 开发 MCP Server：

\`\`\`javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "my-tool", version: "1.0.0" });

server.tool("hello", "Say hello", { name: { type: "string" } },
  async ({ name }) => ({
    content: [{ type: "text", text: \`Hello, \${name}!\` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
\`\`\`

发布为 npm 包后，配置成插件：

\`\`\`json
{
  "id": "my-tool",
  "name": "My Tool",
  "version": "1.0.0",
  "mcp": { "command": "npx", "args": ["-y", "my-tool-pkg"], "autoStart": true }
}
\`\`\`

## 常用图标

\`clipboard\` \`mail\` \`chart\` \`lightbulb\` \`globe\`

\`brain\` \`calendar\` \`presentation\` \`book-open\` \`code\`

\`users\` \`search\` \`monitor\` \`cpu\` \`folder\``,
      en: `## What is a Plugin

A plugin is a **JSON config** — paste it into "Add Plugin" to install. A plugin can contain:

- **Instructions** — injected into the AI system prompt, changing AI behavior
- **MCP tools** — starts an external tool process, extending AI capabilities
- Both (hybrid plugin)

## Full Format

\`\`\`json
{
  "id":           "unique-identifier",
  "name":         "Display Name",
  "description":  "One-line description",
  "version":      "1.0.0",
  "inject_prompt": "System prompt (optional)",
  "mcp": {
    "command":    "npx",
    "args":       ["-y", "package-name"],
    "env":        { "API_KEY": "" },
    "autoStart":  true
  },
  "page": {
    "icon":           "lucide icon name",
    "menuLabel":      "Sidebar label",
    "welcomeMessage": "Welcome message"
  }
}
\`\`\`

> At least one of \`instructions\` or \`mcp\` is **required**. \`page\` is optional.

## Example 1: Instructions Only

\`\`\`json
{
  "id": "meeting-expert",
  "name": "Meeting Expert",
  "description": "Meeting notes & action items",
  "version": "1.0.0",
  "inject_prompt": "You are a meeting notes expert. Extract topics, decisions, and action items.",
  "page": { "icon": "clipboard", "menuLabel": "Meeting Expert" }
}
\`\`\`

## Example 2: MCP Tool

\`\`\`json
{
  "id": "filesystem",
  "name": "File System",
  "description": "Read and write local files",
  "version": "1.0.0",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/"],
    "autoStart": true
  }
}
\`\`\`

## Example 3: Hybrid Plugin

\`\`\`json
{
  "id": "research-assistant",
  "name": "Research Assistant",
  "description": "Web search + analysis",
  "version": "1.0.0",
  "inject_prompt": "You are a research assistant. Search first, then analyze. Cite sources.",
  "mcp": {
    "command": "npx",
    "args": ["-y", "@kazuph/mcp-fetch"],
    "autoStart": true
  },
  "page": { "icon": "search", "menuLabel": "Research Assistant" }
}
\`\`\`

## Tips for Writing Instructions

**1. Define the role:** \`You are a [role].\`

**2. List steps:**
\`\`\`
When the user [trigger]:
1. [Step one]
2. [Step two]
\`\`\`

**3. Leverage built-in tools:**
\`\`\`
When the user asks to generate a report, use the create_docx tool.
\`\`\`

**Tip:** Keep inject_prompt under 500 words to avoid consuming the LLM context window.

## Developing MCP Servers

For custom tools, develop an MCP Server in Node.js or Python:

\`\`\`javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "my-tool", version: "1.0.0" });

server.tool("hello", "Say hello", { name: { type: "string" } },
  async ({ name }) => ({
    content: [{ type: "text", text: \`Hello, \${name}!\` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
\`\`\`

Publish as an npm package, then configure as a plugin:

\`\`\`json
{
  "id": "my-tool",
  "name": "My Tool",
  "version": "1.0.0",
  "mcp": { "command": "npx", "args": ["-y", "my-tool-pkg"], "autoStart": true }
}
\`\`\`

## Common Icons

\`clipboard\` \`mail\` \`chart\` \`lightbulb\` \`globe\`

\`brain\` \`calendar\` \`presentation\` \`book-open\` \`code\`

\`users\` \`search\` \`monitor\` \`cpu\` \`folder\``,
    },
  },
  {
    id: 'builtin-tools',
    icon: <Terminal size={15} />,
    titleKey: 'section_builtin',
    content: {
      zh: `## 当前内置工具

| 工具 | 功能 | 触发词 |
|------|------|--------|
| \`create_todo\` | 创建待办事项 | "帮我记一下"、"添加待办" |
| \`complete_todo\` | 完成待办 | "完成了"、"已做完" |
| \`list_items\` | 列出事项 | "我有哪些待办" |
| \`create_memo\` | 快速备忘 | "记住这个" |
| \`set_reminder\` | 设置提醒 | "提醒我"、"XX点钟" |
| \`generate_report\` | 生成日报/周报 | "生成日报"、"这周总结" |
| \`query_knowledge\` | 查询知识库 | "我之前说过什么" |
| \`search_recordings\` | 搜索内容 | "搜索关于XX的内容" |
| \`web_search\` | 网页搜索 | "搜索一下"、"最新新闻" |
| \`send_email\` | 发送邮件 | "发邮件给" |
| \`create_pptx\` | 创建 PPT | "做个PPT"、"制作演示文稿" |
| \`create_docx\` | 创建 Word | "写个文档"、"生成Word" |
| \`create_pdf\` | 创建 PDF | "生成PDF" |
| \`read_pdf\` | 读取 PDF | "读一下这个PDF" |
| \`send_file\` | 发送文件 | "把文件发给我" |
| \`update_memory\` | 更新记忆 | "记住我喜欢" |
| \`lookup_person\` | 查询人物 | "XX是谁" |

## 工具与插件的关系

插件的 inject_prompt 可以引导 AI 优先使用特定工具。例如"专业 PPT 设计师"插件引导 AI 在制作 PPT 时遵循专业设计准则。

MCP 插件安装的工具会自动出现在 AI 的工具列表中，前缀为 \`plugin_<插件id>_<工具名>\`。`,
      en: `## Built-in Tools

| Tool | Function | Trigger Phrases |
|------|----------|----------------|
| \`create_todo\` | Create a to-do item | "remind me to", "add a task" |
| \`complete_todo\` | Complete a to-do | "done", "finished" |
| \`list_items\` | List items | "what are my todos" |
| \`create_memo\` | Quick memo | "remember this" |
| \`set_reminder\` | Set a reminder | "remind me at", "at 3pm" |
| \`generate_report\` | Generate daily/weekly report | "generate report", "weekly summary" |
| \`query_knowledge\` | Query knowledge base | "what did I say about" |
| \`search_recordings\` | Search content | "search for content about" |
| \`web_search\` | Web search | "search for", "latest news" |
| \`send_email\` | Send email | "send an email to" |
| \`create_pptx\` | Create PowerPoint | "make a PPT", "create presentation" |
| \`create_docx\` | Create Word document | "write a document", "generate Word" |
| \`create_pdf\` | Create PDF | "generate PDF" |
| \`read_pdf\` | Read PDF | "read this PDF" |
| \`send_file\` | Send file | "send me the file" |
| \`update_memory\` | Update memory | "remember that I like" |
| \`lookup_person\` | Look up person | "who is XX" |

## Relationship Between Tools and Plugins

A plugin's inject_prompt can guide the AI to prioritize specific tools. For example, a "Professional PPT Designer" plugin guides the AI to follow professional design principles when creating presentations.

MCP plugin tools automatically appear in the AI's tool list, prefixed as \`plugin_<pluginId>_<toolName>\`.`,
    },
  },
  {
    id: 'faq',
    icon: <HelpCircle size={15} />,
    titleKey: 'section_faq',
    content: {
      zh: `## 如何安装插件

打开**插件市场** → 点右上角 **[+ 添加]** → 粘贴 JSON 配置 → 点"安装"。

也可以选择 \`.json\` 或 \`.md\` 文件（会自动提取 \`\`\`json 代码块）。

## 插件启动失败

**报错：** "could not determine executable to run"
**原因：** npm 包缺少 \`bin\` 字段
**解决：** 改用 \`node -e "require('package-name')"\` 方式启动

## 插件需要 API Key

在 JSON 配置的 \`mcp.env\` 中填入：
\`\`\`json
"mcp": {
  "command": "npx",
  "args": ["-y", "some-package"],
  "env": { "API_KEY": "your-key-here" }
}
\`\`\`

## inject_prompt 有长度限制吗

技术上没有限制，但建议 500 字以内。过长会占用 LLM 上下文窗口，降低对话质量。

## 如何调试 MCP 插件

1. 在插件详情面板查看"日志"标签页
2. 使用 \`pnpm dev\` 启动应用，查看控制台 \`[PluginEngine]\` 前缀的日志
3. 成功启动会显示 \`Started "xxx" — N tools discovered\`

## 为什么 AI 没有调用工具

1. 检查意图分类是否正确（查看控制台 \`[Agent] intent=\` 日志）
2. 插件工具在所有意图下都可用，内置工具按类别过滤
3. 确保工具描述足够清晰，让 AI 理解何时该调用`,
      en: `## How to Install a Plugin

Open **Plugin Market** → click **[+ Add]** in the top right → paste JSON config → click "Install".

You can also select a \`.json\` or \`.md\` file (it will auto-extract \`\`\`json code blocks).

## Plugin Fails to Start

**Error:** "could not determine executable to run"
**Cause:** The npm package is missing the \`bin\` field
**Solution:** Use \`node -e "require('package-name')"\` to start instead

## Plugin Requires an API Key

Add it to \`mcp.env\` in the JSON config:
\`\`\`json
"mcp": {
  "command": "npx",
  "args": ["-y", "some-package"],
  "env": { "API_KEY": "your-key-here" }
}
\`\`\`

## Is There a Length Limit for Instructions?

Technically no, but it's recommended to keep them under 500 words. Overly long inject_prompt consume the LLM context window and degrade conversation quality.

## How to Debug MCP Plugins

1. Check the "Logs" tab in the plugin detail panel
2. Start the app with \`pnpm dev\` and check the console for \`[PluginEngine]\` logs
3. A successful start will show \`Started "xxx" — N tools discovered\`

## Why Isn't the AI Calling Tools?

1. Check if intent classification is correct (\`[Agent] intent=\` in console)
2. Plugin tools are available under all intents; built-in tools are filtered by category
3. Ensure tool descriptions are clear enough for the AI to understand when to call them`,
    },
  },
];

export default function Help({ embedded }: { embedded?: boolean }) {
  const { t, lang } = useI18n();
  const [activeSection, setActiveSection] = useState('plugin-dev');

  const activeContent = SECTIONS.find(s => s.id === activeSection);

  return (
    <div className={`flex flex-col gap-5 ${embedded ? '' : 'h-full'}`}>
      {/* Header — hidden when embedded in Settings */}
      {!embedded && (
        <div className="kz-ph">
          <div>
            <div className="kz-ph__title flex items-center gap-2.5">
              <BookOpen size={20} className="kz-text-soft" />
              {t.help.title}
            </div>
            <div className="kz-ph__sub">{lang === 'zh' ? '插件、内置工具与常见问题' : 'Plugins, built-in tools & FAQ'}</div>
          </div>
          <div className="kz-ph__right">
            <a
              href="https://modelcontextprotocol.io/introduction"
              target="_blank"
              rel="noopener noreferrer"
              className="kz-btn kz-btn--sm"
            >
              <Globe size={12} /> MCP Protocol
            </a>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="kz-paper flex overflow-hidden flex-1" style={{ padding: 0 }}>
        {/* Left: nav */}
        <div
          className="w-[240px] py-2 flex-shrink-0"
          style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-elev)' }}
        >
          {SECTIONS.map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`w-full text-left px-4 py-3 flex items-center gap-3 ${
                activeSection === section.id ? 'kz-row-selected' : 'kz-row-hover'
              }`}
              style={{ color: activeSection === section.id ? 'var(--ink)' : 'var(--ink-soft)' }}
            >
              <span className="flex-shrink-0">{section.icon}</span>
              <span style={{ fontSize: 13 }}>{t.help[section.titleKey]}</span>
            </button>
          ))}
        </div>

        {/* Right: content */}
        <div className="flex-1 overflow-y-auto scroll p-8">
          {activeContent && (
            <div className="kz-prose help-prose" style={{ maxWidth: 'none' }}>
              <Markdown remarkPlugins={[remarkGfm]}>
                {activeContent.content[lang]}
              </Markdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
