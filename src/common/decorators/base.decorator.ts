import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { ValidRolesEnum } from '../enum';

export const ROLES_KEY = 'roles';

export const Roles = (
  ...roles: [ValidRolesEnum, ...ValidRolesEnum[]]
): CustomDecorator<string> => SetMetadata(ROLES_KEY, roles);
