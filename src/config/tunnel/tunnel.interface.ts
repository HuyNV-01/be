import { ChannelTypeEnum } from 'src/common/enum/permission.enum';

export enum TunnelProviderEnum {
  NONE = 'NONE',
  NGROK = 'NGROK',
  CLOUDFLARE_TUNNEL = 'CLOUDFLARE_TUNNEL',
  CUSTOM_DOMAIN = 'CUSTOM_DOMAIN',
}

export interface ITunnelGatewayConfig {
  provider: TunnelProviderEnum;
  enabled: boolean;
  publicWebhookBaseUrl: string | null;
  publicFrontendUrl: string | null;
  ngrokDomain: string | null;
  ngrokAuthtoken: string | null;
  ngrokInspectUrl: string;
  autoDetectLocalAgent: boolean;
  allowWildcardTunnelOrigin: boolean;
  extraAllowedOrigins: string[];
  allowedDomainSuffixes: string[];
}

export interface INgrokDiscoveredTunnel {
  detected: boolean;
  publicUrl: string | null;
  tunnelName: string | null;
  proto: string | null;
  configAddr: string | null;
  inspectUrl: string;
  errorMessage?: string | null;
}

export interface ITunnelStatusSnapshot {
  provider: TunnelProviderEnum;
  isPublicTunnelActive: boolean;
  isLocalhostMode: boolean;
  effectivePublicBaseUrl: string;
  effectiveFrontendUrl: string;
  configuredEnvBaseUrl: string | null;
  configuredNgrokDomain: string | null;
  autoDetectedTunnelUrl: string | null;
  ngrokAgentStatus: INgrokDiscoveredTunnel;
  sampleWebhookUrls: Record<ChannelTypeEnum, string>;
}
