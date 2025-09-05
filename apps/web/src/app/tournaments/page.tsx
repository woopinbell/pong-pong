"use client";

import { useEffect, useState } from "react";
import { Plus, Trophy } from "lucide-react";
import type { TournamentSummary } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { createTournament, getTournaments } from "@/lib/api";
import { sampleTournaments } from "@/lib/sample";

export default function TournamentsPage() {
  const [items, setItems] = useState<TournamentSummary[]>(sampleTournaments);

  useEffect(() => {
    getTournaments().then(setItems);
  }, []);

  async function create() {
    const tournament = await createTournament("새로운 퐁퐁 컵");
    setItems((current) => [tournament, ...current]);
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-ink">토너먼트</h1>
          <p className="mt-2 text-sm font-semibold text-muted">4인 싱글 엘리미네이션으로 짧은 컵 대회를 운영합니다.</p>
        </div>
        <button className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white" onClick={create}>
          <Plus size={18} className="mr-2 inline" />
          토너먼트 생성
        </button>
      </div>
      <section className="mt-5 grid gap-5 xl:grid-cols-[320px_1fr]">
        <div className="card p-5">
          <h2 className="text-lg font-black text-ink">진행 중인 대회</h2>
          <div className="mt-4 grid gap-3">
            {items.map((item) => (
              <button key={item.id} className="focus-ring rounded-lg border border-line p-4 text-left hover:border-blue-300">
                <p className="font-black text-ink">{item.name}</p>
                <p className="mt-1 text-sm font-semibold text-muted">
                  {item.playerCount} / {item.capacity}명
                </p>
              </button>
            ))}
          </div>
        </div>
        <div className="card p-5">
          <h2 className="flex items-center gap-2 text-lg font-black text-ink">
            <Trophy size={20} /> 브래킷
          </h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {["1라운드", "결승", "우승"].map((round, index) => (
              <div key={round} className="rounded-lg border border-line bg-slate-50 p-4">
                <p className="font-black text-blue-700">{round}</p>
                <div className="mt-4 grid gap-3">
                  {(items[0]?.entries ?? []).slice(index, index + 2).map((entry) => (
                    <div key={entry.id} className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-ink shadow-sm">
                      {entry.displayName}
                    </div>
                  ))}
                  {index === 2 ? <div className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-muted shadow-sm">대기 중</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </AppShell>
  );
}
