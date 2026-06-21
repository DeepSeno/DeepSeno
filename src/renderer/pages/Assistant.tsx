import { useI18n } from '../i18n';
import SessionSidebar from './assistant/SessionSidebar';
import ChatMessages from './assistant/ChatMessages';
import ChatInput from './assistant/ChatInput';
import { useChat } from './assistant/useChat';

export default function Assistant() {
  const { t, lang } = useI18n();
  const a = t.asst;

  const chat = useChat(a, t, lang);

  return (
    <div className="h-[calc(100vh-7rem)] flex flex-col">
      <div
        className="flex-1 flex overflow-hidden"
        style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', background: 'var(--bg)' }}
      >
        <SessionSidebar
          unifiedSessions={chat.unifiedSessions}
          activeSessionId={chat.activeSessionId}
          activeSessionType={chat.activeSessionType}
          editingSessionId={chat.editingSessionId}
          editTitle={chat.editTitle}
          deleteConfirmId={chat.deleteConfirmId}
          isLoading={chat.isLoading}
          lang={lang}
          a={a}
          t={t}
          onNewSession={chat.handleNewSession}
          onSelectUnifiedSession={chat.handleSelectUnifiedSession}
          onStartRename={chat.handleStartRename}
          onEditTitleChange={chat.setEditTitle}
          onFinishRename={chat.handleFinishRename}
          onCancelRename={() => chat.setEditingSessionId(null)}
          onDeleteRequest={chat.setDeleteConfirmId}
          onDeleteConfirm={chat.handleDeleteSession}
          onDeleteCancel={() => chat.setDeleteConfirmId(null)}
        />

        <div
          className="flex-1 flex flex-col min-w-0"
          style={{ borderLeft: '1px solid var(--line)' }}
        >
          <ChatMessages
            ref={chat.messagesEndRef}
            messages={chat.messages}
            isLoading={chat.isLoading}
            hasConversation={chat.hasConversation}
            streamStatus={chat.streamStatus}
            elapsed={chat.elapsed}
            copiedIdx={chat.copiedIdx}
            expandedSources={chat.expandedSources}
            a={a}
            onCopy={chat.handleCopy}
            onToggleSourceExpand={chat.handleToggleSourceExpand}
            onSourceClick={chat.handleSourceClick}
            onStarterClick={chat.handleSend}
            onDeleteMessage={chat.isChannelSession ? undefined : chat.handleDeleteMessage}
            onEditMessage={chat.isChannelSession ? undefined : chat.handleEditMessage}
          />

          {chat.isChannelSession ? (
            <div
              className="px-4 py-3"
              style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
            >
              <div className="flex items-center justify-center gap-2">
                <span className="kz-mono kz-text-mute" style={{ fontSize: 11 }}>
                  {a.channel_readonly(chat.activeChannelLabel)}
                </span>
              </div>
            </div>
          ) : (
            <ChatInput
              input={chat.input}
              isLoading={chat.isLoading}
              agentMode={chat.agentMode}
              hasConversation={chat.hasConversation}
              allCopied={chat.allCopied}
              showClearConfirm={chat.showClearConfirm}
              a={a}
              t={t}
              onInputChange={chat.setInput}
              onSend={chat.handleSend}
              onStop={chat.handleStop}
              onToggleAgentMode={() => chat.setAgentMode(!chat.agentMode)}
              onCopyAllMd={chat.handleCopyAllMd}
              onClearRequest={chat.handleClearRequest}
              onClearConfirm={chat.handleClearConfirm}
              onClearCancel={chat.handleClearCancel}
            />
          )}
        </div>
      </div>
    </div>
  );
}
