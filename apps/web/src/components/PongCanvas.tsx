"use client";

import { useEffect, useRef } from "react";
import { BALL_RADIUS, GAME_HEIGHT, GAME_WIDTH, PADDLE_HEIGHT, type GameSnapshot } from "@pong-pong/shared";

type RenderSample = GameSnapshot & {
  receivedAt: number;
};

// [INTV:ARCH] 서버 스냅샷은 대략 10Hz로만 온다(gameHub.ts의 SNAPSHOT_DELIVERY_DIVISOR 참고)는데
// 화면은 60fps로 부드럽게 그리고 싶다 — 그래서 "지금 이 순간"을 그대로 그리지 않고, 일부러 이만큼
// (80ms) 과거를 그린다. 그러면 그리려는 시점의 앞뒤로 실제 수신한 스냅샷 두 개가 있을 확률이
// 높아져서, 그 사이를 보간(선형 혼합)해 매끈하게 움직이는 것처럼 보이게 만들 수 있다 — 네트워크
// 게임에서 흔히 쓰는 "보간 지연"(interpolation delay/entity interpolation) 기법. 지연 없이 최신
// 스냅샷만 그렸다면, 다음 스냅샷이 올 때까지 화면이 뚝뚝 끊기는(stutter) 모습이 됐을 것.
const interpolationDelayMs = 80;

export function PongCanvas({ snapshot = null }: { snapshot?: GameSnapshot | null }) {
  // [INTV:PERF] ref는 두 가지 다른 용도로 쓰인다: 아래 <canvas ref={ref}>는 실제 DOM 엘리먼트를
  // 얻기 위한 용도(React가 렌더링 후 그 노드를 ref.current에 넣어준다)이고, samples는 리렌더링을
  // 유발하지 않으면서 여러 렌더링에 걸쳐 값을 유지하고 싶은 "일반 가변 상자"로 쓰는 용도다 — 매
  // 스냅샷마다 리렌더링될 필요는 없어서(캔버스는 requestAnimationFrame으로 스스로 다시 그리므로
  // React 리렌더는 의미가 없다) useState 대신 useRef를 썼다. useState로 바꾸면 초당 10번씩 불필요한
  // React 리렌더가 발생한다.
  const ref = useRef<HTMLCanvasElement | null>(null);
  const samples = useRef<RenderSample[]>([]);

  // snapshot prop이 바뀔 때마다(새 스냅샷 도착) 수신 버퍼에 추가한다 — 최근 8개만 남기고 오래된 건 버린다.
  useEffect(() => {
    if (!snapshot) {
      samples.current = [];
      return;
    }
    samples.current = [...samples.current, toRenderSample(snapshot)].slice(-8);
  }, [snapshot]);

  // [INTV:ARCH] 이 effect는 마운트 시 한 번만 실행된다([] 의존성) — 캔버스 렌더 루프는 React의
  // 리렌더링 주기와 독립적으로, requestAnimationFrame으로 스스로 계속 돌아야 60fps를 낼 수 있기
  // 때문에 snapshot이 바뀔 때마다 이 effect를 다시 실행할 필요가 없다(최신 데이터는 위 effect가
  // 채워두는 samples.current를 draw()가 매 프레임 직접 읽어간다).
  // - [FLOW] 1. 캔버스 컨텍스트/DPI 스케일 설정(마운트 시 1회) -> 2. draw() 루프 시작 -> 3. 매
  //   프레임 samples.current에서 현재 렌더링할 스냅샷을 보간 계산 -> 4. 캔버스에 그리기 -> 5.
  //   requestAnimationFrame으로 다음 프레임 예약 -> 6. 언마운트 시 cancelAnimationFrame
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const context = ctx;
    // [INTV:TRAP] devicePixelRatio: 레티나 등 고밀도 화면에서 캔버스가 흐릿하게 보이지 않도록,
    // 실제 픽셀 버퍼는 CSS 크기보다 이 배율만큼 더 크게 만들고 setTransform으로 그리기 좌표계를
    // 다시 CSS 크기 기준으로 맞춘다 — 그 덕분에 이후 그리기 코드는 항상 GAME_WIDTH/GAME_HEIGHT
    // 같은 "논리적" 좌표만 신경 쓰면 된다. 이 스케일링을 빼먹으면 고밀도 디스플레이에서 캔버스가
    // 흐릿하게(블러) 보이는 흔한 실수 — canvas.width를 CSS 크기와 그대로 같게 두면 브라우저가
    // 저해상도 버퍼를 확대해서 보여주게 된다.
    const ratio = window.devicePixelRatio || 1;
    canvas.width = GAME_WIDTH * ratio;
    canvas.height = GAME_HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    let animation = 0;

    function draw() {
      const renderSnapshot = selectRenderSnapshot(samples.current, performance.now()) ?? snapshot ?? emptySnapshot();
      context.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
      drawSnapshot(context, renderSnapshot);
      animation = requestAnimationFrame(draw);
    }

    draw();
    // [INTV:EDGE] cancelAnimationFrame으로 이 무한 루프를 확실히 멈춰야 컴포넌트가 사라진 뒤에도
    // draw()가 계속 스스로를 예약하며 도는 사고를 막는다 — requestAnimationFrame 체인은 컴포넌트
    // 언마운트를 스스로 알지 못하므로, 명시적으로 끊어주지 않으면 사라진 캔버스를 계속 그리려
    // 시도하는 리소스 누수가 된다(ConnectionHeartbeat.stop()이 setInterval/setTimeout을 확실히
    // clear하는 것과 같은 원칙).
    return () => cancelAnimationFrame(animation);
  }, []);

  return <canvas ref={ref} className="aspect-[16/9] w-full rounded-lg border border-line bg-white" aria-label="퐁퐁 경기 캔버스" />;
}

function drawSnapshot(ctx: CanvasRenderingContext2D, snapshot: GameSnapshot) {
  ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  ctx.fillStyle = "#f8fbff";
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  ctx.strokeStyle = "#bed0e7";
  ctx.lineWidth = 4;
  roundRect(ctx, 12, 12, GAME_WIDTH - 24, GAME_HEIGHT - 24, 18);
  ctx.stroke();

  ctx.setLineDash([18, 18]);
  ctx.beginPath();
  ctx.moveTo(GAME_WIDTH / 2, 34);
  ctx.lineTo(GAME_WIDTH / 2, GAME_HEIGHT - 34);
  ctx.strokeStyle = "#c5d7eb";
  ctx.stroke();
  ctx.setLineDash([]);

  drawPaddle(ctx, 32, snapshot.state.paddles.left.y, "#1768f2");
  drawPaddle(ctx, GAME_WIDTH - 50, snapshot.state.paddles.right.y, "#12b76a");
  ctx.beginPath();
  ctx.fillStyle = "#26364f";
  ctx.arc(snapshot.state.ball.position.x, snapshot.state.ball.position.y, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#1768f2";
  ctx.font = "bold 42px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(String(snapshot.state.leftScore), GAME_WIDTH / 2 - 46, 68);
  ctx.fillStyle = "#12b76a";
  ctx.fillText(String(snapshot.state.rightScore), GAME_WIDTH / 2 + 46, 68);
}

function drawPaddle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, 18, PADDLE_HEIGHT, 8);
  ctx.fill();
}

function toRenderSample(snapshot: GameSnapshot): RenderSample {
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      paddles: {
        left: { ...snapshot.state.paddles.left },
        right: { ...snapshot.state.paddles.right }
      },
      ball: {
        position: { ...snapshot.state.ball.position },
        velocity: { ...snapshot.state.ball.velocity }
      },
      players: snapshot.state.players.map((player) => ({ ...player }))
    },
    receivedAt: performance.now()
  };
}

function emptySnapshot(): GameSnapshot {
  return {
    roomId: "",
    tick: 0,
    sequence: 0,
    serverTimeMs: 0,
    state: {
      phase: "waiting",
      leftScore: 0,
      rightScore: 0,
      paddles: {
        left: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, dy: 0 },
        right: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, dy: 0 }
      },
      ball: {
        position: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 },
        velocity: { x: 0, y: 0 }
      },
      players: []
    }
  };
}

// [INTV:ARCH] "지금 - interpolationDelayMs" 시점을 감싸는 두 표본을 버퍼에서 찾아, 그 사이
// 어디쯤(ratio)인지 계산한다. 표본이 하나뿐이거나 목표 시점이 버퍼 범위를 벗어나면(네트워크 지연이
// interpolationDelayMs보다 커진 경우 등) 보간할 짝이 없으므로 있는 값 그대로 쓴다 — 우아한 성능
// 저하(graceful degradation): 이상적인 조건이 아니어도 크래시 대신 차선책으로 계속 그린다.
function selectRenderSnapshot(samples: RenderSample[], now: number): GameSnapshot | null {
  if (samples.length === 0) return null;
  if (samples.length === 1) return samples[0];
  const targetTime = now - interpolationDelayMs;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const next = samples[index];
    if (previous.receivedAt <= targetTime && targetTime <= next.receivedAt) {
      const ratio = (targetTime - previous.receivedAt) / Math.max(1, next.receivedAt - previous.receivedAt);
      return interpolateSnapshot(previous, next, ratio);
    }
  }
  return samples[samples.length - 1];
}

// [INTV:ARCH] 두 스냅샷 사이의 위치를 ratio(0~1) 비율로 선형 혼합(lerp)한다 — 패들/공의 "위치"만
// 보간하고 점수 등 다른 필드는 그대로 next(더 최근 것) 값을 쓴다(점수처럼 이산적인 값을 보간하면
// "3.4점" 같은 말이 안 되는 중간값이 나온다 — 연속적인 값(좌표)만 보간 대상으로 삼는 게 핵심).
function interpolateSnapshot(previous: RenderSample, next: RenderSample, ratio: number): GameSnapshot {
  const mix = (from: number, to: number) => from + (to - from) * ratio;
  return {
    ...next,
    state: {
      ...next.state,
      paddles: {
        left: {
          ...next.state.paddles.left,
          y: mix(previous.state.paddles.left.y, next.state.paddles.left.y)
        },
        right: {
          ...next.state.paddles.right,
          y: mix(previous.state.paddles.right.y, next.state.paddles.right.y)
        }
      },
      ball: {
        ...next.state.ball,
        position: {
          x: mix(previous.state.ball.position.x, next.state.ball.position.x),
          y: mix(previous.state.ball.position.y, next.state.ball.position.y)
        }
      }
    }
  };
}

// [INTV:TRAP] Canvas 2D API에는(구형 브라우저 기준) 둥근 사각형을 그리는 내장 메서드가 없어, 네
// 모서리를 arcTo로 이어 붙여 직접 구현했다(최신 브라우저의 roundRect 메서드로 대체할 수도 있지만,
// 그 경우 지원 브라우저 범위가 좁아진다는 트레이드오프가 생긴다).
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}
