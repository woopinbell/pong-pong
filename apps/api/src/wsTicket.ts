import { createHash, randomBytes } from "node:crypto";

export const WS_TICKET_TTL_SECONDS = 30;

// [INTV:EDGE] 클라이언트에 내려줄 "원문" 티켓 — 암호학적으로 안전한 32바이트 난수를 base64url로
// 인코딩한 것. DB/메모리에는 이 값 자체가 아니라 아래 hashWsTicket으로 해시한 값만 저장된다
// (packages/db/src/index.ts, guestAccess.ts 참고) — 비밀번호 해싱과 같은 원리: 저장소가 유출돼도
// 원문 티켓(실제 인증에 쓰이는 값)은 해시에서 복원할 수 없다.
export function createRawWsTicket(): string {
  return randomBytes(32).toString("base64url");
}

export function hashWsTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}
