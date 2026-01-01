import { ContactStatusEnum } from 'src/common/enum';
import { PaginationOptions } from 'src/types/query.types';

export interface ISendFriendRequest {
  targetUserId: string;
}

export interface IUpdateContactAlias {
  alias: string;
}

export interface IActionRequest {
  targetUserId: string;
}

export interface IGetContacts extends PaginationOptions {
  search?: string;
  type?: ContactStatusEnum;
}
