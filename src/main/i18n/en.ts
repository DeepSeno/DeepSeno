/**
 * English (en) string table for backend i18n.
 * Terminology: "content" replaces "recording" throughout.
 */
export const en: Record<string, string | ((...args: any[]) => string)> = {
  // ─── RAG: Query Engine ────────────────────────────────────
  'rag.system_prompt': 'You are a content memory assistant that answers questions based on the user\'s content data.',
  'rag.system_rules': 'Requirements: answer based on data, do not fabricate; answer in English; organize by topic; be concise and practical.',
  'rag.user_prompt_header': 'The following is relevant information retrieved from the user\'s content data:',
  'rag.user_prompt_footer': 'Please answer based on the information above:',
  'rag.user_question': (q: string) => `User question: ${q}`,
  'rag.section_temporal': (start: string, end: string) => `## Content from ${start} to ${end}`,
  'rag.section_semantic': '## Semantically Relevant Segments',
  'rag.section_recent': '## Recent Content',
  'rag.section_daily': '## Daily Summaries',
  'rag.section_items': '## Extracted Action Items',
  'rag.section_sources': '## Content Sources',
  'rag.no_data': '(No relevant content data available)',
  'rag.no_summary': '(No summary)',
  'rag.label_todos': '### To-Do Items',
  'rag.label_decisions': '### Key Decisions',
  'rag.section_todos': 'To-dos',
  'rag.section_decisions': 'Decisions',
  'rag.rerank_system': 'You are a relevance scorer. Return ONLY a JSON array of integer scores 0-10. No explanation.',
  'rag.truncated': (total: number, included: number) => `(${total} total segments, ${included} included)`,
  'rag.truncated_all': (total: number) => `(${total} segments)`,

  // ─── Agent: Executor ──────────────────────────────────────
  'agent.intent_system': `Classify the user's message intent. Output JSON only.
Intent types:
- chat: casual conversation, greetings, asking about the assistant, small talk, thanks
- knowledge: querying past content, asking about a person/company/event, historical conversation records
- items: create/complete/delete/query to-dos, memos, reminders
- memory: remember something, update memory, view stored memories
- report: generate daily or weekly reports, summaries
- email: send an email
- web: search the web, query real-time info, news, weather, prices
- document: create a PPT/Word/PDF document, read a PDF, or send a file to the user
- all: unclear intent or spanning multiple categories

Output format: {"intent":"chat|knowledge|items|memory|report|email|web|document|all"}`,

  'agent.chat_system': 'You are a helpful assistant. Reply naturally and friendly in English.',
  'agent.tool_system': `You are an intelligent assistant that helps users by calling tools.

Key capabilities:
- You CAN generate PPT/Word files and auto-send to users (create_pptx/create_docx)
- You CAN send existing files to users (send_file)
- You CAN search the web for real-time info (web_search/web_fetch)
- You CAN send emails (send_email)
- You CAN read PDF files (read_pdf)
- NEVER claim you "cannot" do any of the above. Just call the tool.`,
  'agent.tool_rules': `## Response Rules
1. You must reply in JSON format only.
2. When the user's request matches a tool capability, you MUST call the tool. Do NOT just respond with text:
   - Create/make PPT/slides → create_pptx
   - Create/write Word/document → create_docx
   - Read/analyze PDF → read_pdf
   - Send/transfer a file → send_file
   - Search/find latest info/news → web_search
   - Open/view a web page → web_fetch
   - Send/write email → send_email
   - Create todo/reminder → create_todo / set_reminder
   - Generate report → generate_report
   - Query knowledge base → query_knowledge
3. Tool call format: {"action":"tool_name","params":{...}}
4. ONLY use {"action":"respond","text":"..."} when the request doesn't match ANY tool (e.g. greetings, small talk).
5. After tool results, reply concisely based on results: {"action":"respond","text":"..."}
6. One JSON object per response.
7. Keep replies brief and natural. Do not over-explain your capabilities.
8. If a tool fails, briefly explain and suggest retry.`,

  // Native tool calling prompts
  'agent.tool_system_native': `You are an intelligent assistant that helps users by calling tools.
You can generate documents, search the web, send files/emails, manage todos, query knowledge, and more.
When the user's request can be fulfilled by a tool, call it directly. Never say "I cannot" or explain capability limitations.
When the user asks for a screenshot or to see a webpage, use the screenshot_webpage tool with the URL.`,
  'agent.tool_rules_native': `## Behavior
1. When the user's request matches a tool capability, you MUST call the tool.
2. After tool results, reply concisely based on results.
3. Keep replies brief and natural.
4. If a tool fails, briefly explain.`,

  'agent.available_tools': '## Available Tools',
  'agent.no_tools': 'No tools available.',
  'agent.current_time': '## Current Time',
  'agent.skills_section': '## Skills',
  'agent.history_section': '## Conversation History',
  'agent.user_label': 'User',
  'agent.assistant_label': 'Assistant',
  'agent.scratchpad_section': '## Tool Call Log',
  'agent.scratchpad_reply': 'Based on the tool call results above, generate a final reply. Use {"action":"respond","text":"..."} format.',
  'agent.tool_call': (name: string, params: string) => `Tool call: ${name}(${params})`,
  'agent.observation': (result: string) => `Observation: ${result}`,
  'agent.success': 'Operation successful',
  'agent.error': (err: string) => `Error: ${err}`,
  'agent.fallback_sorry': 'Sorry, I am unable to process this request right now.',
  'agent.model_unavailable': 'Sorry, the AI model is currently unavailable. Please check the model configuration and try again.',
  'agent.ok': 'OK.',
  'agent.done': 'Operation completed.',
  'agent.done_no_summary': 'Operation completed, but unable to generate a summary.',
  'agent.max_iter_notice': 'Note: You have used multiple tool calls. You must now output your final reply with {"action":"respond","text":"..."} and cannot call any more tools.',

  // ─── Tool: create_todo ────────────────────────────────────
  'tool.create_todo.desc': 'Create a to-do item. Use when the user mentions needing to do something, don\'t forget, remember to, remind me, take note, etc.',
  'tool.create_todo.param_content': 'To-do content',
  'tool.create_todo.param_due_date': 'Due date in YYYY-MM-DD format (optional)',
  'tool.create_todo.param_priority': 'Priority (optional, defaults to normal)',
  'tool.create_todo.param_assignee': 'Assignee (optional)',
  'tool.create_todo.param_remind_at': 'Reminder time in YYYY-MM-DD HH:mm format (optional)',
  'tool.create_todo.success': (content: string) => `Created to-do: ${content}`,
  'tool.create_todo.error': (err: string) => `Failed to create to-do: ${err}`,

  // ─── Tool: complete_todo ──────────────────────────────────
  'tool.complete_todo.desc': 'Mark a to-do item as completed. Use when the user says "done", "finished", "completed", etc. Supports matching by ID or fuzzy content match.',
  'tool.complete_todo.param_todo_id': 'To-do item ID (preferred)',
  'tool.complete_todo.param_content_match': 'Keyword for fuzzy matching to-do content (used when no ID is provided)',
  'tool.complete_todo.success': (id: number) => `Completed to-do #${id}`,
  'tool.complete_todo.success_by_content': (content: string) => `Completed to-do: ${content}`,
  'tool.complete_todo.not_found': (kw: string) => `No to-do item matching "${kw}" was found`,
  'tool.complete_todo.ambiguous': (list: string) => `Multiple matching to-dos found. Please specify an ID:\n${list}`,
  'tool.complete_todo.missing_param': 'Please provide todo_id or content_match',
  'tool.complete_todo.error': (err: string) => `Failed to complete to-do: ${err}`,

  // ─── Tool: delete_items ───────────────────────────────────
  'tool.delete_items.desc': 'Delete items (to-dos/memos/decisions/contacts). Supports three modes:\n- Delete by ID: provide item_id\n- Delete by content keyword: provide content_match\n- Batch delete by type: provide item_type (e.g. "delete all memos", "clear to-dos")\nCan combine item_type + content_match for further filtering.',
  'tool.delete_items.param_item_id': 'Delete a single item by ID (highest priority)',
  'tool.delete_items.param_item_type': 'Filter by type (all means all types)',
  'tool.delete_items.param_content_match': 'Fuzzy match by content keyword',
  'tool.delete_items.param_status': 'Filter by status (optional, defaults to all)',
  'tool.delete_items.success_single': (id: number) => `Deleted item #${id}`,
  'tool.delete_items.success_batch': (count: number) => `Deleted ${count} item(s)`,
  'tool.delete_items.not_found': 'No matching items found',
  'tool.delete_items.error': (err: string) => `Failed to delete: ${err}`,

  // ─── Tool: list_items ─────────────────────────────────────
  'tool.list_items.desc': 'List items (to-dos/memos/decisions/contacts/numbers). Use when the user asks "what to-dos do I have", "show memos", "list all items", etc.',
  'tool.list_items.param_item_type': 'Item type (optional, defaults to all)',
  'tool.list_items.param_status': 'Filter by status (optional, defaults to active)',
  'tool.list_items.param_content_match': 'Fuzzy match by content keyword (optional)',
  'tool.list_items.success': (count: number) => `${count} item(s) found`,
  'tool.list_items.empty': 'No matching items',
  'tool.list_items.error': (err: string) => `Failed to query items: ${err}`,

  // ─── Tool: create_memo ────────────────────────────────────
  'tool.create_memo.desc': 'Create a memo/note. Use when the user says "take a note", "memo", "save a note", etc. Unlike to-dos, memos have no due date.',
  'tool.create_memo.param_content': 'Memo content',
  'tool.create_memo.success': (content: string) => `Created memo: ${content}`,
  'tool.create_memo.error': (err: string) => `Failed to create memo: ${err}`,

  // ─── Tool: generate_report ────────────────────────────────
  'tool.generate_report.desc': 'Generate a daily or weekly report. Use when the user asks for "today\'s daily report", "weekly summary", "write a weekly report", etc.',
  'tool.generate_report.param_type': 'Report type: daily or weekly',
  'tool.generate_report.param_date': 'Date in YYYY-MM-DD format (optional, defaults to today; for weekly, any date within the week)',
  'tool.generate_report.no_optimizer': 'TextOptimizer not initialized, cannot generate report',
  'tool.generate_report.no_data': (date: string) => `No content data for ${date}, cannot generate daily report`,
  'tool.generate_report.daily_done': (date: string) => `Daily report for ${date} generated`,
  'tool.generate_report.no_weekly_data': (start: string, end: string) => `No daily report data for ${start} ~ ${end}. Please generate daily reports first.`,
  'tool.generate_report.weekly_done': (start: string, end: string) => `Weekly report for ${start} ~ ${end} generated`,
  'tool.generate_report.unsupported_type': (type: string) => `Unsupported report type: ${type}`,
  'tool.generate_report.error': (err: string) => `Failed to generate report: ${err}`,

  // ─── Tool: query_knowledge ────────────────────────────────
  'tool.query_knowledge.desc': 'Retrieve information from the content library. Use when the user asks about past content, what was said in a meeting, details someone mentioned, etc. Uses RAG semantic search.',
  'tool.query_knowledge.param_question': 'The question to query',
  'tool.query_knowledge.no_engine': 'QueryEngine not initialized, cannot query knowledge base',
  'tool.query_knowledge.error': (err: string) => `Knowledge base query failed: ${err}`,

  // ─── Tool: update_memory ──────────────────────────────────
  'tool.update_memory.desc': 'Add a fact to long-term memory. Use when the user says "remember", "always do it this way", "my preference is", "my name is", etc.',
  'tool.update_memory.param_fact': 'The fact to remember',
  'tool.update_memory.param_category': 'Category (optional, defaults to other)',
  'tool.update_memory.no_manager': 'MemoryManager not initialized, cannot update memory',
  'tool.update_memory.success': (fact: string) => `Remembered: ${fact}`,
  'tool.update_memory.error': (err: string) => `Failed to update memory: ${err}`,

  // ─── Tool: list_memories ──────────────────────────────────
  'tool.list_memories.desc': 'List stored long-term memories. Use when the user asks "what do you remember", "what have I told you", "show memories", etc.',
  'tool.list_memories.param_query': 'Keyword filter (optional, fuzzy match on memory content)',
  'tool.list_memories.param_category': 'Filter by category (optional)',
  'tool.list_memories.success': (count: number) => `${count} memorie(s) found`,
  'tool.list_memories.empty': 'No matching memories',
  'tool.list_memories.error': (err: string) => `Failed to query memories: ${err}`,

  // ─── Tool: search_recordings ──────────────────────────────
  'tool.search_recordings.desc': 'Search for keywords in content library text. Use when the user asks "when did I mention X", "search content about X", etc. Uses full-text index search.',
  'tool.search_recordings.param_keyword': 'Search keyword',
  'tool.search_recordings.param_limit': 'Maximum number of results (optional, defaults to 10)',
  'tool.search_recordings.success': (total: number, shown: number) => `Found ${total} result(s) (showing first ${shown})`,
  'tool.search_recordings.not_found': (kw: string) => `No content found containing "${kw}"`,
  'tool.search_recordings.error': (err: string) => `Failed to search content: ${err}`,

  // ─── Tool: lookup_person ──────────────────────────────────
  'tool.lookup_person.desc': 'Look up person information by name. Use when the user asks "who is X", "tell me about X", etc. Returns person profile, related content, and relationships.',
  'tool.lookup_person.param_name': 'Person name (supports fuzzy matching)',
  'tool.lookup_person.not_found': (name: string) => `No person found matching "${name}"`,
  'tool.lookup_person.error': (err: string) => `Failed to look up person: ${err}`,

  // ─── Tool: set_reminder ───────────────────────────────────
  'tool.set_reminder.desc': 'Set a timed reminder (sends reminder text only, does not execute AI actions). Use for "remind me at 3pm tomorrow about the meeting", "every day at 8am remind me to take medicine", etc. Note: if the user wants the AI to "do" something at that time (e.g. tell a joke, write a story, generate content), use create_scheduled_task (task_type=prompt) instead.',
  'tool.set_reminder.param_content': 'Reminder content only (without the time part). For example, if the user says "remind me in 3 minutes to drink coffee", content should be "drink coffee".',
  'tool.set_reminder.param_schedule': 'Natural language time description, e.g. "in 3 minutes", "tomorrow at 3pm", "every day at 8am", "every Mon/Wed/Fri at 8am"',
  'tool.set_reminder.success': (content: string, display: string) => `Reminder set: ${content} (${display})`,
  'tool.set_reminder.error': (err: string) => `Failed to set reminder: ${err}`,

  // ─── Tool: list_reminders ─────────────────────────────────
  'tool.list_reminders.desc': 'List pending reminders. Use when the user asks "what reminders do I have", "what alarms did I set", etc.',
  'tool.list_reminders.param_include_sent': 'Whether to include already-sent reminders (optional, defaults to false)',
  'tool.list_reminders.success_all': (count: number) => `${count} reminder(s) total (including sent)`,
  'tool.list_reminders.success': (count: number) => `${count} pending reminder(s)`,
  'tool.list_reminders.empty': 'No pending reminders',
  'tool.list_reminders.empty_all': 'No reminders',
  'tool.list_reminders.error': (err: string) => `Failed to query reminders: ${err}`,

  // ─── Tool: create_scheduled_task ──────────────────────────
  'tool.create_scheduled_task.desc': 'Create a scheduled task. The AI will execute the action and send results to the user when the time comes. Use for: 1) User wants the AI to do something at a future time (e.g. "tell a joke in 2 minutes", "write something inspirational tomorrow morning") -> task_type=prompt; 2) Periodic predefined actions (e.g. "generate daily report every day") -> task_type=predefined.',
  'tool.create_scheduled_task.param_name': 'Task name',
  'tool.create_scheduled_task.param_task_type': 'Task type: predefined (predefined action) or prompt (free prompt)',
  'tool.create_scheduled_task.param_action': 'For predefined type: action identifier (daily_report/weekly_report/insight_scan/todo_reminder/todo_summary). For prompt type: write a detailed execution instruction, don\'t just repeat the user\'s words, add specific requirements.',
  'tool.create_scheduled_task.param_schedule': 'Natural language time description, e.g. "every day at 9am", "every Monday at 2pm", "every 30 minutes"',
  'tool.create_scheduled_task.param_permission_level': 'Permission level (optional, defaults to readonly)',
  'tool.create_scheduled_task.success': (name: string, display: string) => `Created scheduled task "${name}", runs ${display}`,
  'tool.create_scheduled_task.error': (err: string) => `Failed to create scheduled task: ${err}`,

  // ─── Tool: list_scheduled_tasks ───────────────────────────
  'tool.list_scheduled_tasks.desc': 'View the list of scheduled tasks. Use when the user asks "what scheduled tasks do I have", "what timers did I set", etc.',
  'tool.list_scheduled_tasks.param_status': 'Filter by status (optional, defaults to active)',
  'tool.list_scheduled_tasks.success': (count: number) => `${count} scheduled task(s)`,
  'tool.list_scheduled_tasks.empty': 'No scheduled tasks',
  'tool.list_scheduled_tasks.error': (err: string) => `Failed to query scheduled tasks: ${err}`,

  // ─── Tool: manage_scheduled_task ──────────────────────────
  'tool.manage_scheduled_task.desc': 'Manage a scheduled task (pause/resume/delete). Use when the user says "pause that daily summary", "delete the scheduled task", etc.',
  'tool.manage_scheduled_task.param_id': 'Scheduled task ID',
  'tool.manage_scheduled_task.param_operation': 'Operation type: pause, resume, or delete',
  'tool.manage_scheduled_task.not_found': (id: number) => `No scheduled task found with ID ${id}`,
  'tool.manage_scheduled_task.paused': (name: string) => `Paused scheduled task "${name}"`,
  'tool.manage_scheduled_task.resumed': (name: string) => `Resumed scheduled task "${name}"`,
  'tool.manage_scheduled_task.deleted': (name: string) => `Deleted scheduled task "${name}"`,
  'tool.manage_scheduled_task.unsupported_op': (op: string) => `Unsupported operation: ${op}`,
  'tool.manage_scheduled_task.error': (err: string) => `Failed to manage scheduled task: ${err}`,

  // ─── Tool: send_email ─────────────────────────────────────
  'tool.send_email.desc': 'Send an email. Use when the user says "send email", "email me", "email notification", etc. No need to ask for the recipient — "send me" means send to the user\'s own configured email. Subject can be auto-generated from content. Important: content should be a complete, warm email body, not just a few words.',
  'tool.send_email.param_to': 'Recipient email address (optional, defaults to the user\'s own email)',
  'tool.send_email.param_subject': 'Email subject (optional, auto-generated from body if not provided)',
  'tool.send_email.param_content': 'Email body content',
  'tool.send_email.not_enabled': 'Email is not enabled. Please enable and configure it in settings first.',
  'tool.send_email.no_router': 'Message router not initialized. Please try again later.',
  'tool.send_email.no_recipient': 'No recipient specified and no default email address in settings',
  'tool.send_email.success': (recipient: string) => `Email sent to ${recipient}`,
  'tool.send_email.error': (err: string) => `Failed to send email: ${err}`,

  // ── create_pptx ──
  'tool.create_pptx.desc': 'Create a PowerPoint presentation (.pptx) and auto-send it to the user. The generated file is automatically delivered via the current message channel. Just call this tool directly.',
  'tool.create_pptx.param_title': 'Presentation title',
  'tool.create_pptx.param_slides': 'Array of slide objects, each with title (string) and bullets (string array)',
  'tool.create_pptx.param_filename': 'Output filename (optional, without extension)',
  'tool.create_pptx.success': (path: string) => `PPT created: ${path}`,
  'tool.create_pptx.error': (err: string) => `Failed to create PPT: ${err}`,

  // ── create_docx ──
  'tool.create_docx.desc': 'Create a Word document (.docx) and auto-send it to the user. The generated file is automatically delivered via the current message channel. Just call this tool directly.',
  'tool.create_docx.param_title': 'Document title',
  'tool.create_docx.param_content': 'Document body content (Markdown format: # headings, - lists, paragraphs)',
  'tool.create_docx.param_filename': 'Output filename (optional, without extension)',
  'tool.create_docx.success': (path: string) => `Document created: ${path}`,
  'tool.create_docx.error': (err: string) => `Failed to create document: ${err}`,

  // ── read_pdf ──
  'tool.read_pdf.desc': 'Read a PDF file and extract its text content. Use when the user asks to read, analyze, or summarize a PDF file.',
  'tool.read_pdf.param_file_path': 'Full path to the PDF file',
  'tool.read_pdf.param_max_pages': 'Maximum number of pages to read (optional, defaults to all)',
  'tool.read_pdf.success': (pages: number, chars: number) => `PDF read: ${pages} pages, ${chars} characters`,
  'tool.read_pdf.not_found': (path: string) => `File not found: ${path}`,
  'tool.read_pdf.error': (err: string) => `Failed to read PDF: ${err}`,

  // ── send_file ──
  'tool.send_file.desc': 'Send a file to the user. Use when the user asks to "send me the file", "transfer it", etc. The file is auto-delivered via the current message channel.',
  'tool.send_file.param_file_path': 'Full path to the file to send',
  'tool.send_file.success': (name: string) => `File ${name} sent to user`,
  'tool.send_file.not_found': (path: string) => `File not found: ${path}`,
  'tool.send_file.no_channel': 'Not in a message channel, cannot send file',
  'tool.send_file.error': (err: string) => `Failed to send file: ${err}`,

  // ── create_pdf ──
  'tool.create_pdf.desc': 'Create a PDF document and auto-send it to the user. Use when the user asks to generate or export a PDF.',
  'tool.create_pdf.param_title': 'Document title',
  'tool.create_pdf.param_content': 'Document body content (Markdown format)',
  'tool.create_pdf.param_style': 'Document style: business (formal) or casual (relaxed)',
  'tool.create_pdf.param_filename': 'Output filename (optional, without extension)',
  'tool.create_pdf.success': (path: string) => `PDF created: ${path}`,
  'tool.create_pdf.error': (err: string) => `Failed to create PDF: ${err}`,

  // ─── Memory: Doc Generator ────────────────────────────────
  'memory.doc_empty': (_date: string) => `### Main thread\n\n> No recordings for this day.\n\n### Open\n\n`,
  'memory.doc_prompt': `You are a personal memory organizer. Generate a readable, editorial-style Markdown memory document from the day's content.

Style requirements:
- Write like a personal "today's memory" journal, not a list of recordings
- Don't output the date as a title (page header already shows it)
- Don't use H1 / H2 — only H3 (###) for section titles
- Use exactly the 4 provided section headings: Main thread / New encounters · Mentions / Decisions & Preferences / Open
- Wrap key decisions or quotes in > blockquote (renders as ochre quote block)
- Bold people, projects, key terms with **bold**
- Use - bullet lists, one line per item`,
  'memory.doc_section_summary': '### Main thread',
  'memory.doc_section_summary_hint': '(1-2 paragraphs of editorial narrative on the day\'s axis: what was discussed and what the core conclusion is. Bold keywords)',
  'memory.doc_section_facts': '### New encounters · Mentions',
  'memory.doc_section_facts_hint': '(List newly mentioned people / projects / concepts. e.g. - **WeChat channel** — primary publishing battlefield for next week)',
  'memory.doc_section_todos': '### Decisions & Preferences',
  'memory.doc_section_todos_hint': '(Important decisions or stances in > blockquote; remaining todos as bullets)',
  'memory.doc_section_emotion': '### Mood',
  'memory.doc_section_emotion_hint': '(One sentence summary of overall emotional tone)',
  'memory.doc_section_notes': '### Open',
  'memory.doc_section_notes_hint': '(Unresolved / pending / awaiting items as bullets)',
  'memory.ctx_date': (date: string) => `Date: ${date}`,
  'memory.ctx_count': (count: number) => `Content count: ${count}`,
  'memory.ctx_list': '### Content List:',
  'memory.ctx_segments': '### Voice Segments (first 20):',
  'memory.ctx_items': '### Extracted Items:',
  'memory.ctx_daily_summary': '### Daily Summary:',

  // ─── Memory: Extractor ────────────────────────────────────
  'memory.extract_prompt': `Extract facts worth remembering long-term from the following meeting/conversation text.

Extraction types:
- person: personal info (name, title, contact info, characteristics)
- business: business info (goals, numbers, dates, project status)
- preference: user preferences (habits, likes, work style)
- relationship: interpersonal relationships (who knows whom, collaborations)
- general: other important facts

Requirements:
- Only extract clearly stated facts, do not speculate
- Each fact should be independent and self-contained
- Ignore small talk, greetings, and repetitive content
- confidence: 1.0=explicitly stated, 0.7=fairly certain inference, 0.5=possible

Output JSON:
{"facts": [{"fact": "...", "category": "...", "confidence": 0.9}]}

Text:
{{text}}`,

  // ─── Pipeline: Diarization ──────────────────────────────────
  'diarization_method': 'Diarization Method',
  'diarization_method_embedding': 'Embedding Clustering (recommended)',
  'diarization_method_legacy': 'Legacy (OfflineSpeakerDiarization)',

  // ─── Notify ───────────────────────────────────────────────
  'notify.processing_complete': 'Processing Complete',
  'notify.processing_complete_body': (name: string) => `${name} is ready`,
  'notify.live_complete': 'Content Processed',
  'notify.live_complete_body': (id: number) => `Live recording #${id} post-processing complete`,
};
