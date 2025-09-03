"use client";

import { useEffect, useState } from "react";
import type { ChatMessage, PublicUser, SessionUser } from "@pong-pong/shared";
import { LoginPanel } from "@/components/LoginPanel";
import { PongCanvas } from "@/components/PongCanvas";
import { getLobby, getMe } from "@/lib/api";
import { sampleChat, sampleUsers } from "@/lib/sample";

export default function HomePage() {
  const [me, setMe] = useState<SessionUser | null>(null);
  const [players, setPlayers] = useState<PublicUser[]>(sampleUsers);
  const [chat, setChat] = useState<ChatMessage[]>(sampleChat);

  useEffect(() => {
    getMe().then(setMe);
    getLobby().then((lobby) => {
      setPlayers(lobby.onlinePlayers);
      setChat(lobby.chat);
      if (lobby.me) setMe(lobby.me);
    });
  }, []);

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
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-[0.3em] text-blue-700">pong-pong</p>
      <h1 className="mt-4 text-5xl font-black">다시 오신 것을 환영합니다, {me.displayName}</h1>
      <p className="mt-5 text-slate-600">온라인 {players.length}명 · 로비 메시지 {chat.length}개</p>
    </main>
  );
}
