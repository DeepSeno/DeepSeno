import { useState, useEffect, useCallback, useRef } from 'react';
import { Smartphone, Copy, CheckCircle2, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useApi } from '../hooks/useApi';
import { useI18n } from '../i18n';

interface ConnectionInfo {
  host: string;
  port: number;
  token: string | null;
}

type ConnectionType = 'none' | 'lan' | 'p2p' | 'relay';

export default function MobileSync() {
  const api = useApi();
  const { lang } = useI18n();
  const isZh = lang === 'zh';

  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [clientCount, setClientCount] = useState(0);
  const [serverRunning, setServerRunning] = useState(false);
  const [relayTransportMode, setRelayTransportMode] = useState<'none' | 'p2p' | 'relay'>('none');
  const qrPayload = useRef<string>('{}'); // stored QR JSON for copy

  const qrGenerated = useRef(false);
  const relayIncluded = useRef(false);

  const isConnected = clientCount > 0 || relayTransportMode !== 'none';
  const connectionType: ConnectionType =
    clientCount > 0 ? 'lan' :
    relayTransportMode === 'p2p' ? 'p2p' :
    relayTransportMode === 'relay' ? 'relay' : 'none';

  const connLabel = connectionType === 'lan' ? (isZh ? '局域网直连' : 'LAN Direct') :
    connectionType === 'p2p' ? (isZh ? '穿透直连' : 'P2P Direct') :
    connectionType === 'relay' ? (isZh ? '加密中继' : 'Encrypted Relay') :
    (isZh ? '未连接' : 'Not Connected');
  const connColor = connectionType === 'lan' || connectionType === 'p2p' ? 'var(--c-success)' :
    connectionType === 'relay' ? '#F59E0B' : 'var(--text-muted)';

  const refresh = useCallback(async () => {
    try {
      const status = await api.lanServerGetStatus();
      setServerRunning(status.running);
      setClientCount(status.clientCount || 0);

      // Check relay status
      try {
        const relay = await api.relayGetStatus();
        setRelayTransportMode(relay.transportMode);
      } catch { /* ignore */ }

      if (!status.running) return;
      if (!status.host || !status.port) return;

      // Generate or update QR if needed
      const hasRelay = !!(status as any).relayUrl;
      if (!qrGenerated.current || (hasRelay && !relayIncluded.current)) {
        const payload: Record<string, unknown> = {
          host: status.host, port: status.port,
          token: status.token, fingerprint: status.fingerprint || '',
        };
        if (hasRelay) {
          const u = new URL((status as any).relayUrl.replace('deepseno://pair', 'https://dummy'));
          payload.relay = {
            mid: u.searchParams.get('mid') || '',
            pub: u.searchParams.get('pub') || '',
            nonce: u.searchParams.get('nonce') || '',
          };
          relayIncluded.current = true;
        }
        const url = await QRCode.toDataURL(JSON.stringify(payload), {
          width: 200, margin: 2, color: { dark: '#18181b', light: '#ffffff' },
        });
        qrPayload.current = JSON.stringify(payload);
        console.log('[MobileSync] QR JSON:', qrPayload.current.substring(0, 200) + '...');
        setQrDataUrl(url);
        setConnectionInfo({ host: status.host, port: status.port, token: status.token || null });
        qrGenerated.current = true;
      }
    } catch (err) {
      console.error('[MobileSync] refresh failed:', err);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const toggleServer = useCallback(async () => {
    setLoading(true);
    try {
      if (serverRunning) {
        await api.lanServerStop();
        qrGenerated.current = false;
        relayIncluded.current = false;
        setQrDataUrl(null);
      } else {
        await api.lanServerStart();
      }
      await refresh();
    } catch (err) {
      console.error('[MobileSync] toggle failed:', err);
    } finally { setLoading(false); }
  }, [api, serverRunning, refresh]);

  return (
    <div className="kz-panel-section space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Smartphone size={16} className="kz-text-soft" />
          <span className="kz-serif text-[15px] kz-text-ink">{isZh ? '移动端配对' : 'Mobile Companion'}</span>
        </div>
        <button onClick={toggleServer} disabled={loading}
          className={`kz-btn kz-btn--sm ${serverRunning ? 'kz-btn--danger' : 'kz-btn--primary'} ${loading ? 'opacity-50' : ''}`}>
          {loading ? '...' : serverRunning ? (isZh ? '停止服务' : 'Stop') : (isZh ? '启动服务' : 'Start')}
        </button>
      </div>

      {serverRunning && qrDataUrl && connectionInfo && (
        <div className="kz-paper p-5">
          <div className="flex gap-6 items-start">
            <div className="flex flex-col items-center gap-2 flex-shrink-0">
              <div className="p-3" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '10px' }}>
                <img src={qrDataUrl} alt="QR" className="w-44 h-44 block" />
              </div>
              <span className="text-[11px] kz-text-mute">{isZh ? '用手机扫描' : 'Scan with phone'}</span>
            </div>
            <div className="flex-1 space-y-3 min-w-0">
              <h3 className="kz-section-title">{isZh ? '连接状态' : 'Connection'}</h3>
              <div className="flex items-center gap-2 text-xs">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: connColor }} />
                <span className={isConnected ? 'kz-text-ink font-medium' : 'kz-text-mute'}>{connLabel}</span>
              </div>
              {isConnected && connectionType !== 'none' && (
                <div className="text-[11px] kz-text-soft leading-relaxed">
                  {connectionType === 'lan'
                    ? (isZh ? '局域网直连，延迟最低。' : 'LAN direct — lowest latency.')
                    : connectionType === 'p2p'
                    ? (isZh ? '通过 NAT 穿透直连。' : 'Connected via NAT traversal.')
                    : (isZh ? '通过服务器加密中继，数据全程加密。' : 'Encrypted relay — end-to-end encrypted.')}
                </div>
              )}
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="kz-text-mute">Host</span><span className="kz-mono kz-text-ink">{connectionInfo.host}</span></div>
                <div className="flex justify-between"><span className="kz-text-mute">Port</span><span className="kz-mono kz-text-ink">{connectionInfo.port}</span></div>
              </div>
              <button onClick={() => {
                window.api.clipboardWriteText(qrPayload.current);
                setCopied(true); setTimeout(() => setCopied(false), 2000);
              }} className="kz-btn kz-btn--sm flex-shrink-0">
                {copied ? <><CheckCircle2 size={12} /> {isZh ? '已复制' : 'Copied'}</> : <><Copy size={12} /> {isZh ? '复制连接信息' : 'Copy Info'}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs kz-text-soft">
        <ShieldCheck size={14} style={{ color: 'var(--c-success)' }} />
        <span>{isZh ? '端到端加密，服务端看不到内容' : 'End-to-end encrypted — server sees nothing'}</span>
      </div>
    </div>
  );
}
