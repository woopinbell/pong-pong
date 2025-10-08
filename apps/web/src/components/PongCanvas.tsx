"use client";

import { useEffect, useRef } from "react";
import { BALL_RADIUS, GAME_HEIGHT, GAME_WIDTH, PADDLE_HEIGHT, type GameSnapshot } from "@pong-pong/shared";

type RenderSample = GameSnapshot & {
  receivedAt: number;
};

const interpolationDelayMs = 80;

export function PongCanvas({ snapshot = null }: { snapshot?: GameSnapshot | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const samples = useRef<RenderSample[]>([]);

  useEffect(() => {
    if (!snapshot) {
      samples.current = [];
      return;
    }
    samples.current = [...samples.current, toRenderSample(snapshot)].slice(-8);
  }, [snapshot]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const context = ctx;
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}
