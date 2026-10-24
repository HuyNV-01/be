export enum ChatEventEnum {
  MESSAGE_SENT = 'chat.message.sent',
  MESSAGE_DELIVERED = 'chat.message.delivered',
  MESSAGE_READ = 'chat.message.read',
  MESSAGE_EDITED = 'chat.message.edited',
  MESSAGE_RECALLED = 'chat.message.recalled',
  MESSAGE_REACTED = 'chat.message.reacted',
  MESSAGE_PINNED = 'chat.message.pinned',
  CALL_LOG_RECORDED = 'chat.call.recorded',
}

export class ChatMessageDeliveredEvent {
  constructor(
    public readonly conversationId: string,
    public readonly messageId: string,
    public readonly userId: string,
    public readonly deliveredAt: Date,
  ) {}
}

export class ChatMessageReadEvent {
  constructor(
    public readonly conversationId: string,
    public readonly userId: string,
    public readonly lastReadAt: Date,
    public readonly user: { id: string; name: string; avatar: string | null },
  ) {}
}
