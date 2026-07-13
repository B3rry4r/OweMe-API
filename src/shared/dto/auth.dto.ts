import { IsString, IsNotEmpty, Length } from 'class-validator';

export class RequestOtpDto {
  @IsString()
  @IsNotEmpty()
  phone!: string;
}

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
