// [INTV:ARCH] "use client": Next.js App Router 지시어 — 이 파일(과 이걸 가져다 쓰는 컴포넌트)은
// 서버가 아니라 브라우저에서 실행돼야 한다는 표시. WebSocket, useState/useEffect 같은 훅은
// 브라우저에서만 의미가 있어(서버 렌더링 중엔 실행할 수 없어) 이 지시어가 필요하다 — 없으면
// Next.js는 기본적으로 서버 컴포넌트로 취급한다(App Router의 기본값이 서버 컴포넌트라는 점이,
// Pages Router에서 넘어올 때 가장 흔히 놓치는 전제).
"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ClientEvent, ServerEvent } from "@pong-pong/shared";
import { requestWsTicket } from "@/lib/api";
import { isChatForActiveRoom } from "./chatScope";
import { GameSocketClient, type GameSocketHandlers, type GameWebSocket } from "./GameSocketClient";
import { canStartNewMatch, gameConnectionReducer, initialGameConnectionState } from "./gameConnection";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

// [INTV:ARCH] useGameConnection: gameConnectionReducer(순수 상태 전이 로직)와 GameSocketClient
// (실제 소켓 부수효과)를 이어붙여, 컴포넌트가 쓰기 편한 React 커스텀 훅으로 노출한다 — 순수 상태
// 전이와 부수효과를 별도 모듈로 분리해뒀기 때문에, 리듀서는 소켓 없이 단위 테스트할 수 있고 이
// 훅은 그 둘을 "연결"만 한다.
export function useGameConnection() {
  // useReducer: gameConnection.ts의 리듀서를 React 상태로 연결한다 — dispatch(액션)을 부르면 리듀서가
  // 계산한 새 상태로 리렌더링된다.
  const [state, dispatch] = useReducer(gameConnectionReducer, initialGameConnectionState);
  // [INTV:TRAP] stateRef: 아래 여러 콜백(handleEvent 등)은 useCallback으로 한 번만 만들어지고
  // 재생성되지 않는데, 그 안에서 매번 최신 state를 읽어야 할 때가 있다. 클로저가 캡처한 state는
  // 생성 시점 값에 고정되므로("오래된 클로저"/stale closure 문제), 매 렌더링마다 stateRef.current를
  // 최신 state로 갱신해두고 콜백은 이 ref를 통해 읽는다 — dependency 배열에 state를 넣어 콜백을
  // 매번 재생성하는 대신, ref로 우회해 콜백identity를 안정적으로 유지하면서도 최신 값에 접근하는
  // 흔한 React 패턴.
  const stateRef = useRef(state);
  stateRef.current = state;
  // [INTV:PERF] useMemo(..., [])로 GameSocketClient 인스턴스를 컴포넌트 생애 동안 하나만 만들어
  // 유지한다 — 매 렌더링마다 새로 만들면 소켓 연결도 계속 새로 열고 닫아야 한다.
  const client = useMemo(() => new GameSocketClient({
    url: WS_URL,
    ticketProvider: requestWsTicket,
    socketFactory: (url) => new WebSocket(url) as unknown as GameWebSocket
  }), []);

  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case "queue.matched":
        dispatch({ type: "matched", roomId: event.roomId, opponent: event.opponent });
        return;
      case "game.snapshot":
        dispatch({ type: "snapshotReceived", snapshot: event.snapshot });
        return;
      case "game.finished":
        dispatch({ type: "gameFinished", result: event.result });
        return;
      case "chat.message":
        if (!isChatForActiveRoom(event.message, stateRef.current.roomId)) return;
        dispatch({
          type: "chatReceived",
          message: `${event.message.sender.displayName}: ${event.message.body}`
        });
        return;
      case "error":
        dispatch({ type: "failed", notice: event.message });
        return;
      // [INTV:TRAP] presence.changed는 이 화면에서 딱히 반영할 게 없어 의도적으로 무시한다 —
      // 그래도 ServerEvent의 모든 type을 다뤄야 하는 switch라 케이스 자체는 명시해둔다. 이 case를
      // 아예 빼면(default로만 처리) TypeScript의 exhaustiveness 체크가 "다루지 않은 타입"을 잡아주지
      // 못해, 나중에 새 이벤트 타입이 추가돼도 "깜빡하고 안 다뤘다"는 걸 컴파일 타임에 알 방법이
      // 없어진다.
      case "presence.changed":
        return;
    }
  }, []);

  const connect = useCallback(async (initialEvent: ClientEvent, openNotice: string) => {
    if (!canStartNewMatch(stateRef.current)) return;
    const handlers: GameSocketHandlers = {
      onConnecting: () => dispatch({ type: "connectStarted" }),
      onOpen: (reconnected) => dispatch(reconnected
        ? { type: "socketReopened" }
        : { type: "socketOpened", notice: openNotice }),
      onEvent: handleEvent,
      onClosed: () => {
        dispatch({ type: "socketClosed" });
        return Boolean(stateRef.current.roomId);
      },
      onFailure: (error) => dispatch({ type: "failed", notice: failureMessage(error) })
    };
    await client.connect(initialEvent, handlers);
  }, [client, handleEvent]);

  const connectQueue = useCallback((mode: "queue" | "ai") => connect(
    { v: 1, type: "queue.join", mode },
    mode === "ai" ? "인공지능 연습 방 생성 중" : "매칭 큐 참가 중"
  ), [connect]);

  const connectTournament = useCallback((matchId: string) => connect(
    { v: 1, type: "tournament.join", matchId },
    "토너먼트 경기 상대 입장 대기 중"
  ), [connect]);

  const ready = useCallback(() => {
    if (!state.roomId) return false;
    const sent = client.send({ v: 1, type: "game.ready", roomId: state.roomId });
    if (sent) dispatch({ type: "readySent" });
    return sent;
  }, [client, state.roomId]);

  const sendChat = useCallback((body: string) => {
    const trimmed = body.trim();
    if (!state.roomId || !trimmed) return false;
    return client.send({ v: 1, type: "chat.send", scope: "match", roomId: state.roomId, body: trimmed });
  }, [client, state.roomId]);

  const togglePause = useCallback(() => {
    if (!state.roomId) return false;
    if (state.status === "playing") {
      return client.send({ v: 1, type: "game.pause", roomId: state.roomId });
    }
    if (state.status === "paused") {
      return client.send({ v: 1, type: "game.resume", roomId: state.roomId });
    }
    return false;
  }, [client, state.roomId, state.status]);

  const sendDirection = useCallback((direction: -1 | 0 | 1) => {
    if (!state.roomId) return null;
    return client.sendDirection(state.roomId, direction);
  }, [client, state.roomId]);

  // [INTV:EDGE] useEffect가 반환하는 함수는 "정리(cleanup)" 함수 — 이 컴포넌트가 화면에서 사라질
  // 때(언마운트) React가 자동으로 호출해준다. client는 useMemo로 고정돼 있어 사실상 언마운트 시
  // 한 번만 실행되며, 페이지를 떠났는데 소켓이 계속 열려있는 걸 막는다(useOrderStatusPolling.ts의
  // clearInterval cleanup과 같은 원칙 — 이 cleanup이 빠지면 페이지 이동 후에도 소켓이 백그라운드에서
  // 계속 이벤트를 받아 처리하려 시도하는 누수가 생긴다).
  useEffect(() => () => client.close(), [client]);

  return {
    state,
    connectQueue,
    connectTournament,
    ready,
    sendChat,
    togglePause,
    sendDirection
  };
}

function failureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
    return "로그인 후 이용할 수 있습니다.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "실시간 연결을 확인해 주세요.";
}
