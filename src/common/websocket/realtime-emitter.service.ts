import { Injectable, Logger } from '@nestjs/common';

import { Server } from 'socket.io';

export interface IRealtimeTransport {
  emitToRoom(namespace: string, room: string, event: string, payload: unknown): void;
  emitToUser(namespace: string, userId: string, event: string, payload: unknown): void;
  broadcast(namespace: string, event: string, payload: unknown): void;
}

@Injectable()
export class RealtimeEmitterService implements IRealtimeTransport {
  private readonly logger = new Logger(RealtimeEmitterService.name);
  private readonly namespaces = new Map<string, Server>();

  registerServer(namespace: string, server: Server): void {
    this.namespaces.set(namespace, server);
    this.logger.log(`Registered realtime namespace: /${namespace}`);
  }

  getServer(namespace: string): Server | undefined {
    return this.namespaces.get(namespace);
  }

  emitToRoom(namespace: string, room: string, event: string, payload: unknown): void {
    const server = this.namespaces.get(namespace);
    if (!server) {
      this.logger.debug(`Namespace "${namespace}" not active yet when emitting "${event}"`);
      return;
    }
    server.to(room).emit(event, payload);
  }

  emitToUser(namespace: string, userId: string, event: string, payload: unknown): void {
    this.emitToRoom(namespace, `user:${userId}`, event, payload);
  }

  emitToConversation(
    namespace: string,
    conversationId: string,
    event: string,
    payload: unknown,
  ): void {
    this.emitToRoom(namespace, `conversation:${conversationId}`, event, payload);
  }

  broadcast(namespace: string, event: string, payload: unknown): void {
    const server = this.namespaces.get(namespace);
    if (!server) return;
    server.emit(event, payload);
  }
}
