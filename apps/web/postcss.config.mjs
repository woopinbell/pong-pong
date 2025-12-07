// PostCSS: CSS를 변환하는 플러그인 파이프라인 도구 — Next.js가 빌드 시 이 설정을 자동으로 읽어 적용한다.
// tailwindcss 플러그인이 globals.css의 @tailwind 지시어를 실제 유틸리티 클래스 CSS로 치환하고,
// autoprefixer가 그 결과에 브라우저별 벤더 프리픽스(-webkit- 등)를 자동으로 덧붙여 호환성을 맞춘다.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
};
