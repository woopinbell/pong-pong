"use client";

import { useEffect, useState } from "react";
import type { LeaderboardEntry } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { getLeaderboard } from "@/lib/api";
import { sampleLeaderboard } from "@/lib/sample";

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>(sampleLeaderboard);

  useEffect(() => {
    getLeaderboard().then(setEntries);
  }, []);

  return (
    <AppShell>
      <h1 className="text-3xl font-black text-ink">순위표</h1>
      <p className="mt-2 text-sm font-semibold text-muted">점수와 승률을 기준으로 현재 상위 선수를 정렬합니다.</p>
      <section className="card mt-5 overflow-hidden">
        <div className="grid grid-cols-[70px_1fr_120px_120px] border-b border-line px-5 py-3 text-sm font-black text-muted">
          <span>순위</span>
          <span>선수</span>
          <span className="text-right">점수</span>
          <span className="text-right">승률</span>
        </div>
        {entries.map((entry) => (
          <div key={entry.user.id} className="grid grid-cols-[70px_1fr_120px_120px] items-center border-b border-line px-5 py-4 last:border-b-0">
            <span className="text-lg font-black text-blue-700">#{entry.rank}</span>
            <div>
              <p className="font-black text-ink">{entry.user.displayName}</p>
              <p className="text-sm font-semibold text-muted">누적 {entry.user.wins}승</p>
            </div>
            <span className="text-right font-black text-green-600">{entry.user.rating}</span>
            <span className="text-right font-black text-ink">{entry.winRate}%</span>
          </div>
        ))}
      </section>
    </AppShell>
  );
}
