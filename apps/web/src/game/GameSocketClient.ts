import {
  parseServerEvent,
  type ClientEvent,
  type ServerEvent,
  type WsTicketResponse
} from "@pong-pong/shared";

// [INTV:ARCH] 브라우저 표준 WebSocket과 같은 모양(readyState/send/close + onopen·onmessage·onclose·
// onerror 핸들러 프로퍼티 방식)의 최소 인터페이스 — 테스트에서 진짜 WebSocket 없이 이 모양만
// 흉내 낸 가짜 소켓을 주입할 수 있게 한다(백엔드의 GameHubRepository, SignalSource와 같은 최소
// 인터페이스 원칙을 프론트에도 동일하게 적용).
export interface GameWebSocket {
  readyState: number;
  send(payload: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface GameSocketHandlers {
  onConnecting(): void;
  onOpen(reconnected: boolean): void;
  onEvent(event: ServerEvent): void;
  onClosed(): boolean | void;
  onFailure(error: unknown): void;
}

type GameSocketClientOptions = {
  url: string;
  ticketProvider(signal?: AbortSignal): Promise<WsTicketResponse>;
  socketFactory(url: string): GameWebSocket;
};

const CONNECTING = 0;
const OPEN = 1;
// [INTV:ARCH] 서버(roomSession.ts)의 재접속 유예 시간(15초)과 맞춘 값 — 그 시간이 지나면 서버가
// 이미 몰수패 처리를 했을 것이므로 클라이언트도 그 이상은 재연결을 시도하지 않는다(서버 상수와
// 값이 어긋나면, 서버는 이미 몰수패 처리했는데 클라이언트는 계속 재연결을 시도하는 낭비가 생긴다 —
// 두 상수를 동기화 상태로 유지해야 하는 암묵적 계약).
const RECONNECT_WINDOW_MS = 15_000;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 2_000;

// [INTV:ARCH] gameHub.ts가 서버 쪽 연결 상태(끊김/재접속/교체)를 관리하듯, 이 클래스는 그 짝이
// 되는 클라이언트 쪽 WS 생명주기를 관리한다 — 티켓 발급, 소켓 열기, 끊기면 지수 백오프로 재연결,
// 그리고 이 모든 비동기 작업 도중에 connect()/close()가 다시 불려도 옛 시도가 새 연결에 잘못
// 끼어들지 않도록 막는 역할까지 한다.
export class GameSocketClient {
  private socket: GameWebSocket | null = null;
  private ticketRequest: AbortController | null = null;
  // [INTV:EDGE] generation: connect()나 close()가 불릴 때마다 1씩 증가하는 세대 번호. 티켓 요청이나
  // 소켓 이벤트 콜백처럼 시간이 걸리는 비동기 작업들은 자신이 시작될 때의 generation을 기억해뒀다가,
  // 완료 시점에 "그 사이 더 최신 연결 시도가 시작되지 않았는지"(this.generation과 비교)를 확인한다
  // — 느리게 도착한 옛 티켓 응답이 이미 대체된 연결에 잘못 반영되는 경쟁 상태를 막는 핵심 장치
  // (useOrderStatusPolling.ts의 cancelled 플래그와 같은 목적을 세대 번호로 일반화한 것 — 여러
  // 비동기 작업이 겹칠 수 있는 상황에는 boolean 플래그보다 증가하는 세대 번호가 "몇 번째 시도가
  // 최신인지"까지 구분할 수 있어 더 적합하다).
  // - [TRAP] isCurrent() 체크(this.socket === socket && this.generation === generation) 없이 콜백
  //   안에서 바로 this.socket = null 등으로 상태를 건드리면, 옛 소켓의 늦게 도착한 이벤트가 최신
  //   연결의 상태를 덮어써버리는 버그가 생긴다 — 모든 비동기 콜백 진입점에서 이 체크가 반드시
  //   먼저 와야 한다.
  private generation = 0;
  private inputSequence = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDeadlineMs = 0;
  private reconnectAttempts = 0;

  constructor(private readonly options: GameSocketClientOptions) {}

  async connect(initialEvent: ClientEvent, handlers: GameSocketHandlers): Promise<void> {
    const generation = this.replaceConnection();
    handlers.onConnecting();
    await this.openSocket(generation, initialEvent, handlers, false);
  }

  private async openSocket(
    generation: number,
    initialEvent: ClientEvent | null,
    handlers: GameSocketHandlers,
    reconnected: boolean
  ): Promise<void> {
    const controller = new AbortController();
    this.ticketRequest = controller;

    let ticket: WsTicketResponse;
    try {
      ticket = await this.options.ticketProvider(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation || isAbortError(error)) return;
      if (reconnected && this.scheduleReconnect(generation, handlers)) return;
      handlers.onFailure(error);
      return;
    } finally {
      if (this.ticketRequest === controller) this.ticketRequest = null;
    }

    if (controller.signal.aborted || generation !== this.generation) return;

    const separator = this.options.url.includes("?") ? "&" : "?";
    const socket = this.options.socketFactory(
      `${this.options.url}${separator}ticket=${encodeURIComponent(ticket.ticket)}&v=${ticket.protocolVersion}`
    );
    this.socket = socket;
    this.inputSequence = 0;

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.reconnectAttempts = 0;
      this.reconnectDeadlineMs = 0;
      handlers.onOpen(reconnected);
      if (initialEvent) socket.send(JSON.stringify(initialEvent));
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      try {
        if (typeof event.data !== "string") throw new Error("문자열 형식의 실시간 메시지가 아닙니다.");
        handlers.onEvent(parseServerEvent(event.data));
      } catch (error) {
        handlers.onFailure(error);
      }
    };
    socket.onerror = () => {
      if (this.isCurrent(socket, generation)) socket.close();
    };
    socket.onclose = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      if (handlers.onClosed() === true) this.scheduleReconnect(generation, handlers);
    };
  }

  send(event: ClientEvent): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

  // [INTV:EDGE] inputSequence: 매 입력마다 하나씩 늘어나는 카운터 — 서버의 InputGate가 이 값
  // (inputSeq)으로 오래된/중복된 입력을 걸러내므로, 클라이언트도 항상 증가하는 값을 보내야 한다
  // (재연결하면 0부터 다시 시작 — 서버도 그 방의 입력 기록을 유저별로 관리하지만 재접속 시점에
  // 새 카운터로 다시 맞아떨어지게 되어 있다). openSocket에서 재연결 시 this.inputSequence = 0으로
  // 리셋하는 지점과 짝을 이루는 서버-클라이언트 계약.
  sendDirection(roomId: string, direction: -1 | 0 | 1): number | null {
    if (!this.socket || this.socket.readyState !== OPEN) return null;
    this.inputSequence += 1;
    this.socket.send(JSON.stringify({
      v: 1,
      type: "game.input",
      roomId,
      inputSeq: this.inputSequence,
      direction
    } satisfies ClientEvent));
    return this.inputSequence;
  }

  close(): void {
    this.replaceConnection();
  }

  // [INTV:TRAP] 기존 연결(또는 진행 중이던 티켓 요청)을 완전히 정리하고 새 세대 번호를 발급한다 —
  // connect()와 close()가 공유하는 공통 절차. 소켓의 핸들러를 전부 null로 비워두는 건, close() 호출
  // 자체가 비동기로 onclose를 나중에 발생시킬 수 있는데 그때는 이미 이 클라이언트가 신경 쓰지 않는
  // 옛 소켓이 됐기 때문이다 — 핸들러를 null로 안 비우면 isCurrent 체크가 있어도 죽은 소켓의 이벤트가
  // 계속 콜백으로 흘러들어오는 불필요한 처리가 남는다(이중 방어: 핸들러 해제 + generation 체크).
  private replaceConnection(): number {
    this.generation += 1;
    this.ticketRequest?.abort();
    this.ticketRequest = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDeadlineMs = 0;
    this.reconnectAttempts = 0;

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === CONNECTING || socket.readyState === OPEN) socket.close();
    }
    this.inputSequence = 0;
    return this.generation;
  }

  private isCurrent(socket: GameWebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  // [INTV:EDGE] 재접속 유예 시간(15초) 안에서 지수 백오프(250ms → 500ms → 1000ms → 최대 2000ms)로
  // 재시도 간격을 늘려가며 다시 연결을 시도한다 — 서버가 잠깐 붐빌 때 모든 클라이언트가 동시에
  // 몰아서 재시도하는 것을 피하고(gameHub.ts의 finalizationRetry와 같은 지수 백오프 철학이 서버-
  // 클라이언트 양쪽 모두에 적용됨), 유예 시간을 넘기면 재시도를 그만두고 실패로 알린다 — 재시도
  // 마감(reconnectDeadlineMs)과 각 재시도 간격(delayMs) 둘 다 서버의 15초 유예 창을 넘어서지
  // 않도록 Math.min으로 클램프한다.
  private scheduleReconnect(generation: number, handlers: GameSocketHandlers): boolean {
    if (generation !== this.generation) return false;
    if (this.reconnectTimer) return true;
    const nowMs = Date.now();
    if (this.reconnectDeadlineMs === 0) this.reconnectDeadlineMs = nowMs + RECONNECT_WINDOW_MS;
    if (nowMs >= this.reconnectDeadlineMs) {
      handlers.onFailure(new Error("경기 재연결 제한 시간을 초과했습니다."));
      return true;
    }
    const delayMs = Math.min(
      INITIAL_RECONNECT_DELAY_MS * (2 ** this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
      this.reconnectDeadlineMs - nowMs
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket(generation, null, handlers, true);
    }, delayMs);
    return true;
  }
}

// [INTV:TRAP] AbortError는 환경마다(브라우저/폴리필 등) 정확한 클래스가 다를 수 있어 instanceof로
// 안정적으로 판별하기 어렵다 — 대신 이름으로 덕 타이핑해서 "취소로 인한 실패"를 다른 실패와
// 구분한다. instanceof DOMException 같은 체크로 재구현하면 Node 환경이나 다른 폴리필에서
// 조용히 실패할 수 있는 지점.
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
