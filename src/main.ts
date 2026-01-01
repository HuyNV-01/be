import { ForbiddenException, HttpStatus, ValidationPipe } from '@nestjs/common';
import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';

import cookieParser from 'cookie-parser';
import { join } from 'path';

import { AppModule } from './app.module';
import { RedisIoAdapter } from './common/websocket/redis-io.adapter';
import { envs } from './config/envs';
import { SWAGGER_CONFIG } from './config/swagger/swagger';
import { DEFAULT_PORT } from './constants';
import { HTTP_RESPONSE } from './constants/http-response';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'fatal', 'error', 'warn', 'debug', 'verbose'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );

  const documentFactory = (): ReturnType<typeof SwaggerModule.createDocument> =>
    SwaggerModule.createDocument(app, SWAGGER_CONFIG.documentBuilder());
  SwaggerModule.setup(SWAGGER_CONFIG.path, app, documentFactory);

  const corsOptions: CorsOptions = {
    origin: envs.feUrl,
    credentials: true,
  };

  app.enableCors(corsOptions);
  app.setGlobalPrefix('api');
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/api',
  });

  app.use(cookieParser());

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  const port: number = envs.port ?? DEFAULT_PORT;
  await app.listen(port);
}
bootstrap().catch((error) => {
  const label = 'main.ts - [Bootstrap Error]';
  console.error(`${label} - ${JSON.stringify(error)}`);
  throw new ForbiddenException({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: HTTP_RESPONSE.COMMON.INTERNAL_SERVER_ERROR.message,
    code: HTTP_RESPONSE.COMMON.INTERNAL_SERVER_ERROR.code,
  });
});
