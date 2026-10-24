import { HttpStatus, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';

import { Server } from 'socket.io';
import { envs } from 'src/config/envs';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import type { AuthenticatedSocket } from 'src/interface/auth-socket.interface';

import { RealtimeEmitterService } from './realtime-emitter.service';
import { SocketRateLimiter } from './socket-rate-limiter';
import { SocketStateService } from './socket-state.service';

export interface PresenceGateway {
  handleUserOnline(userId: string): Promise<void>;
  handleUserOffline(userId: string): Promise<void>;
}

export abstract class BaseGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  protected readonly logger: Logger;

  constructor(
    protected readonly socketStateService: SocketStateService,
    protected readonly context: string,
    protected readonly namespace: string = SOCKET_CONFIG.namespaces.CHAT,
    protected readonly realtimeEmitter?: RealtimeEmitterService,
    protected readonly rateLimiter?: SocketRateLimiter,
    protected readonly jwtService?: JwtService,
  ) {
    this.logger = new Logger(context);
  }

  afterInit(server: Server): void {
    if (this.realtimeEmitter) {
      this.realtimeEmitter.registerServer(this.namespace, server);
    }
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      if (!client.data?.user?.id) {
        client.disconnect();
        return;
      }

      const userId = client.data.user.id;

      await this.cleanupGhostSockets(userId);
      await this.socketStateService.add(userId, client.id);
      await client.join(`user:${userId}`);

      this.logger.debug(`User connected: ${userId} (socketId: ${client.id})`);

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
    this.logger.debug(`User disconnected: ${userId} (socketId: ${client.id})`);
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

  @SubscribeMessage(SOCKET_CONFIG.events.HEARTBEAT)
  async handleHeartbeat(@ConnectedSocket() client: AuthenticatedSocket) {
    const userId = client.data?.user?.id;
    if (!userId) {
      client.disconnect();
      return;
    }

    if (client.data.tokenExp && Date.now() > client.data.tokenExp) {
      client.emit(SOCKET_CONFIG.events.EXCEPTION, {
        status: HttpStatus.UNAUTHORIZED,
        code: 'TOKEN_EXPIRED',
        message: 'Access token expired. Please emit auth:refresh_token or reconnect.',
      });
      client.disconnect();
      return;
    }

    await this.socketStateService.refreshHeartbeat(userId, client.id);
    return {
      status: HttpStatus.OK,
      serverTime: new Date().toISOString(),
    };
  }

  @SubscribeMessage(SOCKET_CONFIG.events.AUTH_REFRESH)
  async handleTokenRefresh(
    @MessageBody('token') token: string,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    if (!token || !this.jwtService) {
      throw new WsException('Token refresh is not available or token is missing');
    }

    try {
      const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
      const payload = await this.jwtService.verifyAsync<{
        id: string;
        role?: string;
        exp?: number;
      }>(cleanToken, {
        secret: envs.jwtSecret,
      });

      if (payload.id !== client.data.user.id) {
        throw new WsException('Token user mismatch');
      }

      client.data.tokenExp = payload.exp ? Number(payload.exp) * 1000 : undefined;
      await this.socketStateService.refreshHeartbeat(payload.id, client.id);

      return {
        status: HttpStatus.OK,
        expiresAt: client.data.tokenExp,
      };
    } catch {
      client.disconnect();
      throw new WsException('Invalid or expired token');
    }
  }

  protected enforceRateLimit(client: AuthenticatedSocket, eventName: string): void {
    const userId = client.data?.user?.id;
    if (!userId) {
      throw new WsException('Unauthorized socket connection');
    }
    if (client.data.tokenExp && Date.now() > client.data.tokenExp) {
      client.disconnect();
      throw new WsException('Access token has expired');
    }
    this.rateLimiter?.consume(userId, eventName);
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
        this.logger.warn(`Cleaning ghost socket: ${socketId} for user ${userId}`);
        await this.socketStateService.remove(userId, socketId);
      }
    });

    await Promise.all(promises);
  }
}
