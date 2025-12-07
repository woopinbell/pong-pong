import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sharedRuntime = fileURLToPath(new URL("../../packages/shared/dist/index.js", import.meta.url));

// Next.js 설정 파일. 이 프로젝트가 pnpm 워크스페이스 모노레포(apps/web이 packages/shared를 참조)인 데서
// 오는 설정들이 대부분이다.
/** @type {import('next').NextConfig} */
const nextConfig = {
  // "standalone": 배포에 필요한 최소한의 파일(빌드 결과 + 실제로 쓰인 node_modules만)을 별도 폴더로
  // 추려주는 Next.js 빌드 모드 — Docker 이미지를 만들 때 전체 모노레포를 통째로 담지 않아도 되게 해준다.
  output: "standalone",
  // outputFileTracingRoot: 위 standalone 모드가 "어디까지가 이 프로젝트의 파일인지" 추적할 때 기준으로 삼을
  // 루트 디렉터리 — 모노레포 루트를 명시하지 않으면 apps/web 안쪽만 보고 packages/shared 같은 워크스페이스
  // 의존성을 놓칠 수 있다.
  outputFileTracingRoot: repositoryRoot,
  // transpilePackages: Next.js는 기본적으로 자기 앱 코드만 컴파일하고 node_modules의 의존성은 이미 빌드된
  // 것으로 취급한다. @pong-pong/shared는 워크스페이스 내부 패키지라 이 옵션으로 지정해야 Next의 빌드
  // 파이프라인이 그 코드도 함께 처리해준다.
  transpilePackages: ["@pong-pong/shared"],
  // Next.js가 내부적으로 쓰는 webpack 설정을 직접 손보는 훅 — @pong-pong/shared를 참조할 때 워크스페이스
  // 심볼릭 링크 대신 빌드된 dist 산출물을 확실히 바라보도록 별칭(alias)을 강제한다.
  webpack(config) {
    config.resolve.alias["@pong-pong/shared"] = sharedRuntime;
    return config;
  }
};

export default nextConfig;
