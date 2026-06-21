import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Bell, X, CheckCircle, AlertCircle, Info } from 'lucide-react';
import { useI18n } from '../i18n';

export interface AppNotification {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message?: string;
  timestamp: number;
  read: boolean;
}

interface ToastItem {
  id: string;
  type: AppNotification['type'];
  title: string;
  message?: string;
  removing?: boolean;
}

interface NotificationContextType {
  notifications: AppNotification[];
  unreadCount: number;
  addNotification: (type: AppNotification['type'], title: string, message?: string) => void;
  toast: (type: AppNotification['type'], title: string, message?: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount: 0,
  addNotification: () => {},
  toast: () => {},
  markAllRead: () => {},
  clearAll: () => {},
});

export function useNotifications() {
  return useContext(NotificationContext);
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idCounter = useRef(0);

  const addNotification = useCallback((type: AppNotification['type'], title: string, message?: string) => {
    idCounter.current += 1;
    const notification: AppNotification = {
      id: `notif-${idCounter.current}`,
      type,
      title,
      message,
      timestamp: Date.now(),
      read: false,
    };
    setNotifications((prev) => [notification, ...prev].slice(0, 50));
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, removing: true } : t));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const toast = useCallback((type: AppNotification['type'], title: string, message?: string) => {
    idCounter.current += 1;
    const id = `toast-${idCounter.current}`;
    const item: ToastItem = { id, type, title, message };
    setToasts((prev) => [...prev, item].slice(-5));
    const duration = type === 'error' ? 5000 : 3000;
    setTimeout(() => removeToast(id), duration);
    // Also add to persistent notifications
    addNotification(type, title, message);
  }, [addNotification, removeToast]);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  const contextValue = useMemo(() => ({
    notifications, unreadCount, addNotification, toast, markAllRead, clearAll,
  }), [notifications, unreadCount, addNotification, toast, markAllRead, clearAll]);

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </NotificationContext.Provider>
  );
}

function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto kz-paper kz-anim-in max-w-[360px] transition-all duration-200 ${
            t.removing ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'
          }`}
        >
          <div className="flex items-start gap-3 px-3.5 py-3">
            {t.type === 'success' && <CheckCircle size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--c-success)' }} />}
            {t.type === 'error' && <AlertCircle size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--c-danger)' }} />}
            {t.type === 'info' && <Info size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--c-info)' }} />}
            <div className="flex-1 min-w-0">
              <span className="kz-text-ink" style={{ fontSize: '12.5px', fontWeight: 500 }}>{t.title}</span>
              {t.message && <p className="kz-text-mute mt-0.5" style={{ fontSize: '11.5px' }}>{t.message}</p>}
            </div>
            <button onClick={() => onDismiss(t.id)} className="kz-text-faint hover:kz-text-soft flex-shrink-0" aria-label="Dismiss">
              <X size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function IconForType({ type }: { type: AppNotification['type'] }) {
  if (type === 'success') return <CheckCircle size={13} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--c-success)' }} />;
  if (type === 'error') return <AlertCircle size={13} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--c-danger)' }} />;
  return <Info size={13} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--c-info)' }} />;
}

function formatRelativeTime(ts: number, t: Record<string, string>): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return t.just_now;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}${t.minutes_ago}`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}${t.hours_ago}`;
  const days = Math.floor(diff / 86400000);
  if (days <= 30) return `${days}${t.days_ago}`;
  return new Date(ts).toLocaleDateString();
}

export function NotificationBell() {
  const { notifications, unreadCount, markAllRead, clearAll } = useNotifications();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Auto-mark as read after 1 second when dropdown opens
  useEffect(() => {
    if (open && unreadCount > 0) {
      markReadTimerRef.current = setTimeout(() => {
        markAllRead();
      }, 1000);
    }
    return () => {
      if (markReadTimerRef.current) {
        clearTimeout(markReadTimerRef.current);
        markReadTimerRef.current = null;
      }
    };
  }, [open, unreadCount, markAllRead]);

  function handleToggle() {
    setOpen(!open);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleToggle}
        className="head__icon-btn relative"
        aria-label="Notifications"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 w-4 h-4 kz-mono flex items-center justify-center"
            style={{
              background: 'var(--c-danger)',
              color: 'oklch(0.99 0.005 75)',
              fontSize: '9px',
              fontWeight: 600,
              borderRadius: '50%',
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[340px] kz-paper z-50 max-h-[420px] flex flex-col kz-anim-in">
          <div
            className="px-4 py-2.5 flex items-center justify-between"
            style={{ borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
          >
            <span className="kz-serif-italic kz-text-soft" style={{ fontSize: '12px' }}>{t.common.notifications}</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="kz-mono kz-text-accent hover:opacity-80"
                  style={{ fontSize: '10.5px' }}
                >
                  {t.common.mark_all_read}
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={clearAll}
                  className="kz-text-mute hover:kz-text-soft"
                  style={{ fontSize: '11px' }}
                >
                  {t.common.clear}
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto max-h-80">
            {notifications.length === 0 ? (
              <div className="p-6 text-center kz-text-mute" style={{ fontSize: '12px' }}>{t.common.no_notifications}</div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`px-3 py-2 flex items-start gap-2 ${n.read ? 'opacity-60' : ''}`}
                  style={{ borderBottom: '1px solid var(--line-soft)' }}
                >
                  <IconForType type={n.type} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="kz-text-ink truncate" style={{ fontSize: '12px', fontWeight: 500 }}>{n.title}</span>
                      <span className="kz-mono kz-text-mute ml-2 flex-shrink-0" style={{ fontSize: '10px' }}>
                        {formatRelativeTime(n.timestamp, t.common)}
                      </span>
                    </div>
                    {n.message && (
                      <p className="kz-text-soft mt-0.5 truncate" style={{ fontSize: '11.5px' }}>{n.message}</p>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
