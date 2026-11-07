import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { CustomTagEntity } from 'src/entity/custom-tag.entity';
import { MessageTagAssignmentEntity } from 'src/entity/message-tag-assignment.entity';
import { MessageEntity } from 'src/entity/message.entity';
import { MessageCryptoService } from 'src/modules/chat/services/message-crypto.service';
import { In, Repository } from 'typeorm';

export interface BookmarkedMessageDetailItem {
  assignmentId: string;
  conversationId: string;
  messageId: string;
  tagId: string;
  tagName: string;
  tagSlug: string;
  colorOklch: string;
  colorHex: string;
  messageSnippetPreview: string | null;
  noteText: string | null;
  assignedByUserId: string;
  createdAt: string;
}

@Injectable()
export class MessageBookmarkTagService {
  constructor(
    @InjectRepository(MessageTagAssignmentEntity)
    private readonly assignmentRepo: Repository<MessageTagAssignmentEntity>,
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    @InjectRepository(CustomTagEntity)
    private readonly customTagRepo: Repository<CustomTagEntity>,
    private readonly messageCryptoService: MessageCryptoService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  /**
   * F02.3: Gắn hoặc gỡ nhãn Bookmark lên từng bong bóng tin nhắn (Địa chỉ giao, Bill CK, Số đo, Lưu ý đóng gói)
   */
  async toggleMessageBookmarkTag(params: {
    shopId: string;
    conversationId: string;
    messageId: string;
    tagId: string;
    actorUserId: string;
    noteText?: string;
  }): Promise<{
    action: 'ADDED' | 'REMOVED';
    messageId: string;
    conversationId: string;
    messageTagIds: string[];
    assignment?: MessageTagAssignmentEntity;
  }> {
    const [message, tag] = await Promise.all([
      this.messageRepo.findOne({
        where: { id: params.messageId, conversationId: params.conversationId },
      }),
      this.customTagRepo.findOne({
        where: { id: params.tagId, shopId: params.shopId, isActive: true },
      }),
    ]);

    if (!message) throw new NotFoundException('MESSAGE_NOT_FOUND');
    if (!tag) throw new NotFoundException('CUSTOM_TAG_NOT_FOUND');

    const existing = await this.assignmentRepo.findOne({
      where: {
        conversationId: params.conversationId,
        messageId: params.messageId,
        tagId: params.tagId,
      },
    });

    const currentTagIds = new Set<string>(
      Array.isArray(message.messageTagIdsJson) ? message.messageTagIdsJson : [],
    );

    let action: 'ADDED' | 'REMOVED' = 'ADDED';
    let savedAssignment: MessageTagAssignmentEntity | undefined;

    if (existing) {
      await this.assignmentRepo.remove(existing);
      currentTagIds.delete(params.tagId);
      action = 'REMOVED';
    } else {
      const decryptedSnippet = this.messageCryptoService
        .decryptForConversation(message.content, params.conversationId)
        .slice(0, 480);

      const newAssignment = this.assignmentRepo.create({
        shopId: params.shopId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        tagId: params.tagId,
        assignedByUserId: params.actorUserId,
        messageSnippetPreview: decryptedSnippet || `[${message.type}]`,
        noteText: params.noteText?.trim() || null,
      });
      savedAssignment = await this.assignmentRepo.save(newAssignment);
      currentTagIds.add(params.tagId);
      action = 'ADDED';
    }

    const updatedTagIds = Array.from(currentTagIds);
    await this.messageRepo.update(
      { id: message.id, conversationId: params.conversationId },
      { messageTagIdsJson: updatedTagIds },
    );

    const payload = {
      action,
      shopId: params.shopId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      tagId: params.tagId,
      tagName: tag.name,
      colorOklch: tag.colorOklch,
      messageTagIds: updatedTagIds,
      assignment: savedAssignment,
    };

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      params.conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.MESSAGE_TAGGED,
      payload,
    );

    return {
      action,
      messageId: params.messageId,
      conversationId: params.conversationId,
      messageTagIds: updatedTagIds,
      assignment: savedAssignment,
    };
  }

  /**
   * F02.4: Ngăn kéo tra cứu nhanh các bong bóng tin nhắn đã gắn nhãn cho Sale, Kho và Kế toán
   */
  async listBookmarkedMessages(params: {
    shopId: string;
    conversationId?: string;
    tagId?: string;
  }): Promise<BookmarkedMessageDetailItem[]> {
    const whereClause: Record<string, any> = { shopId: params.shopId };
    if (params.conversationId) {
      whereClause.conversationId = params.conversationId;
    }
    if (params.tagId) {
      whereClause.tagId = params.tagId;
    }

    const assignments = await this.assignmentRepo.find({
      where: whereClause,
      order: { createdAt: 'DESC' },
      take: 100,
    });

    if (assignments.length === 0) return [];

    const tagIds = Array.from(new Set(assignments.map((a) => a.tagId)));
    const tags = await this.customTagRepo.find({
      where: { id: In(tagIds) },
    });
    const tagMap = new Map(tags.map((t) => [t.id, t]));

    return assignments.map((item) => {
      const tag = tagMap.get(item.tagId);
      return {
        assignmentId: item.id,
        conversationId: item.conversationId,
        messageId: item.messageId,
        tagId: item.tagId,
        tagName: tag?.name || 'Bookmark',
        tagSlug: tag?.slug || 'BOOKMARK',
        colorOklch: tag?.colorOklch || 'oklch(0.68 0.16 237)',
        colorHex: tag?.colorHex || '#0EA5E9',
        messageSnippetPreview: item.messageSnippetPreview,
        noteText: item.noteText,
        assignedByUserId: item.assignedByUserId,
        createdAt: item.createdAt ? item.createdAt.toISOString() : new Date().toISOString(),
      };
    });
  }
}
