"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Clock, MessageCircle, Trophy, Users, Zap } from "lucide-react";
import { parseServerEvent, type ChatMessage, type LobbyStats, type PublicUser, type SessionUser } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { LoginPanel } from "@/components/LoginPanel";
import { PongCanvas } from "@/components/PongCanvas";
import { StatCard } from "@/components/StatCard";
import { getLobby, getMe, requestWsTicket, sendLobbyChat } from "@/lib/api";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

export default function HomePage() {
  const [me, setMe] = useState<SessionUser | null>(null);
  const [players, setPlayers] = useState<PublicUser[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [stats, setStats] = useState<LobbyStats | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [notice, setNotice] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const userId = me?.id;

  const loadLobby = useCallback(async () => {
    const lobby = await getLobby();
    setPlayers(lobby.onlinePlayers);
    setChat(lobby.chat);
    setStats(lobby.stats);
    if (lobby.me) setMe(lobby.me);
    setNotice("");
  }, []);

  useEffect(() => {
    getMe().then(setMe);
    loadLobby().catch(() => setNotice("서버 로비 정보를 불러오지 못했습니다."));
  }, [loadLobby]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    const controller = new AbortController();

    requestWsTicket(controller.signal)
      .then(({ ticket, protocolVersion }) => {
        if (cancelled) return;
        socket = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}&v=${protocolVersion}`);
        socketRef.current = socket;
        socket.onmessage = (event) => {
          const message = parseServerEvent(event.data);
          if (message.type === "chat.message" && message.message.scope === "lobby") {
            setChat((current) => [...current.filter((item) => item.id !== message.message.id).slice(-19), message.message]);
          }
          if (message.type === "presence.changed") {
            loadLobby().catch(() => setNotice("로비 지표를 갱신하지 못했습니다."));
          }
          if (message.type === "error") setNotice(message.message);
        };
        socket.onclose = () => {
          if (socketRef.current === socket) socketRef.current = null;
        };
      })
      .catch(() => {
        if (!cancelled) setNotice("실시간 연결을 준비하지 못했습니다.");
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (!socket) return;
      socket.onclose = null;
      socket.onmessage = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [loadLobby, userId]);

  async function submitLobbyChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = chatInput.trim();
    if (!body) return;
    try {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ v: 1, type: "chat.send", scope: "lobby", roomId: null, body }));
      } else {
        const message = await sendLobbyChat(body);
        setChat((current) => [...current.slice(-19), message]);
      }
      setChatInput("");
      setNotice("");
    } catch {
      setNotice("로비 채팅 전송에 실패했습니다.");
    }
  }

  if (!me) {
    return (
      <div className="min-h-screen bg-slate-50 p-4">
        <div className="mx-auto grid min-h-[calc(100vh-32px)] max-w-6xl items-center gap-6 lg:grid-cols-[420px_1fr]">
          <LoginPanel onLogin={setMe} />
          <section className="card hidden p-6 lg:block">
            <PongCanvas />
            <div className="mt-5 grid grid-cols-3 gap-3 text-center text-sm font-bold text-muted">
              <div>실시간 매칭</div>
              <div>서버 판정</div>
              <div>전적 저장</div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <AppShell>
      <section className="card grid gap-5 p-6 lg:grid-cols-[1fr_420px] lg:items-center">
        <div>
          <p className="text-sm font-black text-blue-700">온라인 로비</p>
          <h1 className="mt-2 text-3xl font-black text-ink">다시 오신 것을 환영합니다, {me.displayName}</h1>
          <p className="mt-3 max-w-xl text-sm font-semibold leading-6 text-muted">빠른 매칭으로 상대를 찾거나 인공지능을 상대로 손을 풀어 보세요. 경기가 끝나면 전적과 순위가 바로 갱신됩니다.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <a className="focus-ring rounded-lg bg-blue-600 px-5 py-3 text-sm font-black text-white" href="/play">
              빠른 매칭
            </a>
            <a className="focus-ring rounded-lg border border-line bg-white px-5 py-3 text-sm font-black text-ink" href="/leaderboard">
              순위표 보기
            </a>
          </div>
        </div>
        <PongCanvas />
      </section>
      <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Trophy} label="승리" value={String(me.wins)} hint="누적 전적" tone="green" />
        <StatCard icon={Zap} label="점수" value={String(me.rating)} hint="최근 경기 반영" />
        <StatCard icon={Users} label="온라인" value={stats ? String(stats.onlinePlayers) : "확인 중"} hint={`경기 중 ${stats?.playingPlayers ?? 0}명`} tone="green" />
        <StatCard icon={Clock} label="대기" value={stats?.averageWaitSeconds == null ? "대기 없음" : `${stats.averageWaitSeconds}초`} hint={`큐 ${stats?.queuedPlayers ?? 0}명 · 방 ${stats?.activeRooms ?? 0}개`} tone="amber" />
      </section>
      <section className="mt-5 grid gap-5 xl:grid-cols-[1fr_1fr]">
        <div className="card p-5">
          <h2 className="flex items-center gap-2 text-lg font-black text-ink">
            <Users size={20} /> 활성 선수
          </h2>
          <div className="mt-4 divide-y divide-line">
            {players.length === 0 ? <p className="py-4 text-sm font-semibold text-muted">현재 표시할 활성 선수가 없습니다.</p> : null}
            {players.map((player) => (
              <div key={player.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-black text-ink">{player.displayName}</p>
                  <p className="text-sm font-semibold text-muted">점수 {player.rating}</p>
                </div>
                <div className="text-right text-sm font-black text-green-600">{player.rating}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card p-5">
          <h2 className="flex items-center gap-2 text-lg font-black text-ink">
            <MessageCircle size={20} /> 로비 채팅
          </h2>
          {notice ? <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700">{notice}</p> : null}
          <div className="mt-4 grid gap-3">
            {chat.length === 0 ? <div className="rounded-lg border border-dashed border-line p-3 text-sm font-semibold text-muted">아직 로비 채팅이 없습니다.</div> : null}
            {chat.map((message) => (
              <div key={message.id} className="rounded-lg bg-slate-50 p-3">
                <p className="text-sm font-black text-blue-700">{message.sender.displayName}</p>
                <p className="mt-1 text-sm font-semibold text-muted">{message.body}</p>
              </div>
            ))}
          </div>
          <form className="mt-4 flex gap-2" onSubmit={submitLobbyChat}>
            <input
              className="focus-ring min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-sm font-semibold"
              placeholder="로비 메시지 입력"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
            />
            <button className="focus-ring rounded-lg bg-blue-600 px-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300" disabled={!chatInput.trim()}>
              보내기
            </button>
          </form>
        </div>
      </section>
      <section className="mt-5 grid gap-4 md:grid-cols-2">
        <a className="focus-ring card block border-2 border-blue-600 bg-white p-6 text-ink transition hover:-translate-y-0.5 hover:shadow-xl" href="/play?mode=queue">
          <Users size={28} />
          <h2 className="mt-3 text-xl font-black">매칭 큐 참가</h2>
          <p className="mt-2 text-sm font-semibold text-muted">비슷한 점수의 상대를 찾고, 없으면 AI 상대를 배정합니다.</p>
          <span className="mt-4 inline-flex rounded-lg bg-blue-600 px-4 py-2 text-sm font-black text-white">큐 참가</span>
        </a>
        <a className="focus-ring card block border-2 border-green-600 bg-white p-6 text-ink transition hover:-translate-y-0.5 hover:shadow-xl" href="/play?mode=ai">
          <Bot size={28} />
          <h2 className="mt-3 text-xl font-black">인공지능 연습</h2>
          <p className="mt-2 text-sm font-semibold text-muted">서버 박자 기반 상대와 바로 연습합니다.</p>
          <span className="mt-4 inline-flex rounded-lg bg-green-600 px-4 py-2 text-sm font-black text-white">연습 시작</span>
        </a>
      </section>
    </AppShell>
  );
}
