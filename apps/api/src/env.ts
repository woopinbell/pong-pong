export interface ApiEnv {
  port: number;
  databaseUrl: string | null;
  webOrigin: string;
  sessionSecret: string;
}
export function readEnv(input = process.env): ApiEnv {
  return {
    port: Number(input.API_PORT ?? 4000),
    databaseUrl: input.DATABASE_URL ?? null,
    webOrigin: input.WEB_ORIGIN ?? "http://localhost:3000",
    sessionSecret: input.SESSION_SECRET ?? "dev-session-secret"
  };
}
