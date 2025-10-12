import {
  parseServerEvent,
  type ClientEvent,
  type ServerEvent,
  type WsTicketResponse
} from "@pong-pong/shared";

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
  onOpen(): void;
  onEvent(event: ServerEvent): void;
  onClosed(): void;
  onFailure(error: unknown): void;
}

type GameSocketClientOptions = {
  url: string;
  ticketProvider(signal?: AbortSignal): Promise<WsTicketResponse>;
  socketFactory(url: string): GameWebSocket;
};

const CONNECTING = 0;
const OPEN = 1;

export class GameSocketClient {
  private socket: GameWebSocket | null = null;
  private ticketRequest: AbortController | null = null;
  private generation = 0;
  private inputSequence = 0;

  constructor(private readonly options: GameSocketClientOptions) {}

  async connect(initialEvent: ClientEvent, handlers: GameSocketHandlers): Promise<void> {
    const generation = this.replaceConnection();
    const controller = new AbortController();
    this.ticketRequest = controller;
    handlers.onConnecting();

    let ticket: WsTicketResponse;
    try {
      ticket = await this.options.ticketProvider(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation || isAbortError(error)) return;
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
      handlers.onOpen();
      socket.send(JSON.stringify(initialEvent));
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
      if (this.isCurrent(socket, generation)) handlers.onFailure(new Error("실시간 연결에서 오류가 발생했습니다."));
    };
    socket.onclose = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      handlers.onClosed();
    };
  }

  send(event: ClientEvent): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

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

  private replaceConnection(): number {
    this.generation += 1;
    this.ticketRequest?.abort();
    this.ticketRequest = null;

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
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
