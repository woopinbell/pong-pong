"use client";

import { useEffect, useState } from "react";
import { Share2, UserPlus } from "lucide-react";
import type { PublicUser } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { StatCard } from "@/components/StatCard";
import { sampleUsers } from "@/lib/sample";
import { Target, Trophy, X } from "lucide-react";
import { getProfile, requestFriend } from "@/lib/api";

export default function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const [handle, setHandle] = useState("pongmaster42");
  const [user, setUser] = useState<PublicUser>(sampleUsers[0]);
  const [message, setMessage] = useState("친구 요청은 로그인 후 보낼 수 있습니다.");

  useEffect(() => {
    params.then(({ handle: resolved }) => {
      setHandle(resolved);
      setUser(sampleUsers.find((item) => item.handle === resolved) ?? { ...sampleUsers[0], handle: resolved, displayName: "퐁마스터" });
      getProfile(resolved)
        .then((profile) => setUser(profile.user))
        .catch(() => undefined);
    });
  }, [params]);

  async function addFriend() {
    try {
      const friend = await requestFriend(handle);
      setMessage(`${friend.user.displayName}에게 친구 요청을 보냈습니다.`);
    } catch {
      setMessage("친구 요청을 보내려면 로그인 상태와 대상 핸들을 확인해야 합니다.");
    }
  }

  return (
    <AppShell>
      <section className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="flex items-center gap-5">
            <div className="grid h-28 w-28 place-items-center rounded-full bg-blue-100 text-3xl font-black text-blue-700">{user.displayName.slice(0, 1)}</div>
            <div>
              <h1 className="text-3xl font-black text-ink">{user.displayName}</h1>
              <p className="mt-1 text-sm font-semibold text-muted">선수 번호 {handle.length}</p>
              <p className="mt-3 text-lg font-black text-green-600">점수 {user.rating}</p>
            </div>
          </div>
          <div className="flex gap-3">
            <button className="focus-ring rounded-lg border border-line px-4 py-3 text-sm font-black text-ink" onClick={addFriend}>
              <UserPlus size={18} className="mr-2 inline" />
              친구 추가
            </button>
            <button className="cursor-not-allowed rounded-lg border border-line bg-slate-50 px-4 py-3 text-sm font-black text-muted" disabled title="공유 링크 복사는 추후 프로필 배포 기능에서 다룹니다.">
              <Share2 size={18} className="mr-2 inline" />
              공유 예정
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
        <h2 className="text-lg font-black text-ink">플레이 스타일</h2>
        <p className="mt-3 text-sm font-semibold leading-6 text-muted">긴 랠리에서 안정적으로 버티는 타입입니다. 백핸드 쪽 낮은 공에 강하고 빠른 서브를 상대할 때는 중앙 복귀가 빠릅니다.</p>
      </section>
    </AppShell>
  );
}
