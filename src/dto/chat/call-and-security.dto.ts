import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { CallTypeEnum } from 'src/common/enum';

export class EditMessageDto {
  @ApiProperty({ description: 'Conversation UUID' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ description: 'Message UUID cần chỉnh sửa' })
  @IsUUID()
  @IsNotEmpty()
  messageId: string;

  @ApiProperty({ description: 'Nội dung tin nhắn mới' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  content: string;
}

export class RecallMessageDto {
  @ApiProperty({ description: 'Conversation UUID' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ description: 'Message UUID cần thu hồi' })
  @IsUUID()
  @IsNotEmpty()
  messageId: string;
}

export class ReactMessageDto {
  @ApiProperty({ description: 'Conversation UUID' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ description: 'Message UUID' })
  @IsUUID()
  @IsNotEmpty()
  messageId: string;

  @ApiProperty({ description: 'Biểu tượng cảm xúc (Emoji)', example: '❤️' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  emoji: string;
}

export class PinMessageDto {
  @ApiProperty({ description: 'Conversation UUID' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ description: 'Message UUID' })
  @IsUUID()
  @IsNotEmpty()
  messageId: string;

  @ApiProperty({ description: 'Trạng thái ghim (true = ghim, false = bỏ ghim)' })
  @IsBoolean()
  isPinned: boolean;
}

export class AddGroupMembersDto {
  @ApiProperty({ type: [String], description: 'Danh sách User UUID cần thêm vào nhóm' })
  @IsArray()
  @IsUUID('4', { each: true })
  memberIds: string[];
}

export class MuteConversationDto {
  @ApiProperty({ description: 'Trạng thái tắt thông báo hội thoại' })
  @IsBoolean()
  isMuted: boolean;
}

export class RegisterPublicKeyDto {
  @ApiProperty({
    description: 'Khóa công khai E2EE của thiết bị (SPKI Base64 / JWK / X25519)',
  })
  @IsString()
  @IsNotEmpty()
  publicKey: string;

  @ApiPropertyOptional({
    description: 'Thuật toán trao đổi khóa',
    example: 'ECDH-P256',
    default: 'ECDH-P256',
  })
  @IsOptional()
  @IsString()
  algorithm?: string = 'ECDH-P256';

  @ApiProperty({
    description: 'Mã định danh phiên bản khóa (Key ID)',
    example: 'key-2026-01',
  })
  @IsString()
  @IsNotEmpty()
  keyId: string;
}

export class InitiateCallDto {
  @ApiProperty({ description: 'Conversation UUID nơi bắt đầu cuộc gọi' })
  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ enum: CallTypeEnum, example: CallTypeEnum.VIDEO })
  @IsEnum(CallTypeEnum)
  callType: CallTypeEnum;

  @ApiPropertyOptional({
    description: 'SDP Offer khởi tạo (tùy chọn gửi ngay hoặc gửi qua sự kiện call:signal)',
  })
  @IsOptional()
  @IsObject()
  sdpOffer?: Record<string, any>;
}

export class RespondCallDto {
  @ApiProperty({ description: 'Call Session ID' })
  @IsUUID()
  @IsNotEmpty()
  callId: string;

  @ApiPropertyOptional({
    description: 'Lý do từ chối cuộc gọi (declined, busy...)',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class WebRtcSignalDto {
  @ApiProperty({ description: 'Call Session ID' })
  @IsUUID()
  @IsNotEmpty()
  callId: string;

  @ApiProperty({
    description: 'User ID đích nhận gói tín hiệu WebRTC (P2P / Mesh)',
  })
  @IsUUID()
  @IsNotEmpty()
  targetUserId: string;

  @ApiProperty({
    description: 'Loại tín hiệu WebRTC',
    enum: ['offer', 'answer', 'ice-candidate', 'renegotiate'],
  })
  @IsIn(['offer', 'answer', 'ice-candidate', 'renegotiate'])
  type: 'offer' | 'answer' | 'ice-candidate' | 'renegotiate';

  @ApiProperty({
    description: 'Dữ liệu RTCSessionDescriptionInit hoặc RTCIceCandidateInit',
  })
  @IsObject()
  signalData: Record<string, any>;
}

export class ToggleCallMediaDto {
  @ApiProperty({ description: 'Call Session ID' })
  @IsUUID()
  @IsNotEmpty()
  callId: string;

  @ApiPropertyOptional({ description: 'Trạng thái tắt mic' })
  @IsOptional()
  @IsBoolean()
  isAudioMuted?: boolean;

  @ApiPropertyOptional({ description: 'Trạng thái tắt camera' })
  @IsOptional()
  @IsBoolean()
  isVideoOff?: boolean;

  @ApiPropertyOptional({ description: 'Trạng thái chia sẻ màn hình' })
  @IsOptional()
  @IsBoolean()
  isScreenSharing?: boolean;
}
