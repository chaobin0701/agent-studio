import { ArrayNotEmpty, ArrayUnique, IsArray, IsEmail, IsInt, IsString, IsOptional, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class AdminLoginDto {
  // Keep the legacy field name for existing integrations; accepts a login identity.
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  email!: string;

  @IsString()
  password!: string;
}

export class CreateAdminDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/)
  username?: string;

  @IsString()
  @MinLength(10)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  roleIds!: number[];
}
