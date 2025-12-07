import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode, isDemoRestrictedPath } from "./lib/demoPolicy";

// [INTV:ARCH] Next.js 미들웨어: 요청이 실제 페이지 라우트에 도달하기 전에 가장 먼저 실행되는
// 함수(일반 Node 서버가 아니라 가벼운 엣지 런타임에서 돈다). 여기서는 apps/api의 app.ts가 appMode별로
// 라우트를 아예 등록하지 않는 것과 같은 목적으로, 데모 배포에서 노출하면 안 되는 페이지 경로를 요청
// 단계에서 404로 막는다 — 페이지 컴포넌트 안에서 "데모면 리다이렉트"를 판단하면, 컴포넌트가 먼저
// 렌더링 시도를 하고 나서야 막히는 깜빡임이 생기거나, 페이지마다 그 체크를 반복해야 하는데, 미들웨어는
// 라우트 진입 전에 한 곳에서 일괄 차단한다.
export function middleware(request: NextRequest) {
  if (isDemoMode() && isDemoRestrictedPath(request.nextUrl.pathname)) {
    return new NextResponse("Not Found", { status: 404 });
  }
  return NextResponse.next();
}

// [INTV:PERF] matcher: 이 미들웨어를 적용할 경로 패턴 목록 — 지정 안 하면 모든 요청마다 실행되므로,
// 실제로 검사가 필요한 경로만 골라 불필요한 실행을 줄인다. ":path*"는 그 뒤에 오는 임의의 하위
// 경로까지 포함한다는 뜻(예: "/admin/:path*"는 /admin과 /admin/users를 모두 매칭) — 정적 자산,
// API 라우트, 그리고 데모 제한 대상이 아닌 페이지(/, /play 등)는 이 미들웨어를 아예 거치지 않아
// 엣지 런타임 호출 비용이 절감된다.
export const config = {
  matcher: [
    "/dashboard/:path*",
    "/leaderboard/:path*",
    "/tournaments/:path*",
    "/profile/:path*",
    "/admin/:path*"
  ]
};
