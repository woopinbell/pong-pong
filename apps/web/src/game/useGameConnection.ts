"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ClientEvent, ServerEvent } from "@pong-pong/shared";
import { requestWsTicket } from "@/lib/api";
import { GameSocketClient, type GameSocketHandlers, type GameWebSocket } from "./GameSocketClient";
import { canStartNewMatch, gameConnectionReducer, initialGameConnectionState } from "./gameConnection";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

export function useGameConnection() {
  const [state, dispatch] = useReducer(gameConnectionReducer, initialGameConnectionState);
  const stateRef = useRef(state);
  stateRef.current = state;
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
        dispatch({
          type: "chatReceived",
          message: `${event.message.sender.displayName}: ${event.message.body}`
        });
        return;
      case "error":
        dispatch({ type: "failed", notice: event.message });
        return;
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
