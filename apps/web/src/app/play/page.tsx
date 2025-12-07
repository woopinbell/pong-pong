"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, MessageCircle, Pause, Play, Send, Signal, Users } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { demoLobbyPresentation, isDemoMode } from "@/lib/demoPolicy";
import { PongCanvas } from "@/components/PongCanvas";
import { directionForKey, isEditableTarget } from "@/game/gameInput";
import { canStartNewMatch } from "@/game/gameConnection";
import { useGameConnection } from "@/game/useGameConnection";

export default function PlayPage() {
  const demoMode = isDemoMode();
  const {
    state,
    connectQueue,
    connectTournament,
    ready,
    sendChat,
    togglePause,
    sendDirection
  } = useGameConnection();
  const [chatInput, setChatInput] = useState("");
  const autoStartedRef = useRef(false);
  const inputDirectionRef = useRef<-1 | 0 | 1>(0);

  const { snapshot, roomId, messages } = state;
  const score = useMemo(
    () => snapshot ? `${snapshot.state.leftScore} - ${snapshot.state.rightScore}` : "경기 전",
    [snapshot]
  );
  const canReady = Boolean(roomId && state.status === "waitingReady");
  const canChat = Boolean(
    roomId
    && chatInput.trim()
    && ["waitingReady", "playing", "paused"].includes(state.status)
  );
  const canPause = Boolean(roomId && state.status === "playing");
  const canResume = Boolean(roomId && state.status === "paused");
  const canMove = Boolean(roomId && state.status === "playing");
  const canStartMatch = canStartNewMatch(state);
  const opponent = snapshot?.state.players.find((player) => player.side === "right");
  const opponentName = state.opponent ?? opponent?.displayName ?? "대기 중";

  // [INTV:PERF] 이미 같은 방향으로 보내고 있었다면 다시 보내지 않는다 — 키를 꾹 누르고 있으면
  // keydown이 반복 발생하는데, 그때마다 똑같은 방향 명령을 서버로 또 보내는 건 낭비이자 서버
  // InputGate의 속도 제한 토큰만 불필요하게 쓴다(inputGate.ts의 토큰 버킷을 실제로 소모하는 쪽의
  // 클라이언트 대응 최적화 — 이 dedup이 없으면 키를 오래 누를수록 토큰이 더 빨리 고갈된다).
  const changeDirection = useCallback((direction: -1 | 0 | 1) => {
    if (inputDirectionRef.current === direction) return;
    inputDirectionRef.current = direction;
    sendDirection(direction);
  }, [sendDirection]);

  useEffect(() => {
    inputDirectionRef.current = 0;
  }, [roomId]);

  // [INTV:TRAP] 로비 페이지의 "/play?mode=ai" 같은 링크로 들어왔을 때 자동으로 매칭을 시작해준다.
  // autoStartedRef로 "이미 한 번 시작했는지"를 기억해두는 이유는, 이 effect가 의존성 배열의 함수
  // 재생성 등으로 여러 번 실행되더라도(React 18 Strict Mode의 개발 모드 이중 실행 포함)
  // connectQueue/connectTournament를 중복 호출하지 않기 위해서다 — 이 가드가 없으면 개발 모드에서
  // Strict Mode가 effect를 일부러 두 번 실행할 때 큐에 두 번 참가 시도를 하게 된다(재구현 시
  // "개발 모드에서만 이상하게 두 번 실행된다"로 헷갈리기 쉬운 지점).
  useEffect(() => {
    if (autoStartedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const tournamentMatchId = params.get("tournamentMatchId");
    const mode = params.get("mode");
    if (tournamentMatchId) {
      autoStartedRef.current = true;
      void connectTournament(tournamentMatchId);
      return;
    }
    if (mode === "ai" || mode === "queue") {
      autoStartedRef.current = true;
      void connectQueue(mode);
    }
  }, [connectQueue, connectTournament]);

  // [INTV:EDGE] 키보드 조작의 여러 경계 사례를 다 처리한다: 채팅 입력창에 포커스가 있으면
  // (isEditableTarget) 방향키를 게임 조작으로 가로채지 않고, 오히려 그 입력창에 포커스가 들어가는
  // 순간(focusin) 이동 중이던 방향도 리셋한다. 창이 포커스를 잃거나(blur, 예: 다른 탭으로 전환)
  // 탭이 백그라운드로 가면(visibilitychange) keyup 이벤트를 놓쳐 패들이 "눌린 채로 멈춰버린" 것처럼
  // 계속 움직이는 상황을 막기 위해 방향을 강제로 0으로 되돌린다 — 브라우저는 포커스를 잃은 상태에서
  // 키를 뗀 keyup 이벤트를 그 창으로 보내주지 않으므로, blur/visibilitychange 리스너가 없으면
  // "다른 탭으로 전환했다가 돌아왔더니 패들이 계속 움직이고 있는" 버그가 재현된다.
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

  function startQueue(mode: "queue" | "ai") {
    inputDirectionRef.current = 0;
    setChatInput("");
    void connectQueue(mode);
  }

  function submitChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendChat(chatInput)) setChatInput("");
  }

  return (
    <AppShell>
      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <section className="grid gap-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-black text-ink">경기장</h1>
              <p className="mt-2 text-sm font-semibold text-muted">방향키나 W/S 키를 누르거나 화면 조작 버튼으로 패들을 움직입니다.</p>
            </div>
            <div className="flex gap-3">
              <button className="focus-ring rounded-lg bg-blue-600 px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300" disabled={!canStartMatch} onClick={() => startQueue("queue")}>
                매칭 큐 참가
              </button>
              <button className="focus-ring rounded-lg bg-green-600 px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300" disabled={!canStartMatch} onClick={() => startQueue("ai")}>
                인공지능 연습 시작
              </button>
            </div>
          </div>
          <section className="card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              {/* [INTV:EDGE] aria-live="polite": 이 영역의 내용이 바뀔 때 스크린 리더가 지금 하던
                  다른 작업을 방해하지 않는 선에서 새 내용을 읽어주게 하는 ARIA 속성(page.tsx의
                  role="status"보다 더 자주 바뀌는 상태 텍스트라 "polite"로 우선순위를 낮춰
                  즉시 끼어들지 않게 한 차이). */}
              <div className="flex items-center gap-2 text-sm font-black text-green-600" aria-live="polite">
                <Signal size={18} /> {state.notice}
              </div>
              <div className="text-2xl font-black text-ink">{score}</div>
            </div>
            <PongCanvas snapshot={snapshot} />
            {/* [INTV:EDGE] 모바일용 터치 조작 버튼: onPointer* 계열은 마우스/터치/펜 입력을 하나의
                API로 통일해서 다루는 Pointer Events다. 누르고 있는 동안만 이동해야 하므로 떼거나
                (onPointerUp), 취소되거나(onPointerCancel), 버튼 밖으로 손가락이 미끄러져 나가도
                (onPointerLeave) 전부 정지로 처리한다 — onPointerLeave를 빼먹으면, 버튼을 누른 채로
                손가락을 밖으로 밀어내도 정지 이벤트가 안 와서 패들이 계속 움직이는 같은 계열의 버그가
                생긴다(위 키보드 blur/visibilitychange 처리와 동일한 문제의 터치 버전). touch-none/
                select-none 클래스는 브라우저의 기본 터치 동작(스크롤, 텍스트 선택)이 버튼 조작과
                충돌하지 않도록 막는다. */}
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
          {!demoMode || demoLobbyPresentation.showMatchChat ? <div className="card p-5">
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
          </div> : null}
        </aside>
      </div>
    </AppShell>
  );
}
