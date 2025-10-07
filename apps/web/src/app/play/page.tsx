"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, Pause, Play, Send, Signal, Users } from "lucide-react";
import { parseServerEvent, type GameSnapshot } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { PongCanvas } from "@/components/PongCanvas";
import { requestWsTicket } from "@/lib/api";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

export default function PlayPage() {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState("대기 중");
  const [messages, setMessages] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const ticketRequestRef = useRef<AbortController | null>(null);
  const directionRef = useRef<-1 | 0 | 1>(0);
  const inputSequenceRef = useRef(0);
  const snapshotSequenceRef = useRef(-1);

  const score = useMemo(() => (snapshot ? `${snapshot.state.leftScore} - ${snapshot.state.rightScore}` : "경기 전"), [snapshot]);
  const phase = snapshot?.state.phase ?? "waiting";
  const canReady = Boolean(roomId && phase === "waiting");
  const canChat = Boolean(roomId && phase !== "finished" && chatInput.trim());
  const canPause = Boolean(roomId && phase === "playing");
  const canResume = Boolean(roomId && phase === "paused");
  const opponent = snapshot?.state.players.find((player) => player.side === "right");
  const opponentName = opponent?.displayName ?? "대기 중";
  const autoStartedRef = useRef(false);

  useEffect(() => () => closeCurrentSocket(), []);

  useEffect(() => {
    if (autoStartedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const tournamentMatchId = params.get("tournamentMatchId");
    const mode = params.get("mode");
    if (tournamentMatchId) {
      autoStartedRef.current = true;
      connectTournament(tournamentMatchId);
      return;
    }
    if (mode === "ai") {
      autoStartedRef.current = true;
      connect("ai");
      return;
    }
    if (mode === "queue") {
      autoStartedRef.current = true;
      connect("queue");
    }
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key.toLowerCase() === "w") {
        event.preventDefault();
        directionRef.current = -1;
      }
      if (event.key === "ArrowDown" || event.key.toLowerCase() === "s") {
        event.preventDefault();
        directionRef.current = 1;
      }
    };
    const stop = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "w", "W", "s", "S"].includes(event.key)) {
        event.preventDefault();
        directionRef.current = 0;
      }
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", stop);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", stop);
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId || phase !== "playing") return;
    const timer = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      inputSequenceRef.current += 1;
      socket.send(JSON.stringify({
        v: 1,
        type: "game.input",
        roomId,
        inputSeq: inputSequenceRef.current,
        direction: directionRef.current
      }));
    }, 50);
    return () => window.clearInterval(timer);
  }, [roomId, phase]);

  function connect(mode: "queue" | "ai") {
    openGameSocket(mode === "ai" ? "인공지능 연습 방 생성 중" : "매칭 큐 참가 중", { type: "queue.join", mode });
  }

  function connectTournament(matchId: string) {
    openGameSocket("토너먼트 경기 상대 입장 대기 중", { type: "tournament.join", matchId });
  }

  async function openGameSocket(openStatus: string, payload: Record<string, unknown>) {
    closeCurrentSocket();
    setRoomId(null);
    setSnapshot(null);
    setMessages([]);
    setChatInput("");
    directionRef.current = 0;
    inputSequenceRef.current = 0;
    snapshotSequenceRef.current = -1;
    setStatus("실시간 연결 준비 중");
    const controller = new AbortController();
    ticketRequestRef.current = controller;
    let ticketResponse;
    try {
      ticketResponse = await requestWsTicket(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setStatus("로그인 후 이용할 수 있습니다.");
      return;
    } finally {
      if (ticketRequestRef.current === controller) ticketRequestRef.current = null;
    }
    if (controller.signal.aborted) return;
    const socket = new WebSocket(
      `${WS_URL}?ticket=${encodeURIComponent(ticketResponse.ticket)}&v=${ticketResponse.protocolVersion}`
    );
    socketRef.current = socket;
    socket.onopen = () => {
      setStatus(openStatus);
      socket.send(JSON.stringify({ v: 1, ...payload }));
    };
    socket.onmessage = (event) => {
      const message = parseServerEvent(event.data);
      if (message.type === "queue.matched") {
        setRoomId(message.roomId);
        setStatus(`${message.opponent} 상대와 연결됨`);
      }
      if (message.type === "game.snapshot") {
        if (message.snapshot.sequence <= snapshotSequenceRef.current) return;
        snapshotSequenceRef.current = message.snapshot.sequence;
        setSnapshot(message.snapshot);
        if (message.snapshot.state.phase === "playing") setStatus("경기 진행 중");
        if (message.snapshot.state.phase === "paused") setStatus("일시정지 중");
        if (message.snapshot.state.phase === "waiting") setStatus("준비 대기 중");
      }
      if (message.type === "game.finished") {
        setRoomId(null);
        directionRef.current = 0;
        setSnapshot((current) => current ? {
          ...current,
          state: { ...current.state, phase: "finished" }
        } : current);
        setStatus(`경기 종료: ${message.result.leftScore} - ${message.result.rightScore}`);
      }
      if (message.type === "chat.message") setMessages((current) => [...current.slice(-5), `${message.message.sender.displayName}: ${message.message.body}`]);
      if (message.type === "error") setStatus(message.message);
    };
    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setRoomId(null);
      directionRef.current = 0;
      setStatus("연결 종료");
    };
  }

  function ready() {
    if (socketRef.current && canReady && roomId) {
      socketRef.current.send(JSON.stringify({ v: 1, type: "game.ready", roomId }));
      setStatus("준비 완료");
    }
  }

  function sendChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = chatInput.trim();
    if (!socketRef.current || !roomId || !body) return;
    socketRef.current.send(JSON.stringify({ v: 1, type: "chat.send", scope: "match", roomId, body }));
    setChatInput("");
  }

  function togglePause() {
    if (!socketRef.current || !roomId) return;
    if (canPause) {
      socketRef.current.send(JSON.stringify({ v: 1, type: "game.pause", roomId }));
      return;
    }
    if (canResume) {
      socketRef.current.send(JSON.stringify({ v: 1, type: "game.resume", roomId }));
    }
  }

  function closeCurrentSocket() {
    ticketRequestRef.current?.abort();
    ticketRequestRef.current = null;
    const socket = socketRef.current;
    if (!socket) return;
    socket.onclose = null;
    socket.onmessage = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    socketRef.current = null;
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
              <button
                className="focus-ring mt-4 rounded-lg border border-blue-200 px-4 py-2 text-sm font-black text-blue-700 disabled:cursor-not-allowed disabled:border-line disabled:text-muted"
                onClick={ready}
                disabled={!canReady}
              >
                <Play size={16} className="mr-2 inline" />
                준비
              </button>
            </div>
            <div className="card p-5">
              <h2 className="text-lg font-black text-ink">경기 제어</h2>
              <p className="mt-2 text-sm font-semibold text-muted">서버 경기 상태를 멈추거나 다시 시작합니다.</p>
              <button
                className="focus-ring mt-4 rounded-lg border border-line bg-white px-4 py-2 text-sm font-black text-ink disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-muted"
                onClick={togglePause}
                disabled={!canPause && !canResume}
              >
                <Pause size={16} className="mr-2 inline" />
                {canResume ? "다시 시작" : "일시정지"}
              </button>
            </div>
          </section>
        </section>
        <aside className="grid gap-5">
          <div className="card p-5">
            <h2 className="flex items-center gap-2 text-lg font-black text-ink">
              <Users size={20} /> 상대 정보
            </h2>
            <p className="mt-4 text-2xl font-black text-ink">{opponentName}</p>
            <p className="mt-2 text-sm font-semibold text-muted">{opponent?.ai ? "AI 상대입니다. 서버 경기 장면 기준으로 상태가 갱신됩니다." : "서버 경기 장면 기준으로 상태가 갱신됩니다."}</p>
          </div>
          <div className="card p-5">
            <h2 className="flex items-center gap-2 text-lg font-black text-ink">
              <MessageCircle size={20} /> 매치 채팅
            </h2>
            <div className="mt-4 grid gap-3">
              {messages.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line p-3 text-sm font-semibold text-muted">아직 매치 채팅이 없습니다.</div>
              ) : (
                messages.map((message, index) => (
                  <div key={`${message}-${index}`} className="rounded-lg bg-slate-50 p-3 text-sm font-semibold text-muted">
                    {message}
                  </div>
                ))
              )}
            </div>
            <form className="mt-4 flex gap-2" onSubmit={sendChat}>
              <input
                className="focus-ring min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-sm"
                placeholder="메시지 입력"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
              />
              <button className="focus-ring rounded-lg bg-blue-600 px-3 text-white disabled:cursor-not-allowed disabled:bg-slate-300" aria-label="보내기" disabled={!canChat}>
                <Send size={18} />
              </button>
            </form>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
