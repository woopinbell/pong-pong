import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "퐁퐁",
  description: "실시간 Pong 매칭 프로토타입"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
