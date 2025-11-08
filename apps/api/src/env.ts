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
    && (!configuredSecret || Buffer.byteLength(configuredSecret, "utf8") < 32)
  ) {
    throw new Error("SESSION_SECRET must be at least 32 bytes in demo and production modes");
  }
  return {
    port: Number(input.API_PORT ?? 4000),
    databaseUrl: input.DATABASE_URL ?? null,
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
