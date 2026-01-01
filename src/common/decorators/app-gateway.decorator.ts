import { UseFilters, UsePipes, ValidationPipe, applyDecorators } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';

import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';

import { WsExceptionFilter } from '../websocket/ws-exception.filter';

export function AppGateway(namespace: string) {
  return applyDecorators(
    UseFilters(new WsExceptionFilter()),

    UsePipes(new ValidationPipe({ transform: true, whitelist: true })),

    WebSocketGateway({
      namespace,
      cors: SOCKET_CONFIG.cors,
    }),
  );
}
