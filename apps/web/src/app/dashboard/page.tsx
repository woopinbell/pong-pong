"use client";

import { useEffect, useState } from "react";
import { Flame, Target, Trophy, X } from "lucide-react";
import type { DashboardSummary, MatchSummary } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { StatCard } from "@/components/StatCard";
import { getDashboard } from "@/lib/api";
import { sampleDashboard } from "@/lib/sample";

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<DashboardSummary>(sampleDashboard);
  const ratingPoints = buildRatingPoints(dashboard.me.rating, dashboard.recentMatches);
  const chartPoints = toChartPoints(ratingPoints);

  useEffect(() => {
    getDashboard().then(setDashboard);
  }, []);

  return (
    <AppShell>
      <h1 className="text-3xl font-black text-ink">내 대시보드</h1>
      <p className="mt-2 text-sm font-semibold text-muted">최근 경기 흐름과 성장 지표를 한 화면에서 확인합니다.</p>
      <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Trophy} label="승리" value={String(dashboard.me.wins)} hint="누적 승리" tone="green" />
        <StatCard icon={X} label="패배" value={String(dashboard.me.losses)} hint="복기 대상" tone="red" />
        <StatCard icon={Target} label="승률" value={`${dashboard.winRate}%`} hint="최근 반영" />
        <StatCard icon={Flame} label="최고 연승" value={String(dashboard.bestStreak)} hint="이번 시즌" tone="amber" />
      </section>
      <section className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
        <div className="card p-5">
          <h2 className="text-lg font-black text-ink">점수 흐름</h2>
          <div className="mt-5 h-64 rounded-lg border border-line bg-gradient-to-b from-blue-50 to-white p-5">
            <svg viewBox="0 0 640 220" className="h-full w-full" role="img" aria-label="점수 상승 그래프">
              <polyline points={chartPoints} fill="none" stroke="#1768f2" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="0" y1="180" x2="640" y2="180" stroke="#d8e1ef" />
              <line x1="0" y1="110" x2="640" y2="110" stroke="#d8e1ef" strokeDasharray="8 8" />
            </svg>
          </div>
          <p className="mt-3 text-sm font-bold text-muted">현재 점수 {dashboard.me.rating} 기준 최근 경기 변화를 역산해 표시합니다.</p>
        </div>
        <div className="card p-5">
          <h2 className="text-lg font-black text-ink">최근 경기</h2>
          <div className="mt-4 divide-y divide-line">
            {dashboard.recentMatches.length === 0 ? <p className="py-4 text-sm font-semibold text-muted">아직 저장된 경기가 없습니다.</p> : null}
            {dashboard.recentMatches.map((match) => (
              <div key={match.id} className="grid grid-cols-[80px_1fr_70px] items-center gap-3 py-3 text-sm font-bold">
                <span className={`rounded-full px-3 py-1 text-center ${match.result === "win" ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600"}`}>{match.result === "win" ? "승리" : "패배"}</span>
                <span className="text-muted">{match.opponentHandle}</span>
                <span className="text-right text-ink">
                  {match.scoreLeft} - {match.scoreRight}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </AppShell>
  );
}

function buildRatingPoints(currentRating: number, recentMatches: MatchSummary[]): number[] {
  const reversed = [...recentMatches].reverse();
  let rating = currentRating - reversed.reduce((sum, match) => sum + match.ratingDelta, 0);
  const points = [rating];
  for (const match of reversed) {
    rating += match.ratingDelta;
    points.push(rating);
  }
  return points.length === 1 ? [currentRating - 1, currentRating] : points;
}

function toChartPoints(points: number[]): string {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = Math.max(1, max - min);
  return points
    .map((point, index) => {
      const x = points.length === 1 ? 0 : (index / (points.length - 1)) * 640;
      const y = 190 - ((point - min) / range) * 150;
      return `${Math.round(x)},${Math.round(y)}`;
    })
    .join(" ");
}
