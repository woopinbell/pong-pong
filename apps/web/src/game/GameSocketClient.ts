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
