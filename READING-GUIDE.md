# 읽는 순서 가이드 (pong-pong)

> 이 문서는 코드 주석이 아니라, 이미 곳곳에 박아둔 `[INTV:ARCH]` 등 주석들을 "어디서부터 읽어야
> 전체 그림이 잡히는가" 관점에서 엮은 내비게이션 문서다. 실제 설계 이유는 항상 코드 옆 `[INTV]`
> 주석에 있고, 여기는 그 주석들을 찾아가는 지도 역할만 한다.

## 30초 피치

WebSocket 실시간 Pong 게임 — Fastify API 서버가 고정 타임스텝(fixed timestep) 물리 시뮬레이션을
30Hz로 돌리며, 방(room) 여러 개의 틱을 하나의 타이머로 묶어 처리하는 스케줄러, 게스트/회원 이중
접근 체계, AI 폴백 매칭, 재연결 시 상태 복구까지 갖춘 실시간 게임 백엔드가 핵심이다.
`gameHub.ts` 하나가 이 모든 흐름의 중앙 디스패처다.

## 요청/데이터 흐름

```
[클라이언트] --WS 연결(wsTicket 검증)--> [gameHub.ts: connect()]
                                                |
                         신규 연결 / 재연결(recoverConnection) / 최근 게스트 결과 조회 분기
                                                |
                          joinQueue -> armAiFallback(대기 시간 초과 시 AI로 매칭) / 매칭 성사
                                                |
                                       createRoom -> RoomSession 생성
                                                |
                          [SharedRoomScheduler] 여러 Room의 틱을 하나의 타이머로 묶어 실행
                                                |
                          [FixedStepScheduler] 누적된 delta를 고정 스텝으로 소비 (accumulator)
                                                |
                          [PongSimulation] 패들 충돌/공 반사 등 물리 계산
                                                |
                          [LatestSnapshotBuffer] 최신 스냅샷만 유지(중간 프레임 드롭 허용)
                                                |
                                    gameHub.send() -> 각 클라이언트에 스냅샷 브로드캐스트
                                                |
                              (게임 종료) finishRoom/finalizeRoom -> 게스트/회원 분기 DB 반영
```

## 읽는 순서

### 1. 중앙 디스패처 — `apps/api/src/gameHub.ts`
**가장 먼저, 가장 오래 봐야 할 파일**. 클래스 docstring부터: `VersionlessServerEvent` 분산
조건부 타입, `GameHubRepository` 최소 인터페이스 패턴. 이어서 `connect()`(신규/재연결/최근
게스트 결과 3갈래 분기), `receive()`(단일 진입점 + try/catch 계층), `joinQueue`/`armAiFallback`
(대기시간 초과 시 AI 폴백), `createRoom`(스냅샷 전송 슬롯 부하 분산), `tick()`(스냅샷 전송 주기
절반화), `finishRoom`/`finalizeRoom`(게스트·회원 이중 경로 + 멱등 재시도 지수 백오프)까지 —
이 파일의 주석이 프로젝트 전체 설계 결정 대부분을 담고 있다.

### 2. 게임 루프 — `apps/api/src/game/`
- `fixedStepScheduler.ts` — 고정 타임스텝 누적기(accumulator). 프레임 간격이 들쭉날쭉해도
  물리 계산은 항상 일정한 델타로 진행되는 원리(재구현 시 이월(carry-over) 로직을 빠뜨리면
  느려지거나 빨라지는 시뮬레이션이 된다).
- `sharedRoomScheduler.ts` — 여러 Room의 타이머를 하나로 묶는 이유(타이머 하나당 오버헤드를
  Room 수만큼 곱하지 않기 위함) — `scheduler-benchmark.mjs`(`tests/load/`)가 이 설계의 실측
  근거를 남겨둔 파일이다.
- `pongSimulation.ts` — 패들 충돌의 "접근 중(approaching) 판정" 같은 물리 세부.
- `roomSession.ts` — 한 방의 생명주기(대기→진행→종료) 상태 기계.
- `matchmaker.ts` — 큐 매칭과 AI 폴백, `pongAi.ts`의 xorshift32 PRNG(`>>> 0` 정규화 트랩).
- `inputGate.ts`, `heartbeat.ts`, `latestSnapshotBuffer.ts` — 입력 검증, 연결 생존 확인, 스냅샷
  드롭 허용 버퍼.

### 3. 인증/접근 — `guestAccess.ts`, `wsTicket.ts`
HMAC 서명 stateless 세션 쿠키, `timingSafeEqual` 상수 시간 비교(타이밍 공격 방어), 롤링 윈도우
레이트 리밋, 티켓은 해시만 저장(원본 비밀은 절대 저장 안 함).

### 4. 서버 인프라 — `gracefulShutdown.ts`, `observability.ts`, `requestLogging.ts`, `httpBoundary.ts`, `env.ts`, `app.ts`, `index.ts`
SIGTERM/SIGINT 처리, Proxy 기반 레포지토리 계측으로 Prometheus 메트릭 수집, pino 로그
redact 설정, Fastify 에러 경계, 바이트 길이 시크릿 검증, WS 인증 전 메시지 버퍼링 크기 제한,
`0.0.0.0` 바인딩 트랩.

### 5. 프로토콜 계약 — `packages/shared/src/`
`game.ts`/`http.ts`/`ws.ts` — zod를 단일 진실 공급원으로 삼는 패턴(스키마에서 타입을 역추론),
WS 프로토콜의 판별 유니온(discriminated union), `game.ts`는 항상 `.strict()`인데 `http.ts`
응답 스키마는 의도적으로 완화되어 있는 차이.

### 6. 영속성 계층 — `packages/db/src/`
`index.ts`의 `AppRepository` 인터페이스 경계, `PostgresRepository`(원시 SQL을 쿼리 빌더 대신
쓰는 이유), `finalizeMatch` 트랜잭션의 락 순서 고정(데드락 방지) + 멱등 UNIQUE 삽입, 토너먼트
브래킷 자동 진출 로직, `MemoryRepository`(단일 스레드 JS를 암묵적 락으로 삼는 테스트용 구현),
`migrator.ts`(ESM 이중 경로 마이그레이션 디렉터리 해석, `satisfies Migration`).

### 7. 클라이언트 — `apps/web/src/game/`
`GameSocketClient.ts` — **가장 복잡한 클라이언트 파일**: 세대 카운터(generation counter)로
재연결 경쟁 상태를 방지하는 패턴. `gameConnection.ts`(리듀서 패턴), `useGameConnection.ts`,
`gameInput.ts`, `chatScope.ts`. 렌더링은 `components/PongCanvas.tsx`(보간 지연 렌더링, DPI
스케일링, rAF 정리).

## 재구현 시 가장 먼저 마주칠 함정

- 고정 타임스텝 누적기에서 "이번 프레임에 못 쓴 delta"를 다음 프레임으로 이월하지 않으면,
  프레임레이트가 불안정할 때 시뮬레이션 속도 자체가 흔들린다.
- `finalizeRoom`에서 게스트/회원 양쪽 DB 반영을 멱등하게 재시도하지 않으면, 네트워크 재시도나
  중복 호출 시 같은 매치 결과가 두 번 기록될 수 있다.
- WS 재연결 시 세대 카운터 없이 이전 연결의 콜백이 새 연결의 상태를 덮어쓰면, 늦게 도착한
  오래된 메시지가 최신 상태를 되돌려버리는 경쟁 상태가 생긴다(`GameSocketClient.ts` 참고).
