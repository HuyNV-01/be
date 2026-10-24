import { ValidRolesEnum } from 'src/common/enum';
import { PaginationOptions } from 'src/types/query.types';

export interface IBaseQuery extends PaginationOptions {
  search?: string;
}

export interface IBaseReq {
  user: {
    id: string;
    role: ValidRolesEnum;
  };
}
