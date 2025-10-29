"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { devLogin } from "@/lib/api";
import { invalidateExactQueries, mutationInvalidations, queryKeys } from "@/lib/query";

export function LoginPanel() {
  const queryClient = useQueryClient();
  const [handle, setHandle] = useState("퐁마스터");
  const [displayName, setDisplayName] = useState("퐁마스터");
  const login = useMutation({
    mutationFn: () => devLogin(handle, displayName),
    onSuccess: async (user) => {
      queryClient.setQueryData(queryKeys.me(), user);
      await invalidateExactQueries(queryClient, mutationInvalidations.login());
    }
  });

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
      {login.isError ? <p className="text-sm font-bold text-red-600">API 서버에 연결하지 못했습니다.</p> : null}
      <button
        className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white hover:bg-blue-700"
        disabled={login.isPending}
        onClick={() => login.mutate()}
      >
        {login.isPending ? "로그인 중" : "개발 로그인"}
      </button>
    </section>
  );
}
