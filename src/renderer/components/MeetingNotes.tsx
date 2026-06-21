import { RefreshCw, Copy, Users, CheckCircle, ListTodo, FileText, Tag, Loader2 } from 'lucide-react';
import type { MeetingNotes as MeetingNotesType } from '../hooks/useApi';

interface MeetingNotesProps {
  notes: MeetingNotesType;
  onRegenerate?: () => Promise<void>;
  onCopyMarkdown?: () => void;
  isRegenerating?: boolean;
}

export default function MeetingNotes({ notes, onRegenerate, onCopyMarkdown, isRegenerating }: MeetingNotesProps) {
  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  return (
    <div className="space-y-4 font-mono">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-neutral-900 tracking-tight">{notes.title}</h2>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-neutral-400">
            <span className="flex items-center gap-1">
              <Users size={10} />
              {notes.participants.length} participants
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle size={10} />
              {notes.decisions.length} decisions
            </span>
            <span className="flex items-center gap-1">
              <ListTodo size={10} />
              {notes.actionItems.length} action items
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {onCopyMarkdown && (
            <button
              onClick={onCopyMarkdown}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold border border-neutral-200 rounded-lg text-neutral-600 bg-white hover:bg-neutral-50 transition-colors"
            >
              <Copy size={10} /> Copy
            </button>
          )}
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              disabled={isRegenerating}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold border border-neutral-200 rounded-lg text-neutral-600 bg-white hover:bg-neutral-50 transition-colors disabled:opacity-40"
            >
              {isRegenerating ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
              {isRegenerating ? 'Generating...' : 'Regenerate'}
            </button>
          )}
        </div>
      </div>

      {/* Participants */}
      <div className="shadow-sm rounded-xl bg-white">
        <div className="px-3 py-2 bg-neutral-50 border-b border-neutral-100">
          <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-widest flex items-center gap-1.5">
            <Users size={10} /> PARTICIPANTS
          </span>
        </div>
        <div className="p-3 flex flex-wrap gap-2">
          {notes.participants.map((p, i) => (
            <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-neutral-50 rounded-lg">
              <span className="text-xs font-semibold text-neutral-700">{p.name}</span>
              <span className="text-[11px] text-neutral-400">{formatTime(p.speakingTime)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Key Decisions */}
      {notes.decisions.length > 0 && (
        <div className="shadow-sm rounded-xl bg-white">
          <div className="px-3 py-2 bg-neutral-50 border-b border-neutral-100">
            <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-widest flex items-center gap-1.5">
              <CheckCircle size={10} /> KEY DECISIONS
            </span>
          </div>
          <div className="p-3 space-y-1.5">
            {notes.decisions.map((d, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-neutral-700">
                <span className="text-neutral-400 font-bold shrink-0">{i + 1}.</span>
                <span>{d}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Items */}
      {notes.actionItems.length > 0 && (
        <div className="shadow-sm rounded-xl bg-white">
          <div className="px-3 py-2 bg-neutral-50 border-b border-neutral-100">
            <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-widest flex items-center gap-1.5">
              <ListTodo size={10} /> ACTION ITEMS
            </span>
          </div>
          <div className="divide-y divide-neutral-100">
            {notes.actionItems.map((item, i) => (
              <div key={i} className="px-3 py-2 flex items-center gap-3">
                <span className="text-xs font-semibold text-neutral-500 shrink-0 w-16">{item.assignee}</span>
                <span className="text-xs text-neutral-700 flex-1">{item.task}</span>
                {item.dueDate && (
                  <span className="text-[11px] text-neutral-400 bg-neutral-50 px-2 py-0.5 rounded-lg shrink-0">
                    {item.dueDate}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Discussion Summary */}
      <div className="shadow-sm rounded-xl bg-white">
        <div className="px-3 py-2 bg-neutral-50 border-b border-neutral-100">
          <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-widest flex items-center gap-1.5">
            <FileText size={10} /> DISCUSSION SUMMARY
          </span>
        </div>
        <div className="p-3">
          <p className="text-xs text-neutral-700 leading-relaxed">{notes.discussionSummary}</p>
        </div>
      </div>

      {/* Key Topics */}
      {notes.keyTopics.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Tag size={10} className="text-neutral-400" />
          {notes.keyTopics.map((topic, i) => (
            <span key={i} className="text-[11px] px-2 py-0.5 bg-neutral-100 rounded-lg text-neutral-600">
              {topic}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
