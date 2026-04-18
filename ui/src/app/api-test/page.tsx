"use client";

import { useEffect, useState } from "react";

export default function ApiTestPage() {
  const [status, setStatus] = useState<string>("Testing…");
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

    // We just try /statements because you said it's working already.
    fetch(`${base}/statements`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
        setData(body);
        setStatus("Backend OK ✅ /statements loaded");
      })
      .catch((e) => {
        setStatus(`Backend FAILED ❌ ${String(e?.message || e)}`);
      });
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>API Test</h1>
      <p style={{ marginBottom: 12 }}>{status}</p>
      <pre style={{ background: "#111", color: "#eee", padding: 12, borderRadius: 8, overflow: "auto" }}>
      {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
