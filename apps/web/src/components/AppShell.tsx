"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Gamepad2, Home, Shield, Trophy, UserRound, Users } from "lucide-react";
import type { SessionUser } from "@pong-pong/shared";
import { getMe } from "@/lib/api";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<SessionUser | null>(null);
  const profileHref = me ? `/profile/${me.handle}` : "/";
  const nav = [
    { id: "lobby", href: "/", label: "로비", icon: Home },
    { id: "play", href: "/play", label: "경기", icon: Gamepad2 },
    { id: "dashboard", href: "/dashboard", label: "대시보드", icon: BarChart3 },
    { id: "leaderboard", href: "/leaderboard", label: "순위표", icon: Trophy },
    { id: "tournaments", href: "/tournaments", label: "토너먼트", icon: Users },
    { id: "profile", href: profileHref, label: "프로필", icon: UserRound, matchPrefix: "/profile" },
    { id: "admin", href: "/admin", label: "관리", icon: Shield }
  ];

  useEffect(() => {
    getMe().then(setMe).catch(() => setMe(null));
  }, []);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="border-b border-line bg-white lg:min-h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col gap-8 p-5">
          <Link href="/" className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-blue-600 text-white">
              <Gamepad2 size={24} />
            </div>
            <div>
              <div className="text-xl font-black leading-none text-ink">퐁퐁</div>
              <div className="text-sm font-semibold text-muted">실시간 탁구 대전</div>
            </div>
          </Link>
          <nav className="grid gap-2">
            {nav.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || Boolean(item.matchPrefix && pathname.startsWith(item.matchPrefix)) || (item.href !== "/" && pathname.startsWith(item.href));
              const className = `focus-ring flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-bold transition ${
                active ? "bg-blue-50 text-blue-700" : "text-muted hover:bg-slate-50 hover:text-ink"
              }`;
              if (item.id === "profile" && !me) {
                return (
                  <span key={item.id} aria-disabled="true" className={className}>
                    <Icon size={19} />
                    {item.label}
                  </span>
                );
              }
              return (
                <Link key={item.id} href={item.href} className={className}>
                  <Icon size={19} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto hidden border-t border-line pt-5 text-sm font-semibold text-muted lg:block">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
              연결됨
            </div>
            <div className="mt-2">버전 0.1.0</div>
          </div>
        </div>
      </aside>
      <main>
        <header className="hidden h-20 items-center justify-end gap-5 border-b border-line bg-white px-8 lg:flex">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
            서버 준비
          </div>
          <div className="h-8 w-px bg-line" />
          <div className="text-right">
            <div className="text-sm font-black text-ink">오늘의 랠리</div>
            <div className="text-xs font-semibold text-green-600">로비 지표 실시간 반영</div>
          </div>
        </header>
        <div className="mx-auto max-w-[1220px] px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
