export type NavigationId =
  | "lobby"
  | "play"
  | "dashboard"
  | "leaderboard"
  | "tournaments"
  | "profile"
  | "admin";

export type NavigationItem = {
  id: NavigationId;
  href: string;
  label: string;
  matchPrefix?: string;
};

const registeredNavigation = (profileHref: string): NavigationItem[] => [
  { id: "lobby", href: "/", label: "로비" },
  { id: "play", href: "/play", label: "경기" },
  { id: "dashboard", href: "/dashboard", label: "대시보드" },
  { id: "leaderboard", href: "/leaderboard", label: "순위표" },
  { id: "tournaments", href: "/tournaments", label: "토너먼트" },
  { id: "profile", href: profileHref, label: "프로필", matchPrefix: "/profile" },
  { id: "admin", href: "/admin", label: "관리" }
];

export const demoLobbyPresentation = {
  description: "빠른 매칭으로 다른 게스트를 찾고, 상대가 없으면 인공지능과 바로 경기할 수 있습니다.",
  showPersistedProgress: false,
  showLeaderboardLink: false,
  showLobbyChat: false,
  showMatchChat: false
} as const;

export function createNavigation(demoMode: boolean, profileHref: string): NavigationItem[] {
  const navigation = registeredNavigation(profileHref);
  return demoMode
    ? navigation.filter((item) => item.id === "lobby" || item.id === "play")
    : navigation;
}

export function isDemoRestrictedPath(pathname: string): boolean {
  return ["/dashboard", "/leaderboard", "/tournaments", "/profile", "/admin"]
    .some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_APP_MODE === "demo";
}

export function formatTransientResultNotice(result: {
  persisted: false;
  leftScore: number;
  rightScore: number;
}): string {
  return `임시 경기 종료: ${result.leftScore} - ${result.rightScore} · 전적에 저장되지 않았습니다.`;
}

export function shouldResumeGameFromLobby(event: { type: string }): boolean {
  return event.type === "queue.matched" || event.type === "game.snapshot";
}
