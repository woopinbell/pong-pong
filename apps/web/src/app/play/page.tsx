"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, MessageCircle, Pause, Play, Send, Signal, Users } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { PongCanvas } from "@/components/PongCanvas";
import { directionForKey, isEditableTarget } from "@/game/gameInput";
import { useGameConnection } from "@/game/useGameConnection";

export default function PlayPage() {
  const connection = useGameConnection();
  const {
    state: connectionState,
    connectQueue,
    ready: readyWithHook,
    sendChat: sendChatWithHook,
    togglePause: togglePauseWithHook
  } = connection;
  const [chatInput, setChatInput] = useState("");
  const inputDirectionRef = useRef<-1 | 0 | 1>(0);

  const activeSnapshot = connectionState.snapshot;
  const activeRoomId = connectionState.roomId;
  const score = useMemo(
    () => activeSnapshot ? `${activeSnapshot.state.leftScore} - ${activeSnapshot.state.rightScore}` : "경기 전",
    [activeSnapshot]
  );
  const canReady = Boolean(activeRoomId && connectionState.status === "waitingReady");
  const canChat = Boolean(
    activeRoomId
    && chatInput.trim()
    && ["waitingReady", "playing", "paused"].includes(connectionState.status)
  );
  const canPause = Boolean(activeRoomId && connectionState.status === "playing");
  const canResume = Boolean(activeRoomId && connectionState.status === "paused");
  const canMove = Boolean(activeRoomId && connectionState.status === "playing");
  const opponent = activeSnapshot?.state.players.find((player) => player.side === "right");
  const opponentName = connectionState.opponent ?? opponent?.displayName ?? "대기 중";
  const autoStartedRef = useRef(false);

  const changeDirection = useCallback((direction: -1 | 0 | 1) => {
    if (inputDirectionRef.current === direction) return;
    inputDirectionRef.current = direction;
    connection.sendDirection(direction);
  }, [connection.sendDirection]);

  useEffect(() => {
    inputDirectionRef.current = 0;
  }, [activeRoomId]);

  useEffect(() => {
    const resetDirection = () => changeDirection(0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target as HTMLElement | null)) {
        resetDirection();
        return;
      }
      const direction = directionForKey(event.key);
      if (direction === null) return;
      event.preventDefault();
      changeDirection(direction);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (directionForKey(event.key) === null) return;
      event.preventDefault();
      resetDirection();
    };
    const handleFocus = (event: FocusEvent) => {
      if (isEditableTarget(event.target as HTMLElement | null)) resetDirection();
    };
    const handleVisibility = () => {
      if (document.hidden) resetDirection();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", resetDirection);
    window.addEventListener("focusin", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", resetDirection);
      window.removeEventListener("focusin", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [changeDirection]);

  useEffect(() => {
    if (autoStartedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const tournamentMatchId = params.get("tournamentMatchId");
    const mode = params.get("mode");
    if (tournamentMatchId) {
      autoStartedRef.current = true;
      void connection.connectTournament(tournamentMatchId);
      return;
    }
    if (mode === "ai" || mode === "queue") {
      autoStartedRef.current = true;
      void connection.connectQueue(mode);
    }
  }, [connection.connectQueue, connection.connectTournament]);

  function startQueue(mode: "queue" | "ai") {
    inputDirectionRef.current = 0;
    setChatInput("");
    void connectQueue(mode);
  }

  function submitChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendChatWithHook(chatInput)) setChatInput("");
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
              <button className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white" onClick={() => startQueue("queue")}>
                매칭 큐 참가
              </button>
              <button className="focus-ring rounded-lg bg-green-600 px-4 py-3 text-sm font-black text-white" onClick={() => startQueue("ai")}>
                인공지능 연습 시작
              </button>
            </div>
          </div>
          <section className="card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-black text-green-600">
                <Signal size={18} /> {connectionState.notice}
              </div>
              <div className="text-2xl font-black text-ink">{score}</div>
            </div>
            <PongCanvas snapshot={activeSnapshot} />
            <div className="mt-4 grid grid-cols-2 gap-3 sm:hidden" aria-label="패들 조작">
              <button
                type="button"
                className="focus-ring touch-none select-none rounded-lg border border-line bg-white px-4 py-4 font-black text-ink disabled:bg-slate-50 disabled:text-muted"
                disabled={!canMove}
                onPointerDown={() => changeDirection(-1)}
                onPointerUp={() => changeDirection(0)}
                onPointerCancel={() => changeDirection(0)}
                onPointerLeave={() => changeDirection(0)}
              >
                <ArrowUp size={20} className="mr-2 inline" /> 위로
              </button>
              <button
                type="button"
                className="focus-ring touch-none select-none rounded-lg border border-line bg-white px-4 py-4 font-black text-ink disabled:bg-slate-50 disabled:text-muted"
                disabled={!canMove}
                onPointerDown={() => changeDirection(1)}
                onPointerUp={() => changeDirection(0)}
                onPointerCancel={() => changeDirection(0)}
                onPointerLeave={() => changeDirection(0)}
              >
                <ArrowDown size={20} className="mr-2 inline" /> 아래로
              </button>
            </div>
          </section>
          <section className="grid gap-4 md:grid-cols-2">
            <div className="card p-5">
              <h2 className="text-lg font-black text-ink">내 상태</h2>
              <p className="mt-2 text-sm font-semibold text-muted">방이 잡히면 준비 버튼으로 경기를 시작합니다.</p>
              <button
                className="focus-ring mt-4 rounded-lg border border-blue-200 px-4 py-2 text-sm font-black text-blue-700 disabled:cursor-not-allowed disabled:border-line disabled:text-muted"
                onClick={readyWithHook}
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
                onClick={togglePauseWithHook}
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
              {connectionState.messages.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line p-3 text-sm font-semibold text-muted">아직 매치 채팅이 없습니다.</div>
              ) : (
                connectionState.messages.map((message, index) => (
                  <div key={`${message}-${index}`} className="rounded-lg bg-slate-50 p-3 text-sm font-semibold text-muted">
                    {message}
                  </div>
                ))
              )}
            </div>
            <form className="mt-4 flex gap-2" onSubmit={submitChat}>
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
