/* eslint-disable @typescript-eslint/no-unsafe-function-type */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { INestApplicationContext, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IoAdapter } from '@nestjs/platform-socket.io';

import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';
import { envs } from 'src/config/envs/envs';
import { redisConfig } from 'src/config/redis/redis.config';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { AuthenticatedSocket } from 'src/interface/auth-socket.interface';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private readonly logger = new Logger(RedisIoAdapter.name);

  constructor(private app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const pubClient = new Redis({
      host: redisConfig.host,
      port: redisConfig.port,
      password: redisConfig.password,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });

    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => this.logger.error(`Redis Pub Error: ${err.message}`));
    subClient.on('error', (err) => this.logger.error(`Redis Sub Error: ${err.message}`));

    try {
      await Promise.all([pubClient.connect(), subClient.connect()]);
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log(
        `Redis Adapter initialized for Socket.io at ${redisConfig.host}:${redisConfig.port}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to connect Redis Adapter (${msg}). Falling back to default In-Memory Socket.IO Adapter.`,
      );
      pubClient.disconnect();
      subClient.disconnect();
      this.adapterConstructor = null;
    }
  }

  private extractToken(socket: AuthenticatedSocket): string | undefined {
    const authHeader = socket.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    if (socket.handshake.auth?.token) {
      return String(socket.handshake.auth.token)
        .replace(/^Bearer\s+/i, '')
        .trim();
    }
    const cookieHeader = socket.handshake.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    return undefined;
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      pingInterval: SOCKET_CONFIG.pingInterval,
      pingTimeout: SOCKET_CONFIG.pingTimeout,
      maxHttpBufferSize: SOCKET_CONFIG.maxHttpBufferSize,
    });

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    const jwtService = this.app.get(JwtService);

    const authMiddleware = async (socket: AuthenticatedSocket, next: (err?: Error) => void) => {
      try {
        const token = this.extractToken(socket);
        if (!token) {
          return next(new Error('Unauthorized: Authentication token missing'));
        }

        const payload = await jwtService.verifyAsync<{
          id: string;
          role?: string;
          exp?: number;
        }>(token, {
          secret: envs.jwtSecret,
        });

        socket.data.user = {
          id: payload.id,
          role: payload.role,
        };
        socket.data.deviceId = String(socket.handshake.auth?.deviceId || 'default');
        socket.data.connectedAt = Date.now();
        socket.data.tokenExp = payload.exp ? Number(payload.exp) * 1000 : undefined;

        next();
      } catch {
        next(new Error('Unauthorized: Invalid or expired token'));
      }
    };

    server.use(authMiddleware);

    const originalOf = server.of.bind(server);

    server.of = (name: string | RegExp | Function) => {
      const nsp = originalOf(name);
      nsp.use(authMiddleware);
      return nsp;
    };

    return server;
  }
}
