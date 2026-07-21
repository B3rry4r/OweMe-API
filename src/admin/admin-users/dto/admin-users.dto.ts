import { IsEmail, IsIn, IsNotEmpty, IsString } from 'class-validator';
import { ADMIN_ROLES, AdminRole } from '../../common';

/** Registry AdminUserManagement request body, verbatim. */

export class CreateAdminUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(ADMIN_ROLES as AdminRole[])
  role!: AdminRole;
}
