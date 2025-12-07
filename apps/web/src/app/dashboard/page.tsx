"use client";

import { useQuery } from "@tanstack/react-query";
import { Flame, Target, Trophy, X } from "lucide-react";
import type { MatchSummary } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { StatCard } from "@/components/StatCard";
import { dashboardQueryOptions } from "@/lib/query";

export default function DashboardPage() {
  const dashboardQuery = useQuery(dashboardQueryOptions());
  const dashboard = dashboardQuery.data;

  if (!dashboard) {
    return (
      <AppShell>
        <h1 className="text-3xl font-black text-ink">내 대시보드</h1>
        <p className="mt-4 rounded-lg border border-line bg-white p-4 text-sm font-bold text-muted">
          {dashboardQuery.isError ? "대시보드를 불러오려면 로그인 상태와 서버 연결을 확인해야 합니다." : "대시보드를 불러오는 중입니다."}
        </p>
      </AppShell>
    );
  }

  const hasRatingHistory = dashboard.recentMatches.length > 0;
  const ratingPoints = hasRatingHistory ? buildRatingPoints(dashboard.me.rating, dashboard.recentMatches) : [];
  const chartPoints = hasRatingHistory ? toChartPoints(ratingPoints) : "";

  return (
    <AppShell>
      <h1 className="text-3xl font-black text-ink">내 대시보드</h1>
      <p className="mt-2 text-sm font-semibold text-muted">최근 경기 흐름과 성장 지표를 한 화면에서 확인합니다.</p>
      <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Trophy} label="승리" value={String(dashboard.me.wins)} hint="누적 승리" tone="green" />
        <StatCard icon={X} label="패배" value={String(dashboard.me.losses)} hint="복기 대상" tone="red" />
        <StatCard icon={Target} label="승률" value={`${dashboard.winRate}%`} hint="최근 반영" />
        <StatCard icon={Flame} label="최고 연승" value={String(dashboard.bestStreak)} hint="최근 경기" tone="amber" />
      </section>
      <section className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
        <div className="card p-5">
          <h2 className="text-lg font-black text-ink">점수 흐름</h2>
          <div className="mt-5 h-64 rounded-lg border border-line bg-gradient-to-b from-blue-50 to-white p-5">
            {hasRatingHistory ? (
              // [INTV:ARCH] viewBox="0 0 640 220": SVG 내부 좌표계를 640x220으로 고정해두고, 실제
              // 화면에 그려지는 크기(className의 h-full w-full)에 맞춰 그 좌표계를 비율대로 늘리거나
              // 줄인다 — 그래서 아래 polyline의 좌표는 항상 이 640x220 기준으로만 계산하면 된다.
              <svg viewBox="0 0 640 220" className="h-full w-full" role="img" aria-label="점수 상승 그래프">
                <polyline points={chartPoints} fill="none" stroke="#1768f2" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="0" y1="180" x2="640" y2="180" stroke="#d8e1ef" />
                <line x1="0" y1="110" x2="640" y2="110" stroke="#d8e1ef" strokeDasharray="8 8" />
              </svg>
            ) : (
              <div className="flex h-full items-center justify-center text-center text-sm font-bold text-muted">저장된 경기 후 점수 흐름이 표시됩니다.</div>
            )}
          </div>
          <p className="mt-3 text-sm font-bold text-muted">
            {hasRatingHistory ? `현재 점수 ${dashboard.me.rating} 기준 최근 경기 변화를 역산해 표시합니다.` : "아직 저장된 경기가 없어 점수 흐름을 표시하지 않습니다."}
          </p>
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

// [INTV:ARCH] 서버는 "각 경기에서 점수가 얼마나 변했는지(ratingDelta)"와 "지금 최종 점수"만 갖고
// 있고, 과거 시점의 점수 자체는 따로 저장하지 않는다(rating_history 테이블이 DB에 있지만 이 화면은
// 그걸 조회하지 않고 즉석에서 역산한다). 그래서 최신 경기부터 역순으로 각 델타를 거꾸로 빼나가면
// (reduce로 전체 델타 합을 구해 현재 점수에서 빼면 "맨 처음" 점수가 나오고), 다시 시간 순서대로
// 하나씩 더해가며 그 사이 시점들의 점수를 역산해낸다 — 별도 이력 테이블 조회 없이도 클라이언트에서
// 점수 추이 그래프를 그릴 수 있는 방법.
function buildRatingPoints(currentRating: number, recentMatches: MatchSummary[]): number[] {
  const reversed = [...recentMatches].reverse();
  let rating = currentRating - reversed.reduce((sum, match) => sum + match.ratingDelta, 0);
  const points = [rating];
  for (const match of reversed) {
    rating += match.ratingDelta;
    points.push(rating);
  }
  return points;
}

// [INTV:ARCH] 점수 값들을 SVG <polyline points="x1,y1 x2,y2 ..."> 문자열로 바꾼다. x는 점 순서를
// 0~640에 고르게 펼치고, y는 min~max 범위를 0~150 높이에 맞춰 정규화한다 — SVG의 y좌표는 아래로
// 갈수록 커지므로(화면 좌표계와 같은 방향), 190에서 빼는 식으로 "값이 클수록 위로" 가도록 뒤집는다
// (이 반전을 빼먹으면 그래프가 상하로 뒤집혀 보인다 — 데이터 값과 시각적 방향이 반대인 좌표계를
// 다룰 때 흔히 놓치는 지점).
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
