import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, Length, Max, Min, MinLength, ValidateNested } from 'class-validator';

export class PreviousTurnDto {
  @IsString()
  @Length(2, 2000)
  question!: string;

  @IsString()
  @MinLength(1)
  answer!: string;
}

export class RequestContextDto {
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class AskQuestionDto {
  @IsString()
  @Length(2, 2000)
  question!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RequestContextDto)
  context?: RequestContextDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => PreviousTurnDto)
  history?: PreviousTurnDto[];
}
