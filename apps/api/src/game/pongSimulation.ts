import {
  BALL_RADIUS,
  GAME_HEIGHT,
  GAME_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_WIDTH,
  TICK_RATE,
  WINNING_SCORE,
  type BallState,
  type PlayerSide
} from "@pong-pong/shared";

export type PaddleDirection = -1 | 0 | 1;

export interface SimulationPaddleState {
  y: number;
  direction: PaddleDirection;
}

export interface PongSimulationState {
  tick: number;
  phase: "playing" | "finished";
  leftScore: number;
  rightScore: number;
  paddles: Record<PlayerSide, SimulationPaddleState>;
  ball: BallState;
  winnerSide: PlayerSide | null;
}

export interface PongSimulationInputs {
  left: PaddleDirection;
  right: PaddleDirection;
}

// [INTV:ARCH] FIXED_TIMESTEP_MS: 시뮬레이션이 "정상적인 한 틱"이 몇 ms인지 기준으로 삼는 값
// (TICK_RATE=20이면 50ms). 아래 step()은 실제로 걸린 시간(deltaMs)을 이 기준과 비교해 "몇 틱만큼
// 시간이 흘렀는지" 비율(timestepScale)로 환산해서 움직임 양을 조절한다 — 서버가 어쩌다 살짝 늦게
// 틱을 처리해도(deltaMs가 기준보다 커져도) 패들/공이 "그만큼 더 많이" 움직여서 보정되므로, 실제
// 경과 시간과 시뮬레이션 속도가 어긋나지 않는다.
const FIXED_TIMESTEP_MS = 1000 / TICK_RATE;
const INITIAL_BALL_VELOCITY = { x: 10, y: 5 } as const;
const PADDLE_SPEED_PER_TICK = 13;
const BALL_ACCELERATION_PER_TICK = 0.015;
const MAX_BALL_SPEED = 18;
// [INTV:EDGE] 한 경기가 무한정 길어지는 걸 막는 안전장치 — TICK_RATE(초당 틱 수) 기준으로 45초
// 분량의 틱이 지나면 점수와 무관하게 강제로 경기를 끝낸다(그 시점 스코어가 높은 쪽이 승자). 랠리가
// 계속 무승부로 이어지는 극단적 경우에도 방(room) 자원이 영구히 점유되지 않도록 보장한다.
const MAX_MATCH_TICKS = TICK_RATE * 45;
const ARENA_PADDING = 16;

export class PongSimulation {
  static initialState(): PongSimulationState {
    return {
      tick: 0,
      phase: "playing",
      leftScore: 0,
      rightScore: 0,
      paddles: {
        left: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, direction: 0 },
        right: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, direction: 0 }
      },
      ball: {
        position: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 },
        velocity: { ...INITIAL_BALL_VELOCITY }
      },
      winnerSide: null
    };
  }

  // [INTV:ARCH] step()은 "이전 상태 + 이번 입력 + 경과 시간"을 받아 "다음 상태"를 새로 만들어
  // 반환하는 순수 함수다 — 인자로 받은 state를 직접 바꾸지 않고 항상 cloneState로 복사본을 만들어
  // 그 위에서 계산한다. 이렇게 만들어둔 덕분에 같은 입력을 다시 넣으면 항상 같은 결과가 나오는 게
  // 보장되고(결정론적), 리플레이/재생(replayFixture) 같은 기능도 이 함수를 기록된 입력으로 다시
  // 돌리기만 하면 구현할 수 있다 — 네트워크/타이머 같은 부수효과가 시뮬레이션 로직 안에 전혀 없다는
  // 게 핵심.
  // - [FLOW] 1. 입력 유효성 검사(deltaMs) -> 2. finished 상태면 복사본만 반환하고 조기 종료 ->
  //   3. 상태 복제 -> 4. 패들 이동 -> 5. 공 이동 + 벽/패들 충돌 처리 -> 6. 득점 체크 및 리스폰 ->
  //   7. 지속 가속 적용 -> 8. 승리 조건 체크
  // - [TRAP] cloneState 없이 state를 직접 mutate하면, 호출자가 이전 tick의 state 참조를 여전히
  //   들고 있을 경우(예: 스냅샷 버퍼에 저장해둔 이전 상태) 그 참조까지 같이 바뀌어버려 "과거 상태"가
  //   조용히 오염된다 — 순수 함수 계약이 깨지는 가장 흔한 실수.
  static step(
    state: Readonly<PongSimulationState>,
    inputs: Readonly<PongSimulationInputs>,
    deltaMs: number
  ): PongSimulationState {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      throw new RangeError("deltaMs must be a positive finite number");
    }
    if (state.phase === "finished") return cloneState(state);

    const next = cloneState(state);
    const timestepScale = deltaMs / FIXED_TIMESTEP_MS;
    next.tick += 1;
    movePaddle(next, "left", inputs.left, timestepScale);
    movePaddle(next, "right", inputs.right, timestepScale);

    next.ball.position.x += next.ball.velocity.x * timestepScale;
    next.ball.position.y += next.ball.velocity.y * timestepScale;
    reflectVerticalWall(next.ball);
    collidePaddle(next, "left", 32);
    collidePaddle(next, "right", GAME_WIDTH - 32);

    if (next.ball.position.x < 0) {
      next.rightScore += 1;
      resetBall(next, -1);
    } else if (next.ball.position.x > GAME_WIDTH) {
      next.leftScore += 1;
      resetBall(next, 1);
    }

    accelerateBall(next, timestepScale);
    if (
      next.leftScore >= WINNING_SCORE ||
      next.rightScore >= WINNING_SCORE ||
      next.tick >= MAX_MATCH_TICKS
    ) {
      next.phase = "finished";
      next.winnerSide = next.leftScore >= next.rightScore ? "left" : "right";
      next.paddles.left.direction = 0;
      next.paddles.right.direction = 0;
    }

    return next;
  }
}

function cloneState(state: Readonly<PongSimulationState>): PongSimulationState {
  return {
    tick: state.tick,
    phase: state.phase,
    leftScore: state.leftScore,
    rightScore: state.rightScore,
    paddles: {
      left: { ...state.paddles.left },
      right: { ...state.paddles.right }
    },
    ball: {
      position: { ...state.ball.position },
      velocity: { ...state.ball.velocity }
    },
    winnerSide: state.winnerSide
  };
}

function movePaddle(
  state: PongSimulationState,
  side: PlayerSide,
  direction: PaddleDirection,
  timestepScale: number
): void {
  const paddle = state.paddles[side];
  paddle.direction = direction;
  paddle.y = clamp(
    paddle.y + direction * PADDLE_SPEED_PER_TICK * timestepScale,
    ARENA_PADDING,
    GAME_HEIGHT - PADDLE_HEIGHT - ARENA_PADDING
  );
}

// [INTV:EDGE] 공이 위/아래 벽을 넘어가면 튕겨낸다. 단순히 좌표를 벽에 딱 붙이는 대신 "벽을 넘어간
// 만큼을 반대로 접어 되돌리는" 방식(min + (min - position))을 쓴다 — 한 틱 사이에 공이 꽤 멀리
// 이동해 벽을 크게 넘어섰더라도 튕겨난 정확한 위치를 재현하기 위함(그냥 벽 위치로 스냅하면 실제보다
// 짧게 이동한 것처럼 보이고, 빠른 공일수록 위치 오차가 누적된다).
function reflectVerticalWall(ball: BallState): void {
  const min = BALL_RADIUS;
  const max = GAME_HEIGHT - BALL_RADIUS;
  if (ball.position.y < min) {
    ball.position.y = min + (min - ball.position.y);
    ball.velocity.y = Math.abs(ball.velocity.y);
  } else if (ball.position.y > max) {
    ball.position.y = max - (ball.position.y - max);
    ball.velocity.y = -Math.abs(ball.velocity.y);
  }
}

function collidePaddle(state: PongSimulationState, side: PlayerSide, x: number): void {
  const paddle = state.paddles[side];
  const ball = state.ball;
  const withinY = ball.position.y >= paddle.y && ball.position.y <= paddle.y + PADDLE_HEIGHT;
  const halfPaddle = PADDLE_WIDTH / 2;
  const withinX = side === "left"
    ? ball.position.x - BALL_RADIUS <= x + halfPaddle
    : ball.position.x + BALL_RADIUS >= x - halfPaddle;
  // [INTV:TRAP] approaching: 공이 이 패들 쪽으로 "다가오는 중"인지 속도의 부호로 확인한다. 이
  // 체크가 없으면, 패들을 이미 맞고 반대쪽으로 튕겨나가는 공이 아직 패들 사각형 범위 안에 머무는
  // 동안(패들 두께 때문에 한두 틱은 겹칠 수 있다) 매 틱마다 다시 충돌 처리가 되어 계속 방향이
  // 뒤집히는(떨림/제자리 진동) 버그가 생긴다 — AABB 충돌만으로는 안 잡히는, 속도 방향까지 봐야
  // 하는 대표적인 함정.
  const approaching = Math.sign(ball.velocity.x) === (side === "left" ? -1 : 1);
  if (!withinX || !withinY || !approaching) return;

  // [INTV:ARCH] 맞을 때마다 공 속도를 살짝 키운다(*1.04) — 랠리가 길어질수록 점점 빨라지게 하는
  // 연출(게임성 목적, 물리적 정확성 목적 아님).
  ball.velocity.x *= -1.04;
  // [INTV:ARCH] offset: 공이 패들의 "정중앙"에서 얼마나 떨어진 지점에 맞았는지를 -1(패들 맨 위)~
  // 1(패들 맨 아래)로 환산한다. 그 값을 그대로 다음 y속도에 반영해서, 패들 끝쪽에 맞히면 더 급격한
  // 각도로 튕겨나가게 한다 — 실제 퐁 게임의 전형적인 "맞은 위치로 방향을 조준한다" 메커닉.
  const offset = (ball.position.y - (paddle.y + PADDLE_HEIGHT / 2)) / (PADDLE_HEIGHT / 2);
  ball.velocity.y = offset * 7;
}

function resetBall(state: PongSimulationState, xDirection: 1 | -1): void {
  state.ball.position = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };
  // [INTV:ARCH] elapsedBoost: 경기가 진행될수록(state.tick이 커질수록) 득점 후 리스폰되는 공의
  // 초기 속도를 최대 1.35배까지 점점 올린다 — 경기가 길어질수록 다음 랠리가 더 빨리 결판나도록
  // 유도해 지루하게 늘어지는 걸 막는다.
  const elapsedBoost = Math.min(1.35, 1 + state.tick / (TICK_RATE * 90));
  state.ball.velocity = {
    x: INITIAL_BALL_VELOCITY.x * elapsedBoost * xDirection,
    // 짝/홀 틱에 따라 위아래 방향을 번갈아 줘서, 득점할 때마다 매번 같은 각도로만 공이 나가지 않게 한다.
    y: INITIAL_BALL_VELOCITY.y * elapsedBoost * (state.tick % 2 === 0 ? 1 : -1)
  };
}

// [INTV:ARCH] 위 collidePaddle의 즉발성 가속(*1.04)과는 별개로, 시간이 지나면서 공의 "최소 속력"이
// 서서히 올라가도록 강제하는 지속적 가속 로직 — elapsedMinimum이 그 하한선이다. 랠리가 짧게 끝나
// velocity가 한동안 가속될 기회가 없었더라도, 경기 시작으로부터 흐른 시간(state.tick) 자체를
// 기준으로 속력 하한이 계속 올라간다(두 가속 메커니즘이 서로 다른 트리거로 같은 방향을 강화).
function accelerateBall(state: PongSimulationState, timestepScale: number): void {
  const velocity = state.ball.velocity;
  const currentSpeed = Math.hypot(velocity.x, velocity.y);
  if (currentSpeed <= 0 || currentSpeed >= MAX_BALL_SPEED) return;

  const elapsedMinimum = Math.min(
    MAX_BALL_SPEED,
    Math.hypot(INITIAL_BALL_VELOCITY.x, INITIAL_BALL_VELOCITY.y) +
      state.tick * BALL_ACCELERATION_PER_TICK
  );
  const nextSpeed = Math.min(
    MAX_BALL_SPEED,
    Math.max(currentSpeed + BALL_ACCELERATION_PER_TICK * timestepScale, elapsedMinimum)
  );
  // [INTV:TRAP] 속력만 바꾸고 방향(단위 벡터)은 그대로 유지하기 위해, 목표 속력과 현재 속력의
  // 비율을 x/y 성분에 동일하게 곱한다 — x, y를 따로따로 독립적으로 조정하면 방향 자체가 틀어진다.
  const scale = nextSpeed / currentSpeed;
  velocity.x *= scale;
  velocity.y *= scale;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
