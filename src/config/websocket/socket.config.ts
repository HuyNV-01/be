import { envs } from '../envs/envs';

export const SOCKET_CONFIG = {
  cors: {
    origin: [envs.feUrl],
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
  namespaces: {
    CHAT: 'chat',
    NOTIFICATION: 'notifications',
    CALL: 'calls',
    ADMIN: 'admin',
  },
  events: {
    USER_STATUS: 'user_status',
    EXCEPTION: 'exception',
    HEARTBEAT: 'heartbeat',
    AUTH_REFRESH: 'auth:refresh_token',
    CHAT: {
      NEW_MESSAGE: 'new_message',
      MESSAGE_EDITED: 'message_edited',
      MESSAGE_RECALLED: 'message_recalled',
      MESSAGE_REACTION: 'message_reaction',
      MESSAGE_PINNED: 'message_pinned',
      MESSAGE_READ: 'message_read',
      MESSAGE_STATUS_UPDATE: 'message_status_update',
      MESSAGE_STATUS_BATCH: 'message_status_update_batch',
      USER_TYPING: 'user_typing',
      GROUP_UPDATED: 'group_updated',
      E2EE_KEY_UPDATED: 'e2ee_key_updated',
    },
    CALL: {
      INCOMING: 'call:incoming',
      INITIATED: 'call:initiated',
      ACCEPTED: 'call:accepted',
      REJECTED: 'call:rejected',
      BUSY: 'call:busy',
      SIGNAL: 'call:signal',
      MEDIA_STATE: 'call:media_state',
      PARTICIPANT_JOINED: 'call:participant_joined',
      PARTICIPANT_LEFT: 'call:participant_left',
      ENDED: 'call:ended',
    },
    CONTACT: {
      REQUEST_RECEIVED: 'contact.request_received',
      REQUEST_ACCEPTED: 'contact.request_accepted',
      FRIEND_REMOVED: 'contact.friend_removed',
    },
  },
} as const;
