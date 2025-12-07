// [INTV:ARCH] zod: 런타임 검증 라이브러리. 아래 schema들은 "이 값이 실제로 이 모양이 맞는지" 실행
// 중에 검사하는 동시에, 파일 하단의 z.infer로 TypeScript 타입도 같은 정의에서 뽑아낸다 — 검증
// 로직과 타입 정의가 어긋나지 않도록 하나의 소스로 통일한 것(인터페이스만 따로 정의했다면, 네트워크로
// 온 값이 실제로 그 인터페이스를 만족하는지는 컴파일 타임에 보장되지 않는다 — 이 패턴이 그 간극을
// 메운다). @pong-pong/shared가 이 프로젝트의 프론트/백엔드 공용 패키지라, 여기 정의된 스키마가
// 곧 클라이언트-서버 프로토콜의 단일 진실 공급원이다.
import { z } from "zod";

export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;
export const PADDLE_WIDTH = 18;
export const PADDLE_HEIGHT = 112;
export const BALL_RADIUS = 10;
export const WINNING_SCORE = 3;
// 서버 시뮬레이션이 초당 몇 번 게임 상태를 갱신하는지(tick). 클라이언트-서버 동기화 주기의 기준이 되는 값.
export const TICK_RATE = 20;

// z.enum: 정해진 문자열 값들 중 하나만 허용하는 스키마.
export const playerSideSchema = z.enum(["left", "right"]);
export const gamePhaseSchema = z.enum(["waiting", "countdown", "playing", "paused", "finished"]);

// [INTV:EDGE] z.object({...}).strict(): 지정된 필드만 허용하는 객체 스키마 — .strict()가 없으면
// 정의되지 않은 여분의 필드가 와도 통과된다(zod 기본값은 초과 필드를 조용히 무시). 네트워크로 받은
// 값에 오타/불필요한 필드가 섞이는 걸 막기 위한 선택 — 이 프로토콜의 거의 모든 스키마에 일관되게
// .strict()가 붙어 있는 것도, 그중 하나라도 빠지면 그 지점만 검증이 느슨해지는 걸 막기 위한
// 의도적인 반복.
export const vec2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
}).strict();

export const paddleStateSchema = z.object({
  y: z.number().finite(),
  // z.union + z.literal: -1/0/1 세 값만 허용. 패들의 이동 방향(위/정지/아래)을 나타내는 입력 상태 — 실수 속도값이 아니라
  // 이산적인 방향 신호로 제한해서, 클라이언트가 보낼 수 있는 입력의 범위를 스키마 레벨에서 좁혀둔 것.
  dy: z.union([z.literal(-1), z.literal(0), z.literal(1)])
}).strict();

export const ballStateSchema = z.object({
  position: vec2Schema,
  velocity: vec2Schema
}).strict();

export const playerSlotSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  displayName: z.string().min(1),
  side: playerSideSchema,
  ready: z.boolean(),
  // 이 슬롯이 사람이 아니라 AI가 조작하는 자리인지 여부 (예: 상대가 접속을 끊었을 때 AI로 대체되는 경우 등에 사용).
  ai: z.boolean()
}).strict();

export const gameStateSchema = z.object({
  phase: gamePhaseSchema,
  leftScore: z.number().int().nonnegative(),
  rightScore: z.number().int().nonnegative(),
  paddles: z.object({
    left: paddleStateSchema,
    right: paddleStateSchema
  }).strict(),
  ball: ballStateSchema,
  players: z.array(playerSlotSchema)
}).strict();

// [INTV:EDGE] 서버가 매 tick마다 클라이언트로 브로드캐스트하는 스냅샷 하나의 모양.
// tick(정수 증가 카운터)과 sequence를 serverTimeMs와 별도로 두는 이유: 클라이언트가 스냅샷의
// 순서/누락을 시각(clock skew에 흔들릴 수 있는 값)이 아니라 단조 증가하는 카운터로 판단할 수 있게
// 하기 위함 — 서버-클라이언트 시계가 정확히 동기화돼 있다는 보장이 없으므로, 순서 판단은 항상 시간이
// 아니라 단조 카운터로 해야 한다는 일반 원칙.
export const gameSnapshotSchema = z.object({
  roomId: z.string().min(1),
  tick: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  serverTimeMs: z.number().int().nonnegative(),
  state: gameStateSchema
}).strict();

const persistedGameFinishedSchema = z.object({
  roomId: z.string().min(1),
  matchId: z.string().min(1),
  persisted: z.literal(true),
  winnerSide: playerSideSchema,
  leftScore: z.number().int().nonnegative(),
  rightScore: z.number().int().nonnegative(),
  ratingDelta: z.number().finite()
}).strict();

// [INTV:ARCH] .extend(): 기존 스키마에 필드를 덮어써서 새 스키마를 만드는 zod API.
// "경기가 DB에 기록되지 않은 경우"를 표현하는 변형 — matchId를 항상 null로, ratingDelta를 항상
// 0으로 고정해서 "저장 안 됐는데 매치ID나 레이팅 변화가 존재하는" 모순된 상태 자체가 타입/스키마
// 레벨에서 나올 수 없게 만든다(gameHub.ts의 finalizeRoom이 이 두 변형을 각각 게스트/등록 유저
// 경로에서 만들어낸다 — "불가능한 상태를 표현 불가능하게 만든다"는 타입 설계 원칙의 실제 적용).
const transientGameFinishedSchema = persistedGameFinishedSchema.extend({
  matchId: z.null(),
  persisted: z.literal(false),
  ratingDelta: z.literal(0)
}).strict();

// [INTV:ARCH] z.discriminatedUnion: "persisted" 필드의 값(true/false)을 보고 두 스키마 중 어느
// 쪽으로 검증할지 결정한다. 게임 종료 이벤트를 "DB에 영구 저장된 매치(persisted=true)"와 "저장되지
// 않은 임시 결과(persisted=false, 예: 게스트 플레이)" 두 갈래로 명시적으로 나눈 아키텍처 선택 —
// 소비하는 쪽 코드가 persisted 값만 확인하면(if 문 하나) TypeScript가 나머지 필드(matchId 등)의
// 존재 여부를 자동으로 좁혀준다(판별 유니온의 장점).
export const gameFinishedSchema = z.discriminatedUnion("persisted", [
  persistedGameFinishedSchema,
  transientGameFinishedSchema
]);

// z.infer<typeof schema>: 위에서 정의한 런타임 스키마로부터 TypeScript 타입을 역으로 추출한다.
// 스키마와 타입을 따로 유지보수할 필요 없이 스키마가 "진실의 원천(source of truth)"이 되는 패턴.
export type PlayerSide = z.infer<typeof playerSideSchema>;
export type GamePhase = z.infer<typeof gamePhaseSchema>;
export type Vec2 = z.infer<typeof vec2Schema>;
export type PaddleState = z.infer<typeof paddleStateSchema>;
export type BallState = z.infer<typeof ballStateSchema>;
export type PlayerSlot = z.infer<typeof playerSlotSchema>;
export type GameState = z.infer<typeof gameStateSchema>;
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
export type GameFinished = z.infer<typeof gameFinishedSchema>;
