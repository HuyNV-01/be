import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { CustomTagEntity } from 'src/entity/custom-tag.entity';
import { In, Repository } from 'typeorm';

import {
  TagActionWorkflowExecutor,
  TagWorkflowExecutionSummary,
} from './tag-action-workflow.executor';

@Injectable()
export class ConversationTaggingService {
  constructor(
    @InjectRepository(CustomTagEntity)
    private readonly customTagRepo: Repository<CustomTagEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    private readonly realtimeEmitter: RealtimeEmitterService,
    private readonly tagWorkflowExecutor: TagActionWorkflowExecutor,
  ) {}

  async toggleConversationTag(params: {
    shopId: string;
    conversationId: string;
    tagId: string;
    actorUserId: string;
    forceState?: 'ADD' | 'REMOVE';
    recursionDepth?: number;
  }): Promise<{
    conversationId: string;
    activeTagIds: string[];
    addedTagId?: string;
    removedTagIds: string[];
    workflowSummary?: TagWorkflowExecutionSummary;
  }> {
    // Vá lỗ hổng bảo mật IDOR: Bắt buộc lọc theo `shopId` để ngăn gắn Tag chéo giữa các shop
    const [conversation, targetTag] = await Promise.all([
      this.conversationRepo.findOne({
        where: { id: params.conversationId, shopId: params.shopId },
      }),
      this.customTagRepo.findOne({
        where: { id: params.tagId, shopId: params.shopId, isActive: true },
      }),
    ]);

    if (!conversation) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    if (!targetTag) throw new NotFoundException('CUSTOM_TAG_NOT_FOUND');

    const currentIds = new Set<string>(
      Array.isArray(conversation.activeTagIdsJson) ? conversation.activeTagIdsJson : [],
    );
    const removedTagIds: string[] = [];
    let addedTagId: string | undefined;

    const shouldRemove =
      params.forceState === 'REMOVE' ||
      (params.forceState !== 'ADD' && currentIds.has(targetTag.id));

    if (shouldRemove) {
      currentIds.delete(targetTag.id);
      removedTagIds.push(targetTag.id);
    } else {
      if (targetTag.isMutuallyExclusiveGroup) {
        const siblingTags = await this.customTagRepo.find({
          where: {
            shopId: params.shopId,
            category: targetTag.category,
            isMutuallyExclusiveGroup: true,
          },
          select: ['id'],
        });
        for (const sib of siblingTags) {
          if (sib.id !== targetTag.id && currentIds.has(sib.id)) {
            currentIds.delete(sib.id);
            removedTagIds.push(sib.id);
          }
        }
      }

      for (const autoRemId of targetTag.autoRuleConfigJson?.removeTagIdsOnApply || []) {
        if (currentIds.has(autoRemId)) {
          currentIds.delete(autoRemId);
          removedTagIds.push(autoRemId);
        }
      }

      currentIds.add(targetTag.id);
      addedTagId = targetTag.id;
    }

    const updatedActiveTagIds = Array.from(currentIds);
    await this.conversationRepo.update(
      { id: conversation.id, shopId: params.shopId },
      { activeTagIdsJson: updatedActiveTagIds },
    );

    const payload = {
      conversationId: conversation.id,
      shopId: params.shopId,
      activeTagIds: updatedActiveTagIds,
      addedTagId,
      removedTagIds,
      actorUserId: params.actorUserId,
    };

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversation.id,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.TAGS_UPDATED,
      payload,
    );

    if (conversation.assignedAgentId) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        conversation.assignedAgentId,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.TAGS_UPDATED,
        payload,
      );
    }

    const workflowSummary = await this.tagWorkflowExecutor.executeTagWorkflows({
      shopId: params.shopId,
      conversation,
      tag: targetTag,
      trigger: shouldRemove ? 'ON_REMOVE' : 'ON_APPLY',
      actorUserId: params.actorUserId,
      recursionDepth: params.recursionDepth ?? 0,
    });

    return {
      conversationId: conversation.id,
      activeTagIds: updatedActiveTagIds,
      addedTagId,
      removedTagIds,
      workflowSummary,
    };
  }

  async bulkAssignConversationTags(params: {
    shopId: string;
    conversationIds: string[];
    addTagIds?: string[];
    removeTagIds?: string[];
    actorUserId: string;
  }): Promise<{
    updatedCount: number;
    results: Array<{ conversationId: string; activeTagIds: string[] }>;
  }> {
    // Vá lỗ hổng bảo mật IDOR: Bắt buộc lọc theo `shopId`
    const conversations = await this.conversationRepo.find({
      where: { id: In(params.conversationIds), shopId: params.shopId },
    });

    const addTags =
      params.addTagIds && params.addTagIds.length > 0
        ? await this.customTagRepo.find({
            where: { id: In(params.addTagIds), shopId: params.shopId, isActive: true },
          })
        : [];

    const exclusiveCategories = new Set(
      addTags.filter((t) => t.isMutuallyExclusiveGroup).map((t) => t.category),
    );

    const exclusiveCategorySiblings =
      exclusiveCategories.size > 0
        ? await this.customTagRepo.find({
            where: {
              shopId: params.shopId,
              category: In(Array.from(exclusiveCategories)),
              isMutuallyExclusiveGroup: true,
            },
          })
        : [];

    const results: Array<{ conversationId: string; activeTagIds: string[] }> = [];

    for (const conv of conversations) {
      const tagSet = new Set<string>(
        Array.isArray(conv.activeTagIdsJson) ? conv.activeTagIdsJson : [],
      );

      for (const remId of params.removeTagIds || []) {
        tagSet.delete(remId);
      }

      for (const tagToAdd of addTags) {
        if (tagToAdd.isMutuallyExclusiveGroup) {
          for (const sib of exclusiveCategorySiblings) {
            if (sib.category === tagToAdd.category && sib.id !== tagToAdd.id) {
              tagSet.delete(sib.id);
            }
          }
        }
        tagSet.add(tagToAdd.id);
      }

      const activeTagIds = Array.from(tagSet);
      await this.conversationRepo.update(
        { id: conv.id, shopId: params.shopId },
        { activeTagIdsJson: activeTagIds },
      );

      this.realtimeEmitter.emitToConversation(
        SOCKET_CONFIG.namespaces.CHAT,
        conv.id,
        SOCKET_CONFIG.events.OMNICHANNEL_INBOX.TAGS_UPDATED,
        {
          conversationId: conv.id,
          shopId: params.shopId,
          activeTagIds,
          actorUserId: params.actorUserId,
        },
      );

      for (const tagToAdd of addTags) {
        void this.tagWorkflowExecutor.executeTagWorkflows({
          shopId: params.shopId,
          conversation: conv,
          tag: tagToAdd,
          trigger: 'ON_APPLY',
          actorUserId: params.actorUserId,
          recursionDepth: 1,
        });
      }

      results.push({ conversationId: conv.id, activeTagIds });
    }

    return {
      updatedCount: results.length,
      results,
    };
  }
}
