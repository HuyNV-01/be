import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketServer } from '@nestjs/websockets';

import { Server } from 'socket.io';
import { AuthenticatedSocket } from 'src/interface/auth-socket.interface';

import { SocketStateService } from './socket-state.service';

export interface PresenceGateway {
  handleUserOnline(userId: string): Promise<void>;
  handleUserOffline(userId: string): Promise<void>;
}

export abstract class BaseGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  protected readonly logger: Logger;

  constructor(
    protected readonly socketStateService: SocketStateService,
    context: string,
  ) {
    this.logger = new Logger(context);
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      if (!client.data?.user) {
        client.disconnect();
        return;
      }

      const userId = client.data.user.id;

      await this.cleanupGhostSockets(userId);
      await this.socketStateService.add(userId, client.id);
      await client.join(`user:${userId}`);

      this.logger.debug(`User connected: ${userId}`);

      if (this.isPresenceGateway(this)) {
        await this.handleUserOnline(userId);
      }
    } catch (e) {
      this.logger.error(`Connection error: ${e}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: AuthenticatedSocket) {
    const userId = client.data?.user?.id;
    this.logger.debug(`User disconnected: ${userId}`);
    if (userId) {
      try {
        const isOfflineCompletely = await this.socketStateService.remove(userId, client.id);

        if (isOfflineCompletely) {
          this.logger.debug(`User offline completely: ${userId}`);

          if (this.isPresenceGateway(this)) {
            await this.handleUserOffline(userId).catch((err) =>
              this.logger.error(`Error in handleUserOffline: ${err}`),
            );
          }
        }
      } catch (error) {
        this.logger.error(`Error during disconnect handling: ${error}`);
      }
    }
  }

  private isPresenceGateway(instance: unknown): instance is PresenceGateway {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'handleUserOnline' in instance &&
      'handleUserOffline' in instance &&
      typeof (instance as PresenceGateway).handleUserOnline === 'function' &&
      typeof (instance as PresenceGateway).handleUserOffline === 'function'
    );
  }

  protected emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  private async cleanupGhostSockets(userId: string) {
    const existingSockets = await this.socketStateService.getSocketIds(userId);

    if (existingSockets.length === 0) return;

    const promises = existingSockets.map(async (socketId) => {
      const activeSockets = await this.server.in(socketId).fetchSockets();

      if (activeSockets.length === 0) {
        this.logger.warn(`🧹 Cleaning ghost socket: ${socketId} for user ${userId}`);
        await this.socketStateService.remove(userId, socketId);
      }
    });

    await Promise.all(promises);
  }
}
