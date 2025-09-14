"use client";

import { useEffect, useState } from "react";
import { Share2, Target, Trophy, UserPlus, X } from "lucide-react";
import type { MatchSummary, PublicUser } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { StatCard } from "@/components/StatCard";
import { getProfile, requestFriend } from "@/lib/api";

export default function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const [handle, setHandle] = useState("pongmaster42");
  const [user, setUser] = useState<PublicUser | null>(null);
  const [recentMatches, setRecentMatches] = useState<MatchSummary[]>([]);
  const [message, setMessage] = useState("프로필 정보를 불러오는 중입니다.");

  useEffect(() => {
    params.then(({ handle: resolved }) => {
      setHandle(resolved);
      getProfile(resolved)
        .then((profile) => {
          setUser(profile.user);
          setRecentMatches(profile.recentMatches);
          setMessage("공개 프로필 정보를 표시합니다.");
        })
        .catch(() => {
          setUser(null);
          setRecentMatches([]);
          setMessage("프로필 정보를 불러오지 못했습니다.");
        });
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

  async function shareProfile() {
    try {
      const url = `${window.location.origin}/profile/${handle}`;
      await navigator.clipboard.writeText(url);
      setMessage("프로필 공유 링크를 복사했습니다.");
    } catch {
      setMessage("프로필 공유 링크를 복사하지 못했습니다.");
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
