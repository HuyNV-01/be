import { NextFunction, Request, Response } from 'express';

import {
  DEFAULT_TUNNEL_DOMAIN_SUFFIXES,
  isLocalhostUrl,
  normalizePublicBaseUrl,
  tunnelOriginRegistry,
} from './tunnel.config';

export function createTunnelGatewayMiddleware(options?: { autoDetectFromHeaders?: boolean }) {
  const autoDetect = options?.autoDetectFromHeaders ?? true;

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('ngrok-skip-browser-warning', 'true');

    if (autoDetect) {
      const forwardedHost =
        (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ||
        req.headers.host?.trim();
      const forwardedProto =
        (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
        (req.secure ? 'https' : 'http');

      if (forwardedHost) {
        const lowerHost = forwardedHost.toLowerCase();
        const isKnownTunnelHost = DEFAULT_TUNNEL_DOMAIN_SUFFIXES.some((suffix) =>
          lowerHost.endsWith(suffix),
        );

        if (isKnownTunnelHost) {
          const candidateOrigin = normalizePublicBaseUrl(`${forwardedProto}://${forwardedHost}`);
          if (candidateOrigin && !isLocalhostUrl(candidateOrigin)) {
            tunnelOriginRegistry.registerOrigin(candidateOrigin);
            if (!tunnelOriginRegistry.getActivePublicBaseUrl()) {
              tunnelOriginRegistry.setActivePublicBaseUrl(candidateOrigin);
            }
          }
        }
      }
    }

    if (req.url.startsWith('/webhooks/omnichannel')) {
      req.url = `/api${req.url}`;
    }

    next();
  };
}
