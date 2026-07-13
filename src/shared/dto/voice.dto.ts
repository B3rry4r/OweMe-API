import { IsArray, IsOptional, IsString, IsNotEmpty } from 'class-validator';

/** POST /voice/parse — transcript-only. Debits 1 AI credit on success. */
export class VoiceParseDto {
  @IsString()
  @IsNotEmpty()
  transcript!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  knownCustomers?: string[];
}
