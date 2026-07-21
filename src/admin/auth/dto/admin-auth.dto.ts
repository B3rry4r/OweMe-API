import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

/** Registry AdminAuth request bodies, verbatim. */

export class AdminLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class AdminRefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class AdminChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
