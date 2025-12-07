"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Gamepad2, Home, Shield, Trophy, UserRound, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createNavigation, isDemoMode, type NavigationId } from "@/lib/demoPolicy";
import { meQueryOptions } from "@/lib/query";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: me = null } = useQuery(meQueryOptions());
  const profileHref = me ? `/profile/${me.handle}` : "/";
  const nav = createNavigation(isDemoMode(), profileHref);
  const icons: Record<NavigationId, LucideIcon> = {
    lobby: Home,
    play: Gamepad2,
    dashboard: BarChart3,
    leaderboard: Trophy,
    tournaments: Users,
    profile: UserRound,
    admin: Shield
  };

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="border-b border-line bg-white lg:min-h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col gap-8 p-5">
          {/* [INTV:PERF] next/link의 Link: 일반 <a>와 달리 페이지 전체를 다시 불러오지 않고
              클라이언트 쪽에서 전환하며, 화면에 보이면 그 대상 페이지를 미리 가져와두기도 한다
              (prefetch) — 일반 <a>로 재구현하면 매 내부 이동마다 전체 페이지 리로드가 일어나
              SPA 전환의 이점(상태 유지, 빠른 전환)을 잃는다. */}
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
              const Icon = icons[item.id];
              const active = pathname === item.href || Boolean(item.matchPrefix && pathname.startsWith(item.matchPrefix)) || (item.href !== "/" && pathname.startsWith(item.href));
              const className = `focus-ring flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-bold transition ${
                active ? "bg-blue-50 text-blue-700" : "text-muted hover:bg-slate-50 hover:text-ink"
              }`;
              // [INTV:EDGE] 로그인 전에는 "프로필" 메뉴를 누를 수 있는 링크가 아니라, 누를 수
              // 없는(aria-disabled) span으로 대신 렌더링한다 — 스크린 리더 등 보조기술에 "이 항목은
              // 있지만 지금은 비활성 상태"임을 알린다(href를 그냥 "#"이나 빈 문자열로 둔 Link를
              // 쓰면 시각적으로만 비활성처럼 보일 뿐, 보조기술 사용자에게는 여전히 클릭 가능한
              // 링크로 인식된다).
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
