"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { devLogin, guestLogin } from "@/lib/api";
import { invalidateExactQueries, mutationInvalidations, queryKeys } from "@/lib/query";

export function LoginPanel() {
  const demoMode = process.env.NEXT_PUBLIC_APP_MODE === "demo";
  const queryClient = useQueryClient();
  const [handle, setHandle] = useState("퐁마스터");
  const [displayName, setDisplayName] = useState("퐁마스터");
  const login = useMutation({
    mutationFn: async () => demoMode
      ? (await guestLogin()).user
      : devLogin(handle, displayName),
    onSuccess: async (user) => {
      // [INTV:PERF] 로그인 직후 서버를 다시 조회하지 않고도 "나(me)" 캐시를 즉시 채워, 화면이
      // 로그인 상태를 곧바로 반영하게 한다(query.ts의 expireSession이 로그아웃 시 같은 캐시를
      // null로 즉시 덮어쓰는 것과 대칭되는 로그인 쪽 최적화) — 그 다음 login과 연관된 다른
      // 캐시(로비 등)는 invalidateExactQueries로 다시 불러오게 한다.
      queryClient.setQueryData(queryKeys.me(), user);
      await invalidateExactQueries(queryClient, mutationInvalidations.login());
    }
  });

  return (
    <section className="card grid gap-5 p-6">
      <div>
        <h1 className="text-4xl font-black text-ink">퐁퐁</h1>
        <p className="mt-2 text-sm font-semibold leading-6 text-muted">
          {demoMode
            ? "별도 입력 없이 게스트로 시작해 다른 게스트나 인공지능과 경기할 수 있습니다."
            : "로그인 후 로비에서 빠른 매칭, 인공지능 연습, 토너먼트에 바로 들어갈 수 있습니다."}
        </p>
      </div>
      {!demoMode ? (
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
      ) : null}
      {login.isError ? <p className="text-sm font-bold text-red-600">API 서버에 연결하지 못했습니다.</p> : null}
      <button
        className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white hover:bg-blue-700"
        disabled={login.isPending}
        onClick={() => login.mutate()}
      >
        {login.isPending ? "입장 중" : demoMode ? "게스트로 시작" : "개발 로그인"}
      </button>
    </section>
  );
}
