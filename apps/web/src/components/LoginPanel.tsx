"use client";

import { useState } from "react";
import { devLogin } from "@/lib/api";
import type { SessionUser } from "@pong-pong/shared";

export function LoginPanel({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [handle, setHandle] = useState("퐁마스터");
  const [displayName, setDisplayName] = useState("퐁마스터");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="card grid gap-5 p-6">
      <div>
        <h1 className="text-4xl font-black text-ink">퐁퐁</h1>
        <p className="mt-2 text-sm font-semibold leading-6 text-muted">로그인 후 로비에서 빠른 매칭, 인공지능 연습, 토너먼트에 바로 들어갈 수 있습니다.</p>
      </div>
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm font-bold text-ink">
          핸들
          <input className="focus-ring rounded-lg border border-line px-3 py-2" value={handle} onChange={(event) => setHandle(event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm font-bold text-ink">
          표시 이름
          <input className="focus-ring rounded-lg border border-line px-3 py-2" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
      </div>
      {error ? <p className="text-sm font-bold text-red-600">{error}</p> : null}
      <button
        className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white hover:bg-blue-700"
        onClick={async () => {
          try {
            setError(null);
            onLogin(await devLogin(handle, displayName));
          } catch {
            setError("API 서버에 연결하지 못했습니다.");
          }
        }}
      >
        개발 로그인
      </button>
    </section>
  );
}
