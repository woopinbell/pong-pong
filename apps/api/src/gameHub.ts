import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { AppRepository } from "@pong-pong/db";
import { encodeServerEvent, type ServerEvent, type SessionUser } from "@pong-pong/shared";

type Client = {
  id: string;
  socket: WebSocket;
  user: SessionUser;
  roomId: string | null;
};

export class GameHub {
  private readonly clients = new Map<string, Client>();

  constructor(private readonly repo: AppRepository) {}

  connect(socket: WebSocket, _request: IncomingMessage, user: SessionUser): void {
    const client: Client = { id: randomUUID(), socket, user, roomId: null };
    this.clients.set(client.id, client);
    socket.on("close", () => this.disconnect(client));
    this.broadcastPresence();
  }

  private disconnect(client: Client): void {
    this.clients.delete(client.id);
    this.broadcastPresence();
  }

  private broadcastPresence(): void {
    this.broadcastAll({ type: "presence.changed", online: this.clients.size, playing: 0 });
  }

  private broadcastAll(event: ServerEvent): void {
    for (const client of this.clients.values()) this.send(client, event);
  }

  private send(client: Client, event: ServerEvent): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(encodeServerEvent(event));
  }
}
