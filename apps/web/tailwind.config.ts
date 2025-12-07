import type { Config } from "tailwindcss";

// Tailwind CSS 설정 파일 — 지금까지 여러 tsx 컴포넌트에서 본 text-ink, text-muted, border-line,
// bg-blue-600/700 같은 클래스들이 "존재할 수 있는" 이유가 바로 이 파일이다. Tailwind는 기본 제공 색상
// 팔레트만 쓰는 게 아니라, 여기 theme.extend.colors에 등록해둔 이름들도 유틸리티 클래스(text-*, bg-*,
// border-* 등)로 자동 생성해준다.
const config: Config = {
  // content: Tailwind가 실제 사용된 클래스 이름을 찾기 위해 훑는 파일 글롭 — 여기 걸리지 않은 파일에서
  // 클래스를 써봤자 최종 CSS에 포함되지 않는다(안 쓰는 유틸리티는 걸러내는 JIT 빌드 방식).
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b2559",
        muted: "#62708d",
        line: "#d8e1ef",
        panel: "#ffffff",
        blue: {
          600: "#1768f2",
          700: "#0f56d8"
        },
        green: {
          500: "#12b76a",
          600: "#079455"
        }
      },
      // shadow-card라는 유틸리티 클래스를 새로 만든다(실제로는 globals.css의 .card 클래스가 같은 값을
      // 직접 하드코딩해서 쓰고 있어, 이 토큰 자체를 className에서 직접 쓰는 곳은 이 저장소에 따로 없다).
      boxShadow: {
        card: "0 10px 30px rgba(15, 36, 78, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;
