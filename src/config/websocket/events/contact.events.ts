export enum ContactEventEnum {
  REQUEST_SENT = 'contact.request.sent',
  REQUEST_ACCEPTED = 'contact.request.accepted',
  FRIEND_REMOVED = 'contact.friend.removed',
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
