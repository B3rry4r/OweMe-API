import { IsBoolean, IsIn, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { ROLE_VALUES, Role } from '../enums';

/** POST /staff — invite. role coerced to 'staff' server-side (owner is unique). */
export class CreateStaffDto {
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsIn(ROLE_VALUES)
  role!: Role;
}

/** PATCH /staff/:id — activate/deactivate. */
export class UpdateStaffDto {
  @IsBoolean()
  active!: boolean;
}
