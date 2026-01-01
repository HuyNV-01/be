/* eslint-disable @typescript-eslint/no-unsafe-function-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { INestApplicationContext, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IoAdapter } from '@nestjs/platform-socket.io';

import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { ServerOptions } from 'socket.io';
import { envs } from 'src/config/envs';
import { AuthenticatedSocket } from 'src/interface/auth-socket.interface';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private readonly logger = new Logger(RedisIoAdapter.name);

  constructor(private app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const pubClient = createClient({
      url: `redis://${envs.redisHost}:${envs.redisPort}`,
    });
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => this.logger.error('Redis Pub Client Error', err));
    subClient.on('error', (err) => this.logger.error('Redis Sub Client Error', err));

    await Promise.all([pubClient.connect(), subClient.connect()]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log(
      `Redis Adapter initialized for Socket.io at ${envs.redisHost}:${envs.redisPort}`,
    );
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);

    server.adapter(this.adapterConstructor);

    const jwtService = this.app.get(JwtService);

    const authMiddleware = async (socket: AuthenticatedSocket, next) => {
      try {
        const token =
          socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
        if (!token) {
          return next(new Error('Authentication token missing'));
        }

        const payload = await jwtService.verifyAsync(token, {
          secret: envs.jwtSecret,
        });

        socket.data.user = {
          id: payload.id,
        };
        this.logger.log(`payload userID -> ${payload.id}`);

        next();
      } catch (error) {
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
