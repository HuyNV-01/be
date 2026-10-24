import { Socket } from 'socket.io';

export interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      role?: string;
    };
    deviceId?: string;
    connectedAt?: number;
    tokenExp?: number;
  };
}
