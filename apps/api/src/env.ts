export interface ApiEnv {
  port: number;
  databaseUrl: string | null;
  webOrigin: string;
  sessionSecret: string;
  appMode: "development" | "test" | "production" | "demo";
  trustProxy: boolean;
}

export function readEnv(input = process.env): ApiEnv {
  const appMode = readAppMode(input);
  const configuredSecret = input.SESSION_SECRET;
  if (
    (appMode === "demo" || appMode === "production")
    // [INTV:TRAP] Buffer.byteLength(문자열, "utf8"): 문자열의 "글자 수"(.length)가 아니라 UTF-8로
    // 인코딩했을 때의 "바이트 수"를 잰다. 세션 시크릿의 강도를 바이트 기준으로 요구하는 것이므로,
    // 한글 등 멀티바이트 문자가 섞여 문자 수는 짧아도 바이트 수는 충분한(혹은 그 반대인) 상황에서
    // .length로 재면 실제 엔트로피를 오판할 수 있어 이렇게 잰다 — guestAccess.ts의 시크릿 길이
    // 검증도 같은 이유로 동일하게 byteLength를 쓴다.
    && (!configuredSecret || Buffer.byteLength(configuredSecret, "utf8") < 32)
  ) {
    throw new Error("SESSION_SECRET must be at least 32 bytes in demo and production modes");
  }
  const databaseUrl = input.DATABASE_URL ?? null;
  if (appMode === "production" && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production mode");
  }
  return {
    port: Number(input.API_PORT ?? 4000),
    databaseUrl,
    webOrigin: input.WEB_ORIGIN ?? "http://localhost:3000",
    sessionSecret: configuredSecret ?? "dev-session-secret",
    appMode,
    trustProxy: input.TRUST_PROXY === "1"
  };
}

export function readAppMode(input: NodeJS.ProcessEnv = process.env): ApiEnv["appMode"] {
  if (input.APP_MODE !== undefined) {
    if (["development", "test", "production", "demo"].includes(input.APP_MODE)) {
      return input.APP_MODE as ApiEnv["appMode"];
    }
    throw new Error(`APP_MODE must be development, test, production, or demo: ${input.APP_MODE}`);
  }
  if (input.NODE_ENV === "production") return "production";
  if (input.NODE_ENV === "test") return "test";
  return "development";
}
