/**
 * Chinese (zh) string table for backend i18n.
 * Terminology: "内容" (content) replaces "录音" (recording) throughout.
 */
export const zh: Record<string, string | ((...args: any[]) => string)> = {
  // ─── RAG: Query Engine ────────────────────────────────────
  'rag.system_prompt': '你是内容记忆助手，基于用户的内容数据回答问题。',
  'rag.system_rules': '要求：基于数据回答，不编造；中文回答；按主题分要点；简洁实用。',
  'rag.user_prompt_header': '以下是从用户内容数据中检索到的相关信息：',
  'rag.user_prompt_footer': '请根据以上信息回答：',
  'rag.user_question': (q: string) => `用户问题：${q}`,
  'rag.section_temporal': (start: string, end: string) => `## ${start} ~ ${end} 的内容`,
  'rag.section_semantic': '## 语义相关片段',
  'rag.section_recent': '## 最近的内容',
  'rag.section_daily': '## 日报摘要',
  'rag.section_items': '## 提取的行动项',
  'rag.section_sources': '## 内容来源',
  'rag.no_data': '（暂无相关内容数据）',
  'rag.no_summary': '(无摘要)',
  'rag.label_todos': '### 待办事项',
  'rag.label_decisions': '### 重要决策',
  'rag.section_todos': '待办',
  'rag.section_decisions': '决策',
  'rag.rerank_system': '你是相关性评分器。仅返回一个 JSON 整数数组（0-10 分）。不要解释。',
  'rag.truncated': (total: number, included: number) => `（共 ${total} 段，已包含 ${included} 段）`,
  'rag.truncated_all': (total: number) => `（共 ${total} 段）`,

  // ─── Agent: Executor ──────────────────────────────────────
  'agent.intent_system': `判断用户消息的意图类型，仅输出JSON。
类型说明：
- chat: 普通对话、问候、询问助手信息、闲聊、感谢
- knowledge: 查询过去内容、询问某人/某公司/某事件发生了什么、历史对话记录
- items: 创建/完成/删除/查询 待办、备忘录、提醒事项
- memory: 记住某事、更新记忆、查看已记录的记忆
- report: 生成日报、周报、总结
- email: 发送邮件、给某人发邮件
- web: 搜索网页、查询实时信息、新闻、天气、价格
- document: 创建PPT/Word/PDF文档、读取PDF、发送文件给用户
- all: 意图不明确或涉及多个类别

输出格式: {"intent":"chat|knowledge|items|memory|report|email|web|document|all"}`,

  'agent.chat_system': '你是一个智能助手，用中文自然友好地回复用户。',
  'agent.tool_system': `你是一个智能助手，能够通过调用工具来帮助用户完成任务。

重要能力说明：
- 你可以生成PPT/Word文档并自动发送给用户（create_pptx/create_docx）
- 你可以发送已有文件给用户（send_file）
- 你可以搜索网页获取实时信息（web_search/web_fetch）
- 你可以发送邮件（send_email）
- 你可以读取PDF文件（read_pdf）
- 不要声称自己"无法"做上述任何事情，直接调用工具即可。`,
  'agent.tool_rules': `## 响应规则
1. 你必须以 JSON 格式回复，不要输出其他任何内容。
2. 当用户请求匹配以下场景时，你必须调用对应工具，禁止仅回复文字：
   - 制作/创建/生成 PPT/幻灯片/演示文稿 → create_pptx
   - 制作/创建/生成 Word/文档 → create_docx
   - 读取/分析/总结 PDF → read_pdf
   - 发送/传输 文件 → send_file
   - 搜索/查找/最新 信息/新闻/天气 → web_search
   - 查看/打开 网页/链接 → web_fetch
   - 发送/写 邮件 → send_email
   - 创建/添加 待办/提醒 → create_todo / set_reminder
   - 生成 日报/周报/报告 → generate_report
   - 查询 知识库/过去说过什么 → query_knowledge
3. 调用工具格式: {"action":"工具名","params":{...参数...}}
4. 仅当用户请求不涉及任何工具能力时（如闲聊、问候），才用: {"action":"respond","text":"..."}
5. 收到工具执行结果后，基于结果生成简洁友好的回复: {"action":"respond","text":"..."}
6. 每次只能输出一个 JSON 对象。
7. 回复使用中文，语气自然简洁。不要长篇大论地解释你的能力边界。
8. 如果工具调用失败，简短说明并建议重试。`,

  // Native tool calling prompts (used when LLM supports /api/chat with tools)
  'agent.tool_system_native': `你是一个智能助手，能够通过工具帮助用户完成各种任务。
你可以生成文档、搜索网页、发送文件和邮件、管理待办事项、查询知识库等。
当用户的请求可以通过工具完成时，直接调用工具，不要说"我无法"或解释能力限制。
当用户要求截图、截屏或查看网页外观时，使用 screenshot_webpage 工具传入 URL 即可获取截图。`,
  'agent.tool_rules_native': `## 行为准则
1. 当用户请求匹配工具能力时，必须调用工具，不要仅回复文字。
2. 收到工具执行结果后，基于结果简洁回复用户。
3. 回复使用中文，语气自然简洁。
4. 如果工具调用失败，简短说明原因。`,

  'agent.available_tools': '## 可用工具',
  'agent.no_tools': '当前没有可用工具。',
  'agent.current_time': '## 当前时间',
  'agent.skills_section': '## 专业技能',
  'agent.history_section': '## 对话历史',
  'agent.user_label': '用户',
  'agent.assistant_label': '助手',
  'agent.scratchpad_section': '## 工具调用记录',
  'agent.scratchpad_reply': '请根据以上工具调用结果，生成最终回复。使用 {"action":"respond","text":"..."} 格式。',
  'agent.tool_call': (name: string, params: string) => `工具调用: ${name}(${params})`,
  'agent.observation': (result: string) => `观察结果: ${result}`,
  'agent.success': '操作成功',
  'agent.error': (err: string) => `错误: ${err}`,
  'agent.fallback_sorry': '抱歉，我暂时无法处理这个请求。',
  'agent.model_unavailable': '抱歉，AI 模型暂时不可用，请检查模型配置后重试。',
  'agent.ok': '好的。',
  'agent.done': '已完成操作。',
  'agent.done_no_summary': '已完成操作，但无法生成总结。',
  'agent.max_iter_notice': '注意：你已经使用了多次工具调用。现在你必须用 {"action":"respond","text":"..."} 输出最终回复，不能再调用工具。',

  // ─── Tool: create_todo ────────────────────────────────────
  'tool.create_todo.desc': '创建一条待办事项。当用户提到需要做某事、别忘了、记得、提醒我、帮我记一下等意图时使用。',
  'tool.create_todo.param_content': '待办内容',
  'tool.create_todo.param_due_date': '截止日期，YYYY-MM-DD 格式（可选）',
  'tool.create_todo.param_priority': '优先级（可选，默认 normal）',
  'tool.create_todo.param_assignee': '负责人（可选）',
  'tool.create_todo.param_remind_at': '提醒时间，YYYY-MM-DD HH:mm 格式（可选）',
  'tool.create_todo.success': (content: string) => `已创建待办：${content}`,
  'tool.create_todo.error': (err: string) => `创建待办失败：${err}`,

  // ─── Tool: complete_todo ──────────────────────────────────
  'tool.complete_todo.desc': '将待办事项标记为已完成。当用户说"做完了"、"已完成"、"搞定了"等意图时使用。支持按 ID 或内容模糊匹配。',
  'tool.complete_todo.param_todo_id': '待办事项 ID（优先使用）',
  'tool.complete_todo.param_content_match': '待办内容关键词，用于模糊匹配（当没有 ID 时使用）',
  'tool.complete_todo.success': (id: number) => `已完成待办 #${id}`,
  'tool.complete_todo.success_by_content': (content: string) => `已完成待办：${content}`,
  'tool.complete_todo.not_found': (kw: string) => `未找到匹配"${kw}"的待办事项`,
  'tool.complete_todo.ambiguous': (list: string) => `找到多条匹配的待办，请指定 ID：\n${list}`,
  'tool.complete_todo.missing_param': '请提供 todo_id 或 content_match',
  'tool.complete_todo.error': (err: string) => `完成待办失败：${err}`,

  // ─── Tool: delete_items ───────────────────────────────────
  'tool.delete_items.desc': '删除事项（待办/备忘/决策/联系人等）。支持三种模式：\n- 按 ID 删除单条：提供 item_id\n- 按内容关键词匹配删除：提供 content_match\n- 按类型批量删除：提供 item_type（如 "删除所有备忘"、"清空待办"）\n可组合使用 item_type + content_match 进一步筛选。',
  'tool.delete_items.param_item_id': '按 ID 删除单条（优先级最高）',
  'tool.delete_items.param_item_type': '按类型筛选（all 表示所有类型）',
  'tool.delete_items.param_content_match': '按内容关键词模糊匹配',
  'tool.delete_items.param_status': '按状态筛选（可选，默认 all）',
  'tool.delete_items.success_single': (id: number) => `已删除条目 #${id}`,
  'tool.delete_items.success_batch': (count: number) => `已删除 ${count} 条事项`,
  'tool.delete_items.not_found': '没有找到匹配的条目',
  'tool.delete_items.error': (err: string) => `删除失败：${err}`,

  // ─── Tool: list_items ─────────────────────────────────────
  'tool.list_items.desc': '列出事项（待办/备忘/决策/联系人等）。当用户问"有哪些待办"、"查看备忘"、"列出所有事项"等意图时使用。',
  'tool.list_items.param_item_type': '事项类型（可选，默认 all）',
  'tool.list_items.param_status': '筛选状态（可选，默认 active）',
  'tool.list_items.param_content_match': '按内容关键词模糊匹配（可选）',
  'tool.list_items.success': (count: number) => `共 ${count} 条事项`,
  'tool.list_items.empty': '暂无匹配事项',
  'tool.list_items.error': (err: string) => `查询事项失败：${err}`,

  // ─── Tool: create_memo ────────────────────────────────────
  'tool.create_memo.desc': '创建一条备忘录/笔记。当用户说"记一下"、"备忘"、"帮我存个笔记"等意图时使用。与待办不同，备忘录没有截止日期。',
  'tool.create_memo.param_content': '备忘内容',
  'tool.create_memo.success': (content: string) => `已创建备忘：${content}`,
  'tool.create_memo.error': (err: string) => `创建备忘失败：${err}`,

  // ─── Tool: generate_report ────────────────────────────────
  'tool.generate_report.desc': '生成日报或周报。当用户说"给我生成今天的日报"、"本周总结"、"帮我写周报"等意图时使用。',
  'tool.generate_report.param_type': '报告类型：daily（日报）或 weekly（周报）',
  'tool.generate_report.param_date': '日期，YYYY-MM-DD 格式（可选，默认今天；周报时为本周内任意一天）',
  'tool.generate_report.no_optimizer': 'TextOptimizer 未初始化，无法生成报告',
  'tool.generate_report.no_data': (date: string) => `${date} 没有内容数据，无法生成日报`,
  'tool.generate_report.daily_done': (date: string) => `${date} 日报已生成`,
  'tool.generate_report.no_weekly_data': (start: string, end: string) => `${start} ~ ${end} 无日报数据，无法生成周报。请先生成每日日报。`,
  'tool.generate_report.weekly_done': (start: string, end: string) => `${start} ~ ${end} 周报已生成`,
  'tool.generate_report.unsupported_type': (type: string) => `不支持的报告类型：${type}`,
  'tool.generate_report.error': (err: string) => `生成报告失败：${err}`,

  // ─── Tool: query_knowledge ────────────────────────────────
  'tool.query_knowledge.desc': '从内容库中检索信息。当用户询问过往内容中的信息、某次会议说了什么、某人提到的细节等时使用。基于 RAG 语义检索。',
  'tool.query_knowledge.param_question': '要查询的问题',
  'tool.query_knowledge.no_engine': 'QueryEngine 未初始化，无法查询知识库',
  'tool.query_knowledge.error': (err: string) => `知识库查询失败：${err}`,

  // ─── Tool: update_memory ──────────────────────────────────
  'tool.update_memory.desc': '向长期记忆中添加一条事实。当用户说"记住"、"以后都这样"、"我的偏好是"、"我叫XXX"等涉及持久化信息时使用。',
  'tool.update_memory.param_fact': '要记住的事实',
  'tool.update_memory.param_category': '分类（可选，默认 other）',
  'tool.update_memory.no_manager': 'MemoryManager 未初始化，无法更新记忆',
  'tool.update_memory.success': (fact: string) => `已记住：${fact}`,
  'tool.update_memory.error': (err: string) => `更新记忆失败：${err}`,

  // ─── Tool: list_memories ──────────────────────────────────
  'tool.list_memories.desc': '列出已存储的长期记忆。当用户问"你还记得什么"、"我之前跟你说过什么"、"查看记忆"等意图时使用。',
  'tool.list_memories.param_query': '关键词过滤（可选，对记忆内容模糊匹配）',
  'tool.list_memories.param_category': '按分类过滤（可选）',
  'tool.list_memories.success': (count: number) => `共 ${count} 条记忆`,
  'tool.list_memories.empty': '暂无匹配的记忆',
  'tool.list_memories.error': (err: string) => `查询记忆失败：${err}`,

  // ─── Tool: search_recordings ──────────────────────────────
  'tool.search_recordings.desc': '在内容库文本中搜索关键词。当用户问"我什么时候提到过XX"、"搜索内容里关于XX的部分"等意图时使用。基于全文索引搜索。',
  'tool.search_recordings.param_keyword': '搜索关键词',
  'tool.search_recordings.param_limit': '返回结果数量上限（可选，默认 10）',
  'tool.search_recordings.success': (total: number, shown: number) => `找到 ${total} 条结果（显示前 ${shown} 条）`,
  'tool.search_recordings.not_found': (kw: string) => `未找到包含"${kw}"的内容`,
  'tool.search_recordings.error': (err: string) => `搜索内容失败：${err}`,

  // ─── Tool: lookup_person ──────────────────────────────────
  'tool.lookup_person.desc': '按名字查找人物信息。当用户问"XX是谁"、"XX是什么人"、"告诉我XX的信息"等关于人物的问题时使用。返回人物基本信息、相关内容和人际关系。',
  'tool.lookup_person.param_name': '人物姓名（支持模糊匹配）',
  'tool.lookup_person.not_found': (name: string) => `未找到名为"${name}"的人物`,
  'tool.lookup_person.error': (err: string) => `查找人物失败：${err}`,

  // ─── Tool: set_reminder ───────────────────────────────────
  'tool.set_reminder.desc': '设置一个定时提醒（仅发送提醒文本，不执行AI操作）。适用于"提醒我明天下午3点开会"、"每天早上8点提醒我吃药"等场景。注意：如果用户要求AI到时候"做"某件事（如讲笑话、写故事、生成内容），应使用 create_scheduled_task（task_type=prompt）而非此工具。',
  'tool.set_reminder.param_content': '纯提醒内容（不含时间部分）。例如用户说"3分钟后提醒我喝咖啡"，content应为"喝咖啡"而非"3分钟后提醒我喝咖啡"',
  'tool.set_reminder.param_schedule': '自然语言时间描述，如"3分钟后"、"明天下午3点"、"每天早上8点"、"每周一三五早上8点"',
  'tool.set_reminder.success': (content: string, display: string) => `已设置提醒：${content}（${display}）`,
  'tool.set_reminder.error': (err: string) => `设置提醒失败：${err}`,

  // ─── Tool: list_reminders ─────────────────────────────────
  'tool.list_reminders.desc': '列出待触发的提醒。当用户问"有哪些提醒"、"我设了什么闹钟"等意图时使用。',
  'tool.list_reminders.param_include_sent': '是否包含已发送的提醒（可选，默认 false）',
  'tool.list_reminders.success_all': (count: number) => `共 ${count} 条提醒（含已发送）`,
  'tool.list_reminders.success': (count: number) => `共 ${count} 条待触发提醒`,
  'tool.list_reminders.empty': '暂无待触发提醒',
  'tool.list_reminders.empty_all': '暂无提醒',
  'tool.list_reminders.error': (err: string) => `查询提醒失败：${err}`,

  // ─── Tool: create_scheduled_task ──────────────────────────
  'tool.create_scheduled_task.desc': '创建定时任务，到时间后AI会执行action并将结果发送给用户。适用于：1) 用户要求AI在未来某个时间做某事（如"2分钟后讲个笑话"、"明天早上给我写一段励志语"）→ task_type=prompt；2) 定期执行预定义操作（如"每天生成日报"）→ task_type=predefined。',
  'tool.create_scheduled_task.param_name': '任务名称',
  'tool.create_scheduled_task.param_task_type': '任务类型：predefined（预定义动作）或 prompt（自由 prompt）',
  'tool.create_scheduled_task.param_action': '对于 predefined 类型：动作标识（daily_report/weekly_report/insight_scan/todo_reminder/todo_summary）。对于 prompt 类型：写一个详细的执行指令，不要只复述用户原话，要补充具体要求，例如用户说"讲个笑话"，action 应写为"请讲一个轻松幽默的中文笑话，字数100字以内"',
  'tool.create_scheduled_task.param_schedule': '自然语言时间描述，如"每天早上9点"、"每周一下午2点"、"每30分钟"',
  'tool.create_scheduled_task.param_permission_level': '权限级别（可选，默认 readonly）',
  'tool.create_scheduled_task.success': (name: string, display: string) => `已创建定时任务「${name}」，${display}执行`,
  'tool.create_scheduled_task.error': (err: string) => `创建定时任务失败：${err}`,

  // ─── Tool: list_scheduled_tasks ───────────────────────────
  'tool.list_scheduled_tasks.desc': '查看定时任务列表。当用户问"有哪些定时任务"、"我设了什么定时"等意图时使用。',
  'tool.list_scheduled_tasks.param_status': '按状态过滤（可选，默认 active）',
  'tool.list_scheduled_tasks.success': (count: number) => `共 ${count} 个定时任务`,
  'tool.list_scheduled_tasks.empty': '暂无定时任务',
  'tool.list_scheduled_tasks.error': (err: string) => `查询定时任务失败：${err}`,

  // ─── Tool: manage_scheduled_task ──────────────────────────
  'tool.manage_scheduled_task.desc': '管理定时任务（暂停/恢复/删除）。当用户说"暂停那个每日总结"、"删除定时任务"等意图时使用。',
  'tool.manage_scheduled_task.param_id': '定时任务 ID',
  'tool.manage_scheduled_task.param_operation': '操作类型：pause（暂停）、resume（恢复）、delete（删除）',
  'tool.manage_scheduled_task.not_found': (id: number) => `未找到 ID 为 ${id} 的定时任务`,
  'tool.manage_scheduled_task.paused': (name: string) => `已暂停定时任务「${name}」`,
  'tool.manage_scheduled_task.resumed': (name: string) => `已恢复定时任务「${name}」`,
  'tool.manage_scheduled_task.deleted': (name: string) => `已删除定时任务「${name}」`,
  'tool.manage_scheduled_task.unsupported_op': (op: string) => `不支持的操作：${op}`,
  'tool.manage_scheduled_task.error': (err: string) => `管理定时任务失败：${err}`,

  // ─── Tool: send_email ─────────────────────────────────────
  'tool.send_email.desc': '发送邮件。当用户说"发邮件"、"给我发邮件"、"邮件通知"等意图时使用。不需要问用户收件人——"给我发"就是发到用户自己的邮箱（系统已配置）。主题可以根据内容自动生成，不必问用户。直接调用即可。重要：content 应该是一封完整、有温度的邮件正文，不要只写几个字。根据用户意图创作合适的邮件内容，包含问候、正文、落款，语气自然真诚。',
  'tool.send_email.param_to': '收件人邮箱地址（可选，不填则发到用户自己的邮箱）',
  'tool.send_email.param_subject': '邮件主题（可选，不填则从正文自动生成）',
  'tool.send_email.param_content': '邮件正文内容',
  'tool.send_email.not_enabled': '邮箱未启用，请先在设置中开启并配置邮箱',
  'tool.send_email.no_router': '消息路由未初始化，请稍后再试',
  'tool.send_email.no_recipient': '未指定收件人，且设置中无默认邮箱地址',
  'tool.send_email.success': (recipient: string) => `邮件已发送至 ${recipient}`,
  'tool.send_email.error': (err: string) => `发送邮件失败：${err}`,

  // ── create_pptx ──
  'tool.create_pptx.desc': '创建 PowerPoint 演示文稿（.pptx）并自动发送给用户。当用户要求制作 PPT、幻灯片、演示文稿时直接调用此工具，生成后文件会自动通过当前消息渠道发送给用户，无需额外操作。',
  'tool.create_pptx.param_title': '演示文稿标题',
  'tool.create_pptx.param_slides': '幻灯片内容数组，每项包含 title（标题）和 bullets（要点数组）',
  'tool.create_pptx.param_filename': '输出文件名（可选，不含后缀）',
  'tool.create_pptx.success': (path: string) => `PPT 已生成：${path}`,
  'tool.create_pptx.error': (err: string) => `创建 PPT 失败：${err}`,

  // ── create_docx ──
  'tool.create_docx.desc': '创建 Word 文档（.docx）并自动发送给用户。当用户要求写文档、生成 Word、导出文档时直接调用此工具，生成后文件会自动通过当前消息渠道发送给用户，无需额外操作。',
  'tool.create_docx.param_title': '文档标题',
  'tool.create_docx.param_content': '文档正文内容（Markdown 格式，支持 # 标题、- 列表、段落）',
  'tool.create_docx.param_filename': '输出文件名（可选，不含后缀）',
  'tool.create_docx.success': (path: string) => `Word 文档已生成：${path}`,
  'tool.create_docx.error': (err: string) => `创建文档失败：${err}`,

  // ── read_pdf ──
  'tool.read_pdf.desc': '读取 PDF 文件内容。当用户要求读取、分析、总结 PDF 文件时使用。提取 PDF 中的文本内容。',
  'tool.read_pdf.param_file_path': 'PDF 文件的完整路径',
  'tool.read_pdf.param_max_pages': '最多读取的页数（可选，默认全部）',
  'tool.read_pdf.success': (pages: number, chars: number) => `成功读取 PDF：${pages} 页，${chars} 字符`,
  'tool.read_pdf.not_found': (path: string) => `文件不存在：${path}`,
  'tool.read_pdf.error': (err: string) => `读取 PDF 失败：${err}`,

  // ── send_file ──
  'tool.send_file.desc': '发送文件给用户。当用户要求"把文件发给我"、"发过来"、"传给我"时使用。直接调用即可，文件会自动通过当前消息渠道发送。',
  'tool.send_file.param_file_path': '要发送的文件完整路径',
  'tool.send_file.success': (name: string) => `文件 ${name} 已发送给用户`,
  'tool.send_file.not_found': (path: string) => `文件不存在：${path}`,
  'tool.send_file.no_channel': '当前不在消息渠道中，无法发送文件',
  'tool.send_file.error': (err: string) => `发送文件失败：${err}`,

  // ── create_pdf ──
  'tool.create_pdf.desc': '创建 PDF 文档并自动发送给用户。当用户要求生成 PDF、导出 PDF 时直接调用此工具。',
  'tool.create_pdf.param_title': '文档标题',
  'tool.create_pdf.param_content': '文档正文内容（Markdown 格式）',
  'tool.create_pdf.param_style': '文档风格：business（正式）或 casual（轻松）',
  'tool.create_pdf.param_filename': '输出文件名（可选，不含后缀）',
  'tool.create_pdf.success': (path: string) => `PDF 已生成：${path}`,
  'tool.create_pdf.error': (err: string) => `创建 PDF 失败：${err}`,

  // ─── Memory: Doc Generator ────────────────────────────────
  'memory.doc_empty': (_date: string) => `### 主线\n\n> 当天没有录音内容。\n\n### 未解\n\n`,
  'memory.doc_prompt': `你是一个个人记忆整理助手。根据以下当天的内容数据，生成一份编辑式、可读性强的 Markdown 记忆文档。

风格要求：
- 像在写"今日记忆"日记，不要罗列录音清单
- 不要输出日期标题（页面已显示日期）
- 不要使用 H1 / H2 标题，仅用 H3（###）作为章节标题
- 章节标题严格使用提供的 4 个：主线 / 新结识 · 新提及 / 决策 & 偏好 / 未解
- 关键决策、引语用 > 引用块（会被渲染成赭石色 blockquote）
- 人名、项目名、关键词用 **加粗** 强调
- 列表用 - 项目符号，每条一句话`,
  'memory.doc_section_summary': '### 主线',
  'memory.doc_section_summary_hint': '（用 1-2 段编辑式叙述梳理今天的主轴：围绕什么主题展开、核心结论是什么。关键词加粗）',
  'memory.doc_section_facts': '### 新结识 · 新提及',
  'memory.doc_section_facts_hint': '（列出新提及的人物 / 项目 / 概念。例：- **微信公众号** · 重点频道 — 接下来一周的发布主战场）',
  'memory.doc_section_todos': '### 决策 & 偏好',
  'memory.doc_section_todos_hint': '（重要决策、明确表态用 > 引用对方原话或核心结论；其余待办用列表）',
  'memory.doc_section_emotion': '### 情绪',
  'memory.doc_section_emotion_hint': '（一句话概括当天整体情绪倾向）',
  'memory.doc_section_notes': '### 未解',
  'memory.doc_section_notes_hint': '（列出仍未解决 / 待确认 / 待回复的事项）',
  'memory.ctx_date': (date: string) => `日期: ${date}`,
  'memory.ctx_count': (count: number) => `内容数: ${count}`,
  'memory.ctx_list': '### 内容列表:',
  'memory.ctx_segments': '### 语音片段 (前20条):',
  'memory.ctx_items': '### 提取事项:',
  'memory.ctx_daily_summary': '### 每日摘要:',

  // ─── Memory: Extractor ────────────────────────────────────
  'memory.extract_prompt': `从以下会议/对话文本中提取值得长期记住的事实信息。

提取类型：
- person: 人物信息（姓名、职位、联系方式、特征）
- business: 业务信息（目标、数字、日期、项目状态）
- preference: 用户偏好（习惯、喜好、工作方式）
- relationship: 人物关系（谁和谁的关系、合作关系）
- general: 其他重要事实

要求：
- 只提取明确陈述的事实，不推测
- 每条事实独立完整，不依赖上下文
- 忽略闲聊、寒暄、重复内容
- confidence: 1.0=明确陈述, 0.7=较确定推断, 0.5=可能

输出 JSON:
{"facts": [{"fact": "...", "category": "...", "confidence": 0.9}]}

文本：
{{text}}`,

  // ─── Pipeline: Diarization ──────────────────────────────────
  'diarization_method': '说话人分离方法',
  'diarization_method_embedding': '嵌入聚类（推荐）',
  'diarization_method_legacy': '传统方法',

  // ─── Notify ───────────────────────────────────────────────
  'notify.processing_complete': '处理完成',
  'notify.processing_complete_body': (name: string) => `${name} 已就绪`,
  'notify.live_complete': '内容处理完成',
  'notify.live_complete_body': (id: number) => `实时录制 #${id} 后处理完成`,
};
