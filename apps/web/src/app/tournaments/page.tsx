"use client";

import { useEffect, useState } from "react";
import { Plus, Trophy } from "lucide-react";
import type { TournamentSummary } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { createTournament, getTournaments, joinTournament } from "@/lib/api";
import { sampleTournaments } from "@/lib/sample";

export default function TournamentsPage() {
  const [items, setItems] = useState<TournamentSummary[]>(sampleTournaments);
  const [selectedId, setSelectedId] = useState(sampleTournaments[0]?.id ?? "");
  const [message, setMessage] = useState("대회를 선택하면 브래킷과 참가 상태를 확인할 수 있습니다.");
  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  useEffect(() => {
    getTournaments().then((tournaments) => {
      setItems(tournaments);
      setSelectedId((current) => current || tournaments[0]?.id || "");
    });
  }, []);

  async function create() {
    const tournament = await createTournament("새로운 퐁퐁 컵");
    setItems((current) => [tournament, ...current]);
    setSelectedId(tournament.id);
    setMessage(`${tournament.name}을 생성했습니다.`);
  }

  async function join() {
    if (!selected) return;
    try {
      const tournament = await joinTournament(selected.id);
      setItems((current) => current.map((item) => (item.id === tournament.id ? tournament : item)));
      setSelectedId(tournament.id);
      setMessage(`${tournament.name}에 참가했습니다.`);
    } catch {
      setMessage("토너먼트 참가에는 로그인이 필요합니다.");
    }
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-ink">토너먼트</h1>
          <p className="mt-2 text-sm font-semibold text-muted">4인 싱글 엘리미네이션으로 짧은 컵 대회를 운영합니다.</p>
          <p className="mt-2 text-sm font-bold text-blue-700">{message}</p>
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
              <button
                key={item.id}
                className={`focus-ring rounded-lg border p-4 text-left hover:border-blue-300 ${selected?.id === item.id ? "border-blue-500 bg-blue-50" : "border-line"}`}
                onClick={() => {
                  setSelectedId(item.id);
                  setMessage(`${item.name}을 선택했습니다.`);
                }}
              >
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
          {selected ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-slate-50 p-4">
              <div>
                <p className="font-black text-ink">{selected.name}</p>
                <p className="mt-1 text-sm font-semibold text-muted">
                  {selected.playerCount} / {selected.capacity}명 · {selected.status === "open" ? "모집 중" : selected.status === "running" ? "진행 중" : "종료"}
                </p>
              </div>
              <button className="focus-ring rounded-lg bg-green-600 px-4 py-2 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300" onClick={join} disabled={selected.playerCount >= selected.capacity}>
                참가
              </button>
            </div>
          ) : null}
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {["1라운드", "결승", "우승"].map((round, index) => (
              <div key={round} className="rounded-lg border border-line bg-slate-50 p-4">
                <p className="font-black text-blue-700">{round}</p>
                <div className="mt-4 grid gap-3">
                  {(selected?.entries ?? []).slice(index, index + 2).map((entry) => (
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
