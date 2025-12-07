"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2, Target, Trophy, UserPlus, X } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { StatCard } from "@/components/StatCard";
import { requestFriend } from "@/lib/api";
import {
  invalidateExactQueries,
  mutationInvalidations,
  profileQueryOptions
} from "@/lib/query";

// [INTV:TRAP] 폴더 이름의 [handle]은 Next.js App Router의 "동적 라우트 세그먼트" 문법 — 예를 들어
// /profile/pong-master로 접속하면 handle이 "pong-master"로 채워진 params가 이 컴포넌트에 전달된다.
// Next 최신 버전에서는 이 params가 (동기 값이 아니라) Promise로 오므로, React의 use() 훅으로 그
// 값을 꺼낸다 — use()는 useEffect 없이도 렌더링 도중 Promise나 Context 값을 직접 읽을 수 있게
// 해주는 훅이다. params를 예전 버전처럼 동기 객체로 가정하고 곧바로 params.handle로 접근하면,
// 실제로는 Promise 객체의 handle 프로퍼티(undefined)를 읽게 되는 버전 차이 함정.
export default function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = use(params);
  const queryClient = useQueryClient();
  const profileQuery = useQuery(profileQueryOptions(handle));
  const [notice, setNotice] = useState("");
  const user = profileQuery.data?.user ?? null;
  const recentMatches = profileQuery.data?.recentMatches ?? [];
  const message = notice || (profileQuery.isError
    ? "프로필 정보를 불러오지 못했습니다."
    : profileQuery.isPending
      ? "프로필 정보를 불러오는 중입니다."
      : "공개 프로필 정보를 표시합니다.");
  const friendRequest = useMutation({
    mutationFn: () => requestFriend(handle),
    onSuccess: async (friend) => {
      setNotice(`${friend.user.displayName}에게 친구 요청을 보냈습니다.`);
      await invalidateExactQueries(queryClient, mutationInvalidations.friendRequest());
    },
    onError: () => setNotice("친구 요청을 보내려면 로그인 상태와 대상 핸들을 확인해야 합니다.")
  });

  async function shareProfile() {
    try {
      const url = `${window.location.origin}/profile/${handle}`;
      // [INTV:EDGE] navigator.clipboard.writeText: 브라우저의 클립보드 API — 비동기이고, 브라우저
      // 정책상 HTTPS(보안 컨텍스트)나 권한이 없으면 실패할 수 있어 항상 실패 가능성을 염두에 두고
      // try/catch로 감싼다(로컬 HTTP 개발 환경에서는 이 API 자체가 없을 수 있어, try/catch 없이
      // 호출하면 개발 중에만 재현되는 크래시가 생긴다).
      await navigator.clipboard.writeText(url);
      setNotice("프로필 공유 링크를 복사했습니다.");
    } catch {
      setNotice("프로필 공유 링크를 복사하지 못했습니다.");
    }
  }

  return (
    <AppShell>
      {!user ? (
        <section className="card p-6">
          <h1 className="text-3xl font-black text-ink">프로필</h1>
          <p className="mt-4 text-sm font-bold text-muted">{message}</p>
        </section>
      ) : (
        <>
      <section className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="flex items-center gap-5">
            <div className="grid h-28 w-28 place-items-center rounded-full bg-blue-100 text-3xl font-black text-blue-700">{user.displayName.slice(0, 1)}</div>
            <div>
              <h1 className="flex flex-wrap items-center gap-3 text-3xl font-black text-ink">
                {user.displayName}
                {user.isNpc ? <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-black text-amber-700">AI 상대</span> : null}
              </h1>
              <p className="mt-1 text-sm font-semibold text-muted">선수 번호 {handle.length}</p>
              <p className="mt-3 text-lg font-black text-green-600">점수 {user.rating}</p>
            </div>
          </div>
          <div className="flex gap-3">
            <button className="focus-ring rounded-lg border border-line px-4 py-3 text-sm font-black text-ink disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-muted" onClick={() => friendRequest.mutate()} disabled={user.isNpc || friendRequest.isPending}>
              <UserPlus size={18} className="mr-2 inline" />
              친구 추가
            </button>
            <button className="focus-ring rounded-lg border border-line px-4 py-3 text-sm font-black text-ink" onClick={shareProfile}>
              <Share2 size={18} className="mr-2 inline" />
              공유
            </button>
          </div>
        </div>
        <p className="mt-4 text-sm font-bold text-blue-700">{message}</p>
      </section>
      <section className="mt-5 grid gap-4 md:grid-cols-3">
        <StatCard icon={Trophy} label="승리" value={String(user.wins)} hint="누적 기록" tone="green" />
        <StatCard icon={X} label="패배" value={String(user.losses)} hint="최근 30일" tone="red" />
        <StatCard icon={Target} label="승률" value={`${Math.round((user.wins / Math.max(1, user.wins + user.losses)) * 100)}%`} hint="점수 반영" />
      </section>
      <section className="card mt-5 p-5">
        <h2 className="text-lg font-black text-ink">공개 최근 경기</h2>
        <div className="mt-4 divide-y divide-line">
          {recentMatches.length === 0 ? <p className="py-4 text-sm font-semibold text-muted">공개할 최근 경기가 없습니다.</p> : null}
          {recentMatches.map((match) => (
            <div key={match.id} className="grid grid-cols-[80px_1fr_70px] items-center gap-3 py-3 text-sm font-bold">
              <span className={`rounded-full px-3 py-1 text-center ${match.result === "win" ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600"}`}>{match.result === "win" ? "승리" : "패배"}</span>
              <span className="text-muted">{match.opponentHandle}</span>
              <span className="text-right text-ink">{match.scoreLeft} - {match.scoreRight}</span>
            </div>
          ))}
        </div>
      </section>
        </>
      )}
    </AppShell>
  );
}
