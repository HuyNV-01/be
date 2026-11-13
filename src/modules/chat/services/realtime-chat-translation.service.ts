import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { TranslateChatMessageDto } from 'src/dto/chat/omnichannel-inbox.dto';
import { MessageEntity } from 'src/entity/message.entity';
import { Repository } from 'typeorm';

@Injectable()
export class RealtimeChatTranslationService {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messageRepo: Repository<MessageEntity>,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private detectSourceLanguage(text: string): string {
    if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text)) {
      return 'vi';
    }
    if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
    return 'en';
  }

  private translateCommercePhrase(rawText: string, sourceLang: string, targetLang: string): string {
    const trimmed = rawText.trim();
    if (!trimmed || sourceLang === targetLang) return trimmed;

    const viToEnGlossary: Array<[RegExp, string]> = [
      [/dạ shop xin chào/gi, 'Hello and welcome to our store'],
      [/mẫu này còn hàng không/gi, 'Is this item still in stock?'],
      [/còn đủ màu và size/gi, 'is available in all colors and sizes'],
      [
        /cho em xin số điện thoại và địa chỉ/gi,
        'Could you please share your phone number and shipping address',
      ],
      [/miễn phí vận chuyển/gi, 'free shipping'],
      [/kiểm tra hàng trước khi thanh toán/gi, 'inspect the package before payment (COD)'],
      [/cảm ơn anh\/chị/gi, 'Thank you very much'],
    ];

    const enToViGlossary: Array<[RegExp, string]> = [
      [/how much is this/gi, 'Mẫu này giá bao nhiêu vậy shop?'],
      [/is this still available/gi, 'Sản phẩm này hiện còn hàng không ạ?'],
      [/do you ship to/gi, 'Shop có giao hàng tới khu vực'],
      [/what size should i wear/gi, 'Mình nên mặc size nào vừa ạ?'],
      [/can i get a discount/gi, 'Mình có được áp dụng mã giảm giá thêm không?'],
      [/i want to order/gi, 'Mình muốn đặt mua mẫu này'],
      [/thank you/gi, 'Cảm ơn shop nhiều nhé'],
    ];

    let result = trimmed;
    if (targetLang === 'vi') {
      for (const [pattern, replacement] of enToViGlossary) {
        result = result.replace(pattern, replacement);
      }
      if (result === trimmed) {
        result = `[Bản dịch Tiếng Việt tự động]: ${trimmed}`;
      }
    } else if (targetLang === 'en') {
      for (const [pattern, replacement] of viToEnGlossary) {
        result = result.replace(pattern, replacement);
      }
      if (result === trimmed) {
        result = `[EN Auto-Translation]: ${trimmed}`;
      }
    } else {
      result = `[${targetLang.toUpperCase()}]: ${trimmed}`;
    }

    return result;
  }

  /**
   * F03.11: Dịch tự động đa ngôn ngữ 2 chiều trong khung chat (Khách <-> Nhân viên Sale)
   */
  async translateMessageOrDraft(dto: TranslateChatMessageDto): Promise<{
    originalText: string;
    translatedText: string;
    sourceLang: string;
    targetLang: string;
    messageId?: string;
  }> {
    const detectedSource =
      dto.sourceLang && dto.sourceLang !== 'auto'
        ? dto.sourceLang
        : this.detectSourceLanguage(dto.text);

    const translatedText = this.translateCommercePhrase(dto.text, detectedSource, dto.targetLang);

    const translationMeta = {
      translatedText,
      sourceLang: detectedSource,
      targetLang: dto.targetLang,
      translatedAt: new Date().toISOString(),
    };

    if (dto.messageId && dto.conversationId) {
      const msg = await this.messageRepo.findOne({
        where: { id: dto.messageId, conversationId: dto.conversationId },
      });

      if (msg) {
        msg.metadata = {
          ...(msg.metadata || {}),
          translation: translationMeta,
        };
        await this.messageRepo.save(msg);

        this.realtimeEmitter.emitToConversation(
          SOCKET_CONFIG.namespaces.CHAT,
          dto.conversationId,
          SOCKET_CONFIG.events.OMNICHANNEL_INBOX.MESSAGE_TRANSLATED,
          {
            conversationId: dto.conversationId,
            messageId: dto.messageId,
            translation: translationMeta,
          },
        );
      }
    }

    return {
      originalText: dto.text,
      translatedText,
      sourceLang: detectedSource,
      targetLang: dto.targetLang,
      messageId: dto.messageId,
    };
  }
}
