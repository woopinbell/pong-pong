"use client";

import { useMemo, useRef, useState } from "react";
import { Play, Signal } from "lucide-react";
import type { GameSnapshot, ServerEvent } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { PongCanvas } from "@/components/PongCanvas";
import { getToken } from "@/lib/api";
import { sampleSnapshot } from "@/lib/sample";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

export default function PlayPage() {
  const [snapshot, setSnapshot] = useState<GameSnapshot>(sampleSnapshot());
  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState("대기 중");
  const socketRef = useRef<WebSocket | null>(null);
  const score = useMemo(() => `${snapshot.leftScore} - ${snapshot.rightScore}`, [snapshot]);

  function connect(mode: "queue" | "ai") {
    const token = getToken();
    if (!token) {
      setStatus("로그인 후 이용할 수 있습니다.");
      return;
    }
    const socket = new WebSocket(`${WS_URL}?session=${token}`);
    socketRef.current = socket;
    socket.onopen = () => {
      setStatus(mode === "ai" ? "인공지능 연습 방 생성 중" : "매칭 큐 참가 중");
      socket.send(JSON.stringify({ type: "queue.join", mode }));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerEvent;
      if (message.type === "queue.matched") {
        setRoomId(message.roomId);
        setStatus(`${message.opponent} 상대와 연결됨`);
      }
      if (message.type === "game.snapshot") setSnapshot(message.snapshot);
      if (message.type === "game.finished") setStatus(`경기 종료: ${message.result.leftScore} - ${message.result.rightScore}`);
      if (message.type === "error") setStatus(message.message);
    };
    socket.onclose = () => setStatus("연결 종료");
  }

  function ready() {
    if (socketRef.current && roomId) {
      socketRef.current.send(JSON.stringify({ type: "game.ready", roomId }));
      setStatus("준비 완료");
    }
  }

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
              <button className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white" onClick={() => connect("queue")}>
                매칭 큐 참가
              </button>
              <button className="focus-ring rounded-lg bg-green-600 px-4 py-3 text-sm font-black text-white" onClick={() => connect("ai")}>
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
            <button className="focus-ring mt-4 rounded-lg border border-blue-200 px-4 py-2 text-sm font-black text-blue-700" onClick={ready}>
              <Play size={16} className="mr-2 inline" /> 준비
            </button>
          </section>
        </section>
      </div>
    </AppShell>
  );
}
