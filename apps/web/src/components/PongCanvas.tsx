"use client";

import { useEffect, useRef } from "react";
import { BALL_RADIUS, GAME_HEIGHT, GAME_WIDTH, PADDLE_HEIGHT, type GameSnapshot } from "@pong-pong/shared";
import { sampleSnapshot } from "@/lib/sample";

export function PongCanvas({ snapshot = sampleSnapshot() }: { snapshot?: GameSnapshot }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = GAME_WIDTH * ratio;
    canvas.height = GAME_HEIGHT * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
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

    drawPaddle(ctx, 32, snapshot.paddles.left.y, "#1768f2");
    drawPaddle(ctx, GAME_WIDTH - 50, snapshot.paddles.right.y, "#12b76a");
    ctx.beginPath();
    ctx.fillStyle = "#26364f";
    ctx.arc(snapshot.ball.position.x, snapshot.ball.position.y, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1768f2";
    ctx.font = "bold 42px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(String(snapshot.leftScore), GAME_WIDTH / 2 - 46, 68);
    ctx.fillStyle = "#12b76a";
    ctx.fillText(String(snapshot.rightScore), GAME_WIDTH / 2 + 46, 68);
  }, [snapshot]);

  return <canvas ref={ref} className="aspect-[16/9] w-full rounded-lg border border-line bg-white" aria-label="퐁퐁 경기 캔버스" />;
}
function drawPaddle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, 18, PADDLE_HEIGHT, 8);
  ctx.fill();
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
