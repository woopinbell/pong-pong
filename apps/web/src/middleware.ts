import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode, isDemoRestrictedPath } from "./lib/demoPolicy";

export function middleware(request: NextRequest) {
  if (isDemoMode() && isDemoRestrictedPath(request.nextUrl.pathname)) {
    return new NextResponse("Not Found", { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/leaderboard/:path*",
    "/tournaments/:path*",
    "/profile/:path*",
    "/admin/:path*"
  ]
};
