export enum ContactEventEnum {
  REQUEST_SENT = 'contact.request.sent',
  REQUEST_ACCEPTED = 'contact.request.accepted',
  FRIEND_REMOVED = 'contact.friend.removed',
  USER_BLOCKED = 'contact.user.blocked',
  USER_UNBLOCKED = 'contact.user.unblocked',
}

export class ContactRequestSentEvent {
  constructor(
    public readonly senderId: string,
    public readonly targetUserId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class ContactRequestAcceptedEvent {
  constructor(
    public readonly accepterId: string,
    public readonly requesterId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class ContactRemovedEvent {
  constructor(
    public readonly removerId: string,
    public readonly targetId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class ContactBlockedEvent {
  constructor(
    public readonly blockerId: string,
    public readonly targetId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class ContactUnblockedEvent {
  constructor(
    public readonly unblockerId: string,
    public readonly targetId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}
