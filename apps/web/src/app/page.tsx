"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Clock, MessageCircle, Trophy, Users, Zap } from "lucide-react";
import { parseServerEvent, type LobbyResponse } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { LoginPanel } from "@/components/LoginPanel";
import { PongCanvas } from "@/components/PongCanvas";
import { StatCard } from "@/components/StatCard";
import { requestWsTicket, sendLobbyChat } from "@/lib/api";
import {
  demoLobbyPresentation,
  formatTransientResultNotice,
  isDemoMode,
  shouldResumeGameFromLobby
} from "@/lib/demoPolicy";
import {
  invalidateExactQueries,
  lobbyQueryOptions,
  meQueryOptions,
  mutationInvalidations,
  queryKeys
} from "@/lib/query";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

export default function HomePage() {
  const demoMode = isDemoMode();
  const queryClient = useQueryClient();
  const meQuery = useQuery(meQueryOptions());
  const lobbyQuery = useQuery(lobbyQueryOptions());
  const lobby = lobbyQuery.data;
  const me = lobby?.me ?? meQuery.data ?? null;
  const players = lobby?.onlinePlayers ?? [];
  const chat = lobby?.chat ?? [];
  const stats = lobby?.stats ?? null;
  const [chatInput, setChatInput] = useState("");
  const [notice, setNotice] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const userId = me?.id;
  const chatMutation = useMutation({
    mutationFn: (body: string) => sendLobbyChat(body),
    onSuccess: async (message) => {
      // [INTV:PERF] setQueryData에 값 대신 함수를 넘기는 형태 — "지금 캐시에 있는 값(current)을
      // 받아 새 값을 계산해 돌려달라"는 뜻이다. 서버를 다시 조회하지 않고도 방금 보낸 메시지를 그
      // 자리에서 채팅 목록에 얹는다(optimistic update와 유사한 즉각 반영 — 다만 여긴 서버 응답
      // 이후 실행되므로 진짜 optimistic은 아니고, "왕복 재조회 없이 결과로 캐시를 직접 갱신"하는
      // 방식). current가 아직 없으면(로비 데이터를 아직 못 받았으면) 억지로 만들어내지 않고 그대로
      // 둔다 — 없는 상태에 억지로 부분 데이터를 채우면 타입은 맞아도 나머지 필드가 빠진 불완전한
      // 캐시가 된다.
      queryClient.setQueryData<LobbyResponse>(queryKeys.lobby(), (current) => current ? {
        ...current,
        chat: [...current.chat.filter((item) => item.id !== message.id).slice(-19), message]
      } : current);
      await invalidateExactQueries(queryClient, mutationInvalidations.lobbyChat());
    }
  });

  // [INTV:ARCH] 이 소켓은 game/useGameConnection.ts의 GameSocketClient와는 별개다 — 저건 실제
  // 대국(매치) 중 재접속까지 챙기는 전용 커넥션이고, 이건 로비를 둘러보는 동안의 접속자 수/로비
  // 채팅만을 위한 훨씬 단순한(재연결 로직 없는) 1회성 연결이다. cancelled 플래그 + AbortController
  // 조합은 GameSocketClient의 generation 취소 기법을 이렇게 짧은 effect 하나짜리 용도에 맞게 간단히
  // 축약한 버전이라고 볼 수 있다 — "얼마나 복잡한 취소 로직이 필요한가"는 재연결처럼 상태가 오래
  // 지속되는 경우(generation 카운터)와, 컴포넌트 하나의 생명주기 안에서 끝나는 경우(단순 플래그)에
  // 따라 달라진다.
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
          // [INTV:EDGE] 데모 게스트가 대국 도중 실수로 로비로 돌아왔는데 서버 입장에서는 여전히
          // 그 경기에 참여 중인 상태(roomSession.ts의 재접속 유예 시간 15초 안)라면, 로비 소켓으로
          // 매치 관련 이벤트가 새어 들어올 수 있다 — 그 경우 다시 /play로 돌려보내 원래 진행 중이던
          // 경기 화면으로 복귀시킨다(서버는 이 유저를 여전히 "그 방에 있는 것"으로 취급하므로,
          // 클라이언트 UI도 그 사실을 존중해 강제로 되돌려야 한다).
          if (demoMode && shouldResumeGameFromLobby(message)) {
            window.location.assign("/play");
            return;
          }
          if (message.type === "game.finished" && !message.result.persisted) {
            setNotice(formatTransientResultNotice(message.result));
            return;
          }
          if (message.type === "chat.message" && message.message.scope === "lobby") {
            queryClient.setQueryData<LobbyResponse>(queryKeys.lobby(), (current) => current ? {
              ...current,
              chat: [...current.chat.filter((item) => item.id !== message.message.id).slice(-19), message.message]
            } : current);
          }
          if (message.type === "presence.changed") {
            invalidateExactQueries(queryClient, [queryKeys.lobby()])
              .catch(() => setNotice("로비 지표를 갱신하지 못했습니다."));
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
  }, [demoMode, queryClient, userId]);

  async function submitLobbyChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = chatInput.trim();
    if (!body) return;
    try {
      const socket = socketRef.current;
      // [INTV:TRADE_OFF] 실시간 소켓이 열려 있으면 그걸로 바로 보내고(더 빠르고, 서버가 알아서
      // 브로드캐스트해준다), 소켓이 아직 없거나 끊겼으면 REST 엔드포인트(sendLobbyChat)로 대신
      // 보낸다 — 실시간 연결에 문제가 있어도 채팅 자체는 계속 동작하게 하는 점진적 성능 저하
      // (graceful degradation) 설계(PongCanvas의 selectRenderSnapshot이 보간 짝이 없을 때 차선책을
      // 쓰는 것과 같은 철학 — 이상적인 경로가 막혀도 기능 자체는 죽지 않게 한다).
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ v: 1, type: "chat.send", scope: "lobby", body }));
      } else {
        await chatMutation.mutateAsync(body);
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
          <LoginPanel />
          <section className="card hidden p-6 lg:block">
            <PongCanvas />
            <div className="mt-5 grid grid-cols-3 gap-3 text-center text-sm font-bold text-muted">
              <div>실시간 매칭</div>
              <div>서버 판정</div>
              <div>{demoMode ? "결과 미저장" : "전적 저장"}</div>
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
          <p className="mt-3 max-w-xl text-sm font-semibold leading-6 text-muted">
            {demoMode
              ? demoLobbyPresentation.description
              : "빠른 매칭으로 상대를 찾거나 인공지능을 상대로 손을 풀어 보세요. 경기가 끝나면 전적과 순위가 바로 갱신됩니다."}
          </p>
          {/* [INTV:EDGE] role="status": 이 영역의 텍스트가 바뀔 때 스크린 리더가 사용자가 따로
              포커스를 옮기지 않아도 자동으로 읽어주게 하는 ARIA 라이브 리전 역할 — 알림성 메시지에
              적합한 접근성 처리(role 없이 그냥 <p>였다면, 스크린 리더 사용자는 이 알림이 떴다는
              걸 알 방법이 없다). */}
          {notice ? (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700" role="status">
              {notice}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-3">
            <a className="focus-ring rounded-lg bg-blue-600 px-5 py-3 text-sm font-black text-white" href="/play">
              빠른 매칭
            </a>
            {demoLobbyPresentation.showLeaderboardLink || !demoMode ? (
              <a className="focus-ring rounded-lg border border-line bg-white px-5 py-3 text-sm font-black text-ink" href="/leaderboard">
                순위표 보기
              </a>
            ) : null}
          </div>
        </div>
        <PongCanvas />
      </section>
      <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {!demoMode || demoLobbyPresentation.showPersistedProgress ? (
          <>
            <StatCard icon={Trophy} label="승리" value={String(me.wins)} hint="누적 전적" tone="green" />
            <StatCard icon={Zap} label="점수" value={String(me.rating)} hint="최근 경기 반영" />
          </>
        ) : null}
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
        {!demoMode || demoLobbyPresentation.showLobbyChat ? (
          <div className="card p-5">
            <h2 className="flex items-center gap-2 text-lg font-black text-ink">
              <MessageCircle size={20} /> 로비 채팅
            </h2>
            {notice || lobbyQuery.isError ? <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700">{notice || "서버 로비 정보를 불러오지 못했습니다."}</p> : null}
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
        ) : null}
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
