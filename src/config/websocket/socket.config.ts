import { envs } from '../envs';

export const SOCKET_CONFIG = {
  cors: {
    origin: [envs.feUrl],
    credentials: true,
  },
  namespaces: {
    CHAT: 'chat',
    NOTIFICATION: 'notifications',
    ADMIN: 'admin',
  },
  events: {
    USER_STATUS: 'user_status',
    EXCEPTION: 'exception',
    CONTACT: {
      REQUEST_RECEIVED: 'contact.request_received',
      REQUEST_ACCEPTED: 'contact.request_accepted',
      FRIEND_REMOVED: 'contact.friend_removed',
    },
  },
};
