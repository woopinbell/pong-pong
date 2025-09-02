import {
  BALL_RADIUS,
  GAME_HEIGHT,
  GAME_WIDTH,
  PADDLE_HEIGHT,
  type ChatMessage,
  type DashboardSummary,
  type GameSnapshot,
  type LeaderboardEntry,
  type PublicUser,
  type TournamentSummary
} from "@pong-pong/shared";

export const sampleUsers: PublicUser[] = [
  user("spin-doctor", "스핀닥터", 1723, 32, 11, "green"),
  user("paddle-pro", "패들프로", 1640, 24, 13, "blue"),
  user("net-ninja", "네트닌자", 1512, 18, 15, "amber"),
  user("top-spin", "탑스핀", 1450, 15, 17, "violet")
];

export const sampleLeaderboard: LeaderboardEntry[] = sampleUsers.map((item, index) => ({
  rank: index + 1,
  user: item,
  winRate: Math.round((item.wins / Math.max(1, item.wins + item.losses)) * 1000) / 10
}));

export const sampleDashboard: DashboardSummary = {
  me: { ...user("pongmaster42", "퐁마스터", 1542, 128, 74, "blue"), email: "pong@example.local" },
  winRate: 61.5,
  bestStreak: 4,
  recentMatches: [
    { id: "m1", mode: "queue", opponentHandle: "스핀닥터", result: "win", scoreLeft: 11, scoreRight: 7, ratingDelta: 24, endedAt: new Date().toISOString() },
    { id: "m2", mode: "ai", opponentHandle: "연습 상대", result: "loss", scoreLeft: 8, scoreRight: 11, ratingDelta: -12, endedAt: new Date().toISOString() }
  ]
};

export const sampleChat: ChatMessage[] = [
  { id: "c1", scope: "lobby", roomId: null, sender: sampleUsers[0], body: "오늘 랠리 좋네요.", createdAt: new Date().toISOString() },
  { id: "c2", scope: "lobby", roomId: null, sender: sampleUsers[1], body: "한 판 하실 분?", createdAt: new Date().toISOString() }
];

export const sampleTournaments: TournamentSummary[] = [
  {
    id: "t1",
    name: "주말 퐁퐁 컵",
    status: "running",
    createdBy: sampleUsers[0],
    playerCount: 4,
    capacity: 4,
    winner: null,
    entries: sampleUsers
  },
  {
    id: "t2",
    name: "신입 랠리전",
    status: "open",
    createdBy: sampleUsers[1],
    playerCount: 2,
    capacity: 4,
    winner: null,
    entries: sampleUsers.slice(0, 2)
  }
];

export function sampleSnapshot(): GameSnapshot {
  return {
    roomId: "48291",
    phase: "playing",
    tick: 0,
    leftScore: 1,
    rightScore: 2,
    paddles: {
      left: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2, dy: 0 },
      right: { y: GAME_HEIGHT / 2 - PADDLE_HEIGHT / 2 + 54, dy: 0 }
    },
    ball: {
      position: { x: GAME_WIDTH / 2 + 120, y: GAME_HEIGHT / 2 - 40 },
      velocity: { x: 7, y: 4 }
    },
    players: [
      { id: "left", handle: "pongmaster42", displayName: "퐁마스터", side: "left", ready: true, ai: false },
      { id: "right", handle: "practice", displayName: "연습 상대", side: "right", ready: true, ai: true }
    ],
    serverTime: new Date().toISOString()
  };
}

function user(handle: string, displayName: string, rating: number, wins: number, losses: number, avatarKey: string): PublicUser {
  return {
    id: handle,
    handle,
    displayName,
    avatarKey,
    role: handle === "admin" ? "admin" : "user",
    status: "active",
    rating,
    wins,
    losses,
    online: true
  };
}

export { BALL_RADIUS, GAME_HEIGHT, GAME_WIDTH, PADDLE_HEIGHT };
