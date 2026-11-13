import { Global, Module } from '@nestjs/common';

import { PublicTunnelService } from './public-tunnel.service';

@Global()
@Module({
  providers: [PublicTunnelService],
  exports: [PublicTunnelService],
})
export class TunnelGatewayModule {}
