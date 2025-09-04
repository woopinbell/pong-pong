"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, Pause, Play, Send, Signal, Users } from "lucide-react";
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
  const [messages, setMessages] = useState<string[]>(["매치 채팅이 준비되었습니다."]);
  const socketRef = useRef<WebSocket | null>(null);

  const score = useMemo(() => `${snapshot.leftScore} - ${snapshot.rightScore}`, [snapshot]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const socket = socketRef.current;
      if (!socket || !roomId) return;
      if (event.key === "ArrowUp" || event.key.toLowerCase() === "w") socket.send(JSON.stringify({ type: "game.input", roomId, direction: -1 }));
      if (event.key === "ArrowDown" || event.key.toLowerCase() === "s") socket.send(JSON.stringify({ type: "game.input", roomId, direction: 1 }));
    };
    const stop = () => {
      const socket = socketRef.current;
      if (socket && roomId) socket.send(JSON.stringify({ type: "game.input", roomId, direction: 0 }));
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", stop);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", stop);
    };
  }, [roomId]);

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
      if (message.type === "chat.message") setMessages((current) => [...current.slice(-5), `${message.message.sender.displayName}: ${message.message.body}`]);
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
      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
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
          <section className="grid gap-4 md:grid-cols-2">
            <div className="card p-5">
              <h2 className="text-lg font-black text-ink">내 상태</h2>
              <p className="mt-2 text-sm font-semibold text-muted">방이 잡히면 준비 버튼으로 경기를 시작합니다.</p>
              <button className="focus-ring mt-4 rounded-lg border border-blue-200 px-4 py-2 text-sm font-black text-blue-700" onClick={ready}>
                <Play size={16} className="mr-2 inline" />
                준비
              </button>
            </div>
            <div className="card p-5">
              <h2 className="text-lg font-black text-ink">경기 제어</h2>
              <p className="mt-2 text-sm font-semibold text-muted">일시정지는 화면 상태만 멈추고 서버 연결은 유지합니다.</p>
              <button className="focus-ring mt-4 rounded-lg border border-line px-4 py-2 text-sm font-black text-ink">
                <Pause size={16} className="mr-2 inline" />
                일시정지
              </button>
            </div>
          </section>
        </section>
        <aside className="grid gap-5">
          <div className="card p-5">
            <h2 className="flex items-center gap-2 text-lg font-black text-ink">
              <Users size={20} /> 상대 정보
            </h2>
            <p className="mt-4 text-2xl font-black text-ink">{snapshot.players.find((player) => player.side === "right")?.displayName ?? "대기 중"}</p>
            <p className="mt-2 text-sm font-semibold text-muted">서버 경기 장면 기준으로 상태가 갱신됩니다.</p>
          </div>
          <div className="card p-5">
            <h2 className="flex items-center gap-2 text-lg font-black text-ink">
              <MessageCircle size={20} /> 매치 채팅
            </h2>
            <div className="mt-4 grid gap-3">
              {messages.map((message, index) => (
                <div key={`${message}-${index}`} className="rounded-lg bg-slate-50 p-3 text-sm font-semibold text-muted">
                  {message}
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <input className="focus-ring min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-sm" placeholder="메시지 입력" />
              <button className="focus-ring rounded-lg bg-blue-600 px-3 text-white" aria-label="보내기">
                <Send size={18} />
              </button>
            </div>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
