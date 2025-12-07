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

// [INTV:ARCH] middleware.ts가 실제로 라우트 접근을 막는 데 쓰는 판단 기준 — 데모 모드에서 숨겨야
// 하는 경로들의 접두사를 여기 한 곳에 모아둬서, "어떤 경로가 데모에서 제한되는지"가 미들웨어와
// (아래) 네비게이션 필터링 양쪽에서 어긋나지 않게 한다(createNavigation의 필터링과 이 함수가 서로
// 다른 목록을 따로 관리했다면, 메뉴에는 안 보이는데 URL 직접 접근은 막히지 않는 것 같은 불일치가
// 생길 수 있었다 — 단일 진실 공급원으로 그 위험을 없앤 것). app.ts의 appMode !== "demo" 게이팅과
// 같은 목적을, 여기서는 백엔드 라우트가 아니라 프론트엔드 라우트 레벨에서 수행한다.
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
