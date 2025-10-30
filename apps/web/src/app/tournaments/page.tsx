"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trophy } from "lucide-react";
import type { SessionUser, TournamentMatchSummary } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { createTournament, joinTournament } from "@/lib/api";
import {
  invalidateExactQueries,
  meQueryOptions,
  mutationInvalidations,
  tournamentsQueryOptions
} from "@/lib/query";

export default function TournamentsPage() {
  const queryClient = useQueryClient();
  const tournamentsQuery = useQuery(tournamentsQueryOptions());
  const { data: me = null } = useQuery(meQueryOptions());
  const items = tournamentsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState("");
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const message = notice || (tournamentsQuery.isError
    ? "대회 목록을 불러오지 못했습니다."
    : tournamentsQuery.isPending
      ? "대회 목록을 불러오는 중입니다."
      : items.length === 0
        ? "진행 중인 대회가 없습니다."
        : "대회를 선택하면 브래킷과 참가 상태를 확인할 수 있습니다.");
  const createMutation = useMutation({
    mutationFn: () => createTournament("새로운 퐁퐁 컵"),
    onSuccess: async (tournament) => {
      setSelectedId(tournament.id);
      setNotice(`${tournament.name}을 생성했습니다.`);
      await invalidateExactQueries(queryClient, mutationInvalidations.tournamentChange());
    },
    onError: () => setNotice("토너먼트 생성에는 로그인이 필요합니다.")
  });
  const joinMutation = useMutation({
    mutationFn: (id: string) => joinTournament(id),
    onSuccess: async (tournament) => {
      setSelectedId(tournament.id);
      setNotice(`${tournament.name}에 참가했습니다.`);
      await invalidateExactQueries(queryClient, mutationInvalidations.tournamentChange());
    },
    onError: () => setNotice("토너먼트 참가에는 로그인이 필요합니다.")
  });

  function create() {
    if (!createMutation.isPending) {
      createMutation.mutate();
    }
  }

  function join() {
    if (!selected) return;
    joinMutation.mutate(selected.id);
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-ink">토너먼트</h1>
          <p className="mt-2 text-sm font-semibold text-muted">4인 싱글 엘리미네이션으로 짧은 컵 대회를 운영합니다.</p>
          <p className="mt-2 text-sm font-bold text-blue-700">{message}</p>
        </div>
        <button className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300" onClick={create} disabled={createMutation.isPending}>
          <Plus size={18} className="mr-2 inline" />
          토너먼트 생성
        </button>
      </div>
      <section className="mt-5 grid gap-5 xl:grid-cols-[320px_1fr]">
        <div className="card p-5">
          <h2 className="text-lg font-black text-ink">진행 중인 대회</h2>
          <div className="mt-4 grid gap-3">
            {items.length === 0 ? <p className="rounded-lg border border-dashed border-line p-4 text-sm font-semibold text-muted">표시할 대회가 없습니다.</p> : null}
            {items.map((item) => (
              <button
                key={item.id}
                className={`focus-ring rounded-lg border p-4 text-left hover:border-blue-300 ${selected?.id === item.id ? "border-blue-500 bg-blue-50" : "border-line"}`}
                onClick={() => {
                  setSelectedId(item.id);
                  setNotice(`${item.name}을 선택했습니다.`);
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
                  {selected.winner ? ` · 우승 ${selected.winner.displayName}` : ""}
                </p>
              </div>
              <button className="focus-ring rounded-lg bg-green-600 px-4 py-2 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300" onClick={join} disabled={selected.playerCount >= selected.capacity || joinMutation.isPending}>
                참가
              </button>
            </div>
          ) : null}
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <BracketColumn title="준결승" matches={(selected?.matches ?? []).filter((match) => match.round === "semifinal")} me={me} />
            <BracketColumn title="결승" matches={(selected?.matches ?? []).filter((match) => match.round === "final")} me={me} />
            <div className="rounded-lg border border-line bg-slate-50 p-4">
              <p className="font-black text-blue-700">우승</p>
              <div className="mt-4 rounded-lg bg-white px-3 py-2 text-sm font-bold text-ink shadow-sm">{selected?.winner?.displayName ?? "대기 중"}</div>
            </div>
          </div>
          {selected && selected.matches.length === 0 ? <p className="mt-4 text-sm font-semibold text-muted">4명이 참가하면 실제 경기 브래킷이 생성됩니다.</p> : null}
        </div>
      </section>
    </AppShell>
  );
}

function BracketColumn({ title, matches, me }: { title: string; matches: TournamentMatchSummary[]; me: SessionUser | null }) {
  return (
    <div className="rounded-lg border border-line bg-slate-50 p-4">
      <p className="font-black text-blue-700">{title}</p>
      <div className="mt-4 grid gap-3">
        {matches.length === 0 ? <div className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-muted shadow-sm">대기 중</div> : null}
        {matches.map((match) => {
          const participant = Boolean(me && (match.left?.id === me.id || match.right?.id === me.id));
          const canEnter = participant && match.status === "ready";
          return (
            <div key={match.id} className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-ink shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span>{match.left?.displayName ?? "대기"}</span>
                <span className="text-muted">vs</span>
                <span>{match.right?.displayName ?? "대기"}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
                <span>{match.status === "finished" ? `${match.scoreLeft} - ${match.scoreRight}` : statusLabel(match.status)}</span>
                {canEnter ? <a className="rounded-md bg-blue-600 px-2 py-1 font-black text-white" href={`/play?tournamentMatchId=${match.id}`}>경기 입장</a> : null}
              </div>
              {match.winner ? <p className="mt-2 text-xs font-black text-green-600">승자 {match.winner.displayName}</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function statusLabel(status: TournamentMatchSummary["status"]): string {
  if (status === "ready") return "입장 가능";
  if (status === "running") return "진행 중";
  if (status === "finished") return "종료";
  return "대기 중";
}
