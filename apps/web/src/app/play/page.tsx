"use client";

import { useMemo, useState } from "react";
import { Play, Signal } from "lucide-react";
import type { GameSnapshot } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { PongCanvas } from "@/components/PongCanvas";
import { sampleSnapshot } from "@/lib/sample";

export default function PlayPage() {
  const [snapshot] = useState<GameSnapshot>(sampleSnapshot());
  const [status] = useState("대기 중");
  const score = useMemo(() => `${snapshot.leftScore} - ${snapshot.rightScore}`, [snapshot]);

  return (
    <AppShell>
      <div className="grid gap-5">
        <section className="grid gap-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-black text-ink">경기장</h1>
              <p className="mt-2 text-sm font-semibold text-muted">키보드 위쪽과 아래쪽 방향키로 패들을 움직입니다.</p>
            </div>
            <div className="flex gap-3">
              <button className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white">
                매칭 큐 참가
              </button>
              <button className="focus-ring rounded-lg bg-green-600 px-4 py-3 text-sm font-black text-white">
                인공지능 연습 시작
              </button>
            </div>
          </div>
          <section className="card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-black text-green-600">
                <Signal size={18} /> {status}
              </div>
              <div className="text-2xl font-black text-ink">{score}</div>
            </div>
            <PongCanvas snapshot={snapshot} />
          </section>
          <section className="card p-5">
            <h2 className="text-lg font-black text-ink">내 상태</h2>
            <p className="mt-2 text-sm font-semibold text-muted">방이 잡히면 준비 버튼으로 경기를 시작합니다.</p>
            <button className="focus-ring mt-4 rounded-lg border border-blue-200 px-4 py-2 text-sm font-black text-blue-700">
              <Play size={16} className="mr-2 inline" /> 준비
            </button>
          </section>
        </section>
      </div>
    </AppShell>
  );
}
