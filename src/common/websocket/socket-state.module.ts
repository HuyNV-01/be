import { Global, Module } from '@nestjs/common';

import { RealtimeEmitterService } from './realtime-emitter.service';
import { SocketRateLimiter } from './socket-rate-limiter';
import { SocketStateService } from './socket-state.service';

@Global()
@Module({
  providers: [SocketStateService, RealtimeEmitterService, SocketRateLimiter],
  exports: [SocketStateService, RealtimeEmitterService, SocketRateLimiter],
})
export class WebSocketModule {}
