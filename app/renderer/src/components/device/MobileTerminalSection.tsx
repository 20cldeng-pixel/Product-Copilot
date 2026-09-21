import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

type Offer = Awaited<ReturnType<typeof window.electronAPI.mobileTerminal.createOffer>>;
type Device = Awaited<ReturnType<typeof window.electronAPI.mobileTerminal.listDevices>>[number];
type Pending = Awaited<ReturnType<typeof window.electronAPI.mobileTerminal.listPending>>[number];

function relativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function MobileTerminalSection(): JSX.Element {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const [nextDevices, nextPending] = await Promise.all([
      window.electronAPI.mobileTerminal.listDevices(),
      window.electronAPI.mobileTerminal.listPending(),
    ]);
    setDevices(nextDevices);
    setPending(nextPending);
  }, []);

  useEffect(() => {
    void load();
    const unsubChanged = window.electronAPI.mobileTerminal.onChanged(() => void load());
    const unsubPair = window.electronAPI.mobileTerminal.onPairRequest(() => void load());
    const unsubError = window.electronAPI.mobileTerminal.onError(({ message }) => setError(message));
    return () => { unsubChanged(); unsubPair(); unsubError(); };
  }, [load]);

  useEffect(() => {
    if (!offer) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [offer]);

  const secondsLeft = useMemo(() => offer ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1_000)) : 0, [offer, now]);

  const createOffer = async () => {
    setCreating(true);
    setError(null);
    try {
      const next = await window.electronAPI.mobileTerminal.createOffer();
      const qr = await QRCode.toDataURL(next.uri, { width: 220, margin: 1, errorCorrectionLevel: "M" });
      setOffer(next);
      setQrDataUrl(qr);
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法开启手机配对");
    } finally {
      setCreating(false);
    }
  };

  const finishPair = async (requestId: string, accept: boolean) => {
    const result = accept
      ? await window.electronAPI.mobileTerminal.acceptPair(requestId)
      : await window.electronAPI.mobileTerminal.rejectPair(requestId);
    if (!result.ok) setError("配对请求已失效，请重新扫码");
    await load();
    if (accept && result.ok) { setOffer(null); setQrDataUrl(""); }
  };

  return (
    <section className="shrink-0 space-y-2">
      <div className="flex items-center justify-between px-1">
        <div>
          <div className="text-xs font-medium text-text-secondary">手机终端</div>
          <div className="text-[length:var(--text-2xs)] text-text-muted mt-0.5">手机只显示 PC 实时数据，不保存会话内容</div>
        </div>
        <button
          type="button"
          className="text-[length:var(--text-2xs)] px-2.5 py-1 rounded-[var(--radius-lg)] btn-accent shrink-0"
          disabled={creating}
          onClick={() => void createOffer()}
        >
          {creating ? "开启中…" : devices.length > 0 ? "配对新手机" : "扫码配对"}
        </button>
      </div>

      {offer && secondsLeft > 0 && (
        <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-3 py-3 flex flex-col items-center">
          {qrDataUrl && <img src={qrDataUrl} alt="Product Copilot 手机配对二维码" className="w-[180px] h-[180px] rounded-md" />}
          <div className="text-xs text-text-primary mt-2">使用 Product Copilot 手机 App 扫描</div>
          <div className="text-[length:var(--text-2xs)] text-text-muted mt-0.5">
            {offer.addresses.length > 0 ? `${offer.addresses[0]}:${offer.port}` : "未找到可用局域网地址"} · {secondsLeft}s 后失效
          </div>
        </div>
      )}

      {offer && secondsLeft === 0 && (
        <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-3 py-2 text-[length:var(--text-11)] text-text-muted">
          二维码已失效，请重新生成。
        </div>
      )}

      {pending.map((request) => (
        <div key={request.requestId} className="rounded-[var(--radius-lg)] border border-accent/40 bg-accent-soft px-3 py-3">
          <div className="text-xs font-medium text-text-primary">{request.deviceName} 请求连接</div>
          <div className="text-[length:var(--text-2xs)] text-text-secondary mt-1">确认手机显示相同校验码</div>
          <div className="font-mono text-xl tracking-[0.25em] text-accent text-center my-2">{request.verificationCode}</div>
          <div className="flex justify-end gap-2">
            <button type="button" className="px-3 py-1 text-xs text-text-secondary" onClick={() => void finishPair(request.requestId, false)}>拒绝</button>
            <button type="button" className="px-3 py-1 text-xs btn-accent rounded-[var(--radius-lg)]" onClick={() => void finishPair(request.requestId, true)}>确认配对</button>
          </div>
        </div>
      ))}

      {devices.map((device) => (
        <div key={device.id} className="flex items-center gap-2.5 rounded-[var(--radius-lg)] border border-border bg-surface px-3 py-2.5">
          <span className={`w-2 h-2 rounded-full ${device.online ? "bg-success" : "bg-text-muted/40"}`} />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-text-primary truncate">{device.name}</div>
            <div className="text-[length:var(--text-2xs)] text-text-muted">{device.online ? "在线" : `离线 · ${relativeTime(device.lastSeen)}`}</div>
          </div>
          <button
            type="button"
            className="text-[length:var(--text-2xs)] text-text-secondary hover:text-danger"
            onClick={() => {
              if (window.confirm(`解除与“${device.name}”的配对？`)) {
                void window.electronAPI.mobileTerminal.revoke(device.id).then(() => load());
              }
            }}
          >
            解除
          </button>
        </div>
      ))}

      {error && <div className="text-[length:var(--text-11)] text-danger px-1">{error}</div>}
    </section>
  );
}

