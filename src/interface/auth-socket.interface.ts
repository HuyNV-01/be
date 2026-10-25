import { DefaultEventsMap, Socket } from 'socket.io';

export interface AuthenticatedSocketUser {
  id: string;
  role?: string;
}

export interface AuthenticatedSocketData {
  user: AuthenticatedSocketUser;
  deviceId?: string;
  connectedAt?: number;
  tokenExp?: number;
}

export type AuthenticatedSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  AuthenticatedSocketData
>;
