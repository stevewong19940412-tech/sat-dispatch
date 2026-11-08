// useLiveStream — SSE 优先 + 轮询兜底（对照开源情报工作台 useLiveStream.ts 架构）
// 单条持久 SSE 连接接收服务端推送；SSE 失败自动退化为轮询
import { useState, useEffect, useRef } from "react";

export function useLiveStream(channel, { enabled = true, fallbackFetch, fallbackInterval = 30000 } = {}) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("connecting"); // sse | polling | off
  const esRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      setMode("off");
      return;
    }
    let disposed = false;

    // 1) 尝试 SSE
    try {
      const es = new EventSource(`/api/sse/${channel}`);
      esRef.current = es;
      es.onopen = () => { if (!disposed) setMode("sse"); };
      es.onmessage = (e) => {
        if (disposed) return;
        try { setData(JSON.parse(e.data)); } catch {}
      };
      es.onerror = () => {
        // SSE 失败 → 关闭并退化轮询
        es.close();
        esRef.current = null;
        if (disposed) return;
        startPolling();
      };
    } catch {
      startPolling();
    }

    // 2) 轮询兜底
    function startPolling() {
      if (disposed || !fallbackFetch) return;
      setMode("polling");
      const tick = () => fallbackFetch().then(d => { if (!disposed && d) setData(d); }).catch(() => {});
      tick();
      pollRef.current = setInterval(tick, fallbackInterval);
    }

    return () => {
      disposed = true;
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [channel, enabled, fallbackInterval]);

  return { data, mode };
}
