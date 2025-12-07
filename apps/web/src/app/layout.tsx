import type { Metadata } from "next";
import { QueryProvider } from "@/components/QueryProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "퐁퐁",
  description: "실시간 Pong 매칭 프로토타입"
};

// [INTV:ARCH] app/layout.tsx는 App Router의 "루트 레이아웃" — 이 앱의 모든 페이지를 감싸는 최상위
// 컴포넌트로, 다른 페이지 컴포넌트와 달리 <html>과 <body> 태그 자체를 직접 렌더링해야 한다(Next가
// 이 구조를 실제 문서로 그대로 쓴다). 여기서 QueryProvider로 한 번만 감싸두면 모든 페이지가 같은
// TanStack Query client를 공유한다(페이지마다 QueryProvider를 따로 두면 페이지 전환 시 캐시가
// 초기화되는 문제가 생긴다).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
