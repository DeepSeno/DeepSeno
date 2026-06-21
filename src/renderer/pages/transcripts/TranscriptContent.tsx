import { RefObject } from 'react';
import { Loader2, FileText, Video } from 'lucide-react';
import type { Message, LiveSegment, ExtractedItem } from './types';
import ConversationRenderer from './renderers/ConversationRenderer';
import DocumentRenderer from './renderers/DocumentRenderer';
import ImageRenderer from './renderers/ImageRenderer';

interface TranscriptContentProps {
  liveSelected: boolean;
  liveStatus: 'idle' | 'recording' | 'post_processing';
  liveSegments: LiveSegment[];
  liveEndRef: RefObject<HTMLDivElement | null>;
  textMode: 'raw' | 'clean';
  messages: Message[];
  highlightedSegment: number | null;
  currentTime: number;
  isPlaying: boolean;
  conversationCount: number;
  extractedElement: React.ReactNode | null;
  extractedItems: ExtractedItem[];
  mediaType: string;
  imageUrl: string | null;
  recordingId?: number;
  pageCount?: number;
  videoRef?: RefObject<HTMLVideoElement | null>;
  onBubbleClick: (startTime: number) => void;
  onToggleBookmark: (segmentId: number) => void;
  onEditSegment?: (segmentId: number, newText: string) => void;
  tr: Record<string, any>;
  t: Record<string, any>;
  lang: string;
}

export default function TranscriptContent({
  liveSelected,
  liveSegments,
  liveEndRef,
  textMode,
  messages,
  highlightedSegment,
  currentTime,
  isPlaying,
  conversationCount,
  extractedElement,
  extractedItems,
  mediaType,
  imageUrl,
  recordingId,
  pageCount,
  videoRef,
  onBubbleClick,
  onToggleBookmark,
  onEditSegment,
  tr,
  t,
  lang,
}: TranscriptContentProps) {
  return (
    <div
      className="flex-1 scroll"
      style={mediaType === 'pdf'
        ? { overflow: 'hidden', minHeight: 0 }
        : { overflowY: 'auto', padding: '22px 26px 60px', minHeight: 0 }}
    >
      {liveSelected ? (
        /* Live recording view */
        <>
          {liveSegments.length === 0 && (
            <div className="kz-empty" style={{ height: '100%' }}>
              <div className="kz-empty__icon"><Loader2 size={20} className="animate-spin" /></div>
              <div>
                <div className="kz-empty__title">{tr.waiting_speech}</div>
              </div>
            </div>
          )}
          {liveSegments.map(seg => (
            <div
              key={`live-${seg.index}`}
              className="kz-live-card"
              style={{
                padding: '10px 14px',
                marginBottom: 8,
                borderRadius: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span className="kz-sdot kz-sdot--danger kz-live-dot" />
                <span className="kz-mono" style={{ fontSize: 10.5, color: 'var(--c-danger)' }}>
                  {Math.floor(seg.start / 60)}:{String(Math.floor(seg.start % 60)).padStart(2, '0')}
                </span>
              </div>
              <p style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.7, margin: 0 }}>{seg.text}</p>
            </div>
          ))}
          {liveSegments.length > 0 && <div ref={liveEndRef} />}
        </>
      ) : (
        /* Regular conversation view */
        <>
          {messages.length === 0 && mediaType !== 'image' && mediaType !== 'pdf' && (
            <div className="kz-empty" style={{ height: '100%' }}>
              {conversationCount === 0 ? (
                <>
                  <div className="kz-empty__icon"><FileText size={20} /></div>
                  <div><div className="kz-empty__title">{tr.no_conversations}</div></div>
                </>
              ) : ['docx', 'text'].includes(mediaType) ? (
                <>
                  <div className="kz-empty__icon"><FileText size={20} /></div>
                  <div>
                    <div className="kz-empty__title">{tr.loading_document}</div>
                    <div className="kz-empty__sub" style={{ marginTop: 6 }}>{tr.loading_document_hint}</div>
                  </div>
                </>
              ) : mediaType === 'video' ? (
                <>
                  <div className="kz-empty__icon"><Video size={20} /></div>
                  <div><div className="kz-empty__title">{tr.processing_video}</div></div>
                </>
              ) : (
                <>
                  <div className="kz-empty__icon"><FileText size={20} /></div>
                  <div><div className="kz-empty__title">{tr.select_conversation}</div></div>
                </>
              )}
            </div>
          )}

          {/* Video player */}
          <div className={mediaType === 'video' ? 'mb-4' : 'h-0 overflow-hidden'}>
            <video ref={videoRef} className="w-full max-h-[50vh] bg-black rounded-lg" controls playsInline />
          </div>

          {/* Route to media-type-specific renderer — PDF always renders */}
          {mediaType === 'pdf' ? (
            <DocumentRenderer
              messages={messages}
              textMode={textMode}
              highlightedSegment={highlightedSegment}
              onToggleBookmark={onToggleBookmark}
              extractedElement={extractedElement}
              tr={tr}
              mediaType={mediaType}
              recordingId={recordingId}
              pageCount={pageCount}
              lang={lang}
            />
          ) : mediaType === 'image' ? (
            <ImageRenderer
              messages={messages}
              extractedItems={extractedItems}
              imageUrl={imageUrl}
              recordingId={recordingId}
              tr={tr}
              lang={lang}
            />
          ) : ['pdf', 'docx', 'text'].includes(mediaType) ? (
            <DocumentRenderer
              messages={messages}
              textMode={textMode}
              highlightedSegment={highlightedSegment}
              onToggleBookmark={onToggleBookmark}
              extractedElement={extractedElement}
              tr={tr}
              mediaType={mediaType}
              recordingId={recordingId}
            />
          ) : (
            <>
              <ConversationRenderer
                messages={messages}
                textMode={textMode}
                highlightedSegment={highlightedSegment}
                currentTime={currentTime}
                isPlaying={isPlaying}
                onBubbleClick={onBubbleClick}
                onToggleBookmark={onToggleBookmark}
                onEditSegment={onEditSegment}
                extractedElement={extractedElement}
                tr={tr}
                t={t}
              />
              {/* End-of-transcript rule + encouragement (per design spec) */}
              {messages.length > 0 && (
                <>
                  <div className="kz-rule" style={{ marginTop: 32 }}>
                    {tr.transcript_end || 'end of transcript'}
                  </div>
                  <div
                    className="kz-serif-italic kz-text-mute"
                    style={{ fontSize: 12.5, textAlign: 'center', marginTop: 6 }}
                  >
                    {tr.transcript_short_hint || '要更长更连贯的输出？试着把整段会议或访谈拖进来。'}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
