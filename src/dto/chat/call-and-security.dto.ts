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
import { CallTypeEnum, GroupRoleEnum } from 'src/common/enum';

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

// Thêm vào cuối file: src/dto/chat/call-and-security.dto.ts
export class UpdateParticipantNicknameDto {
  @ApiProperty({ description: 'User UUID của thành viên cần đặt biệt danh' })
  @IsUUID()
  @IsNotEmpty()
  targetUserId: string;

  @ApiPropertyOptional({ description: 'Biệt danh mới (rỗng để xoá biệt danh)', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  nickname?: string | null;
}

export class UpdateConversationSettingsDto {
  @ApiPropertyOptional({ description: 'Tắt thông báo cuộc trò chuyện' })
  @IsOptional()
  @IsBoolean()
  isMuted?: boolean;

  @ApiPropertyOptional({ description: 'Bật/tắt âm thanh thông báo' })
  @IsOptional()
  @IsBoolean()
  soundEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Bật/tắt gửi xác nhận đã đọc (Read Receipts)' })
  @IsOptional()
  @IsBoolean()
  readReceiptsEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Hạn chế (Restrict) cuộc trò chuyện này' })
  @IsOptional()
  @IsBoolean()
  isRestricted?: boolean;
}

export class UpdateDisappearingMessagesDto {
  @ApiPropertyOptional({
    description:
      'Thời gian tự huỷ tin nhắn tính bằng giây (null hoặc 0 để tắt; 60, 3600, 86400, 604800)',
    enum: [0, 60, 300, 3600, 86400, 604800],
  })
  @IsOptional()
  @IsIn([0, 60, 300, 3600, 86400, 604800, null])
  disappearingTtl?: number | null;
}

export class GetSharedAssetsQueryDto {
  @ApiPropertyOptional({ enum: ['MEDIA', 'FILES', 'LINKS'], default: 'MEDIA' })
  @IsOptional()
  @IsIn(['MEDIA', 'FILES', 'LINKS'])
  tab?: 'MEDIA' | 'FILES' | 'LINKS' = 'MEDIA';
}

export class UpdateGroupMemberRoleDto {
  @ApiProperty({
    description:
      'Vai trò mới của thành viên trong nhóm (OWNER = Chuyển quyền trưởng nhóm, ADMIN = Quản trị viên, MEMBER = Thành viên)',
    enum: GroupRoleEnum,
  })
  @IsEnum(GroupRoleEnum)
  @IsNotEmpty()
  role: GroupRoleEnum;
}

export class ForwardMessageDto {
  @ApiProperty({ description: 'Message UUID gốc cần chuyển tiếp' })
  @IsUUID()
  @IsNotEmpty()
  messageId: string;

  @ApiProperty({ description: 'Conversation UUID nguồn' })
  @IsUUID()
  @IsNotEmpty()
  sourceConversationId: string;

  @ApiProperty({
    type: [String],
    description: 'Danh sách Conversation UUID đích nhận tin nhắn chuyển tiếp',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  targetConversationIds: string[];
}
