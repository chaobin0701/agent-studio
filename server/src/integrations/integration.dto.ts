import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { ACCESS_SCOPES, type AccessScope } from './integration.types';
import { Type } from 'class-transformer';
import { IsObject, ValidateNested } from 'class-validator';
import { RequestContextDto } from '../chat/chat.dto';

export class ApplicationLimitSettingsDto {
  @IsBoolean() requestsPerMinute!: boolean;
  @IsBoolean() concurrency!: boolean;
  @IsBoolean() dailyRequests!: boolean;
  @IsBoolean() dailyTokenLimit!: boolean;
}
export class IntegrationAppDto {
  @IsInt() @Min(1) agentId!:number;
  // Deprecated: accepted for old clients, but never selects an Agent version.
  @IsOptional() @IsIn(['dev','test','prod']) environment?:'dev'|'test'|'prod';
  @IsString() @Length(1, 100) name!: string;
  @IsBoolean() enabled!: boolean;
  @IsBoolean() websiteEnabled!: boolean;
  @IsBoolean() apiEnabled!: boolean;
  @IsArray() @ArrayMaxSize(30) @ArrayUnique() @IsString({ each: true }) allowedOrigins!: string[];
  @IsArray() @ArrayMaxSize(4) @ArrayUnique() @IsIn(ACCESS_SCOPES, { each: true }) scopes!: AccessScope[];
  @IsInt() @Min(1) @Max(10000) requestsPerMinute!: number;
  @IsInt() @Min(1) @Max(100) concurrency!: number;
  @IsInt() @Min(1) @Max(1000000) dailyRequests!: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000000000000) dailyTokenLimit?: number | null;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => ApplicationLimitSettingsDto) limitSettings?: ApplicationLimitSettingsDto;
}
export class IntegrationKeyDto {
  @IsString() @Length(1, 100) name!: string;
  @IsArray() @ArrayMaxSize(4) @ArrayUnique() @IsIn(ACCESS_SCOPES, { each: true }) scopes!: AccessScope[];
  @IsOptional() @IsISO8601() expiresAt?: string;
}
export class WidgetSessionDto {
  @IsOptional() @IsUUID() appId?: string;
  @IsOptional() @IsString() @Length(64, 64) resumeToken?: string;
}
export class AgentMessageDto {
  @IsOptional() @IsString() @Length(1, 128) userId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsString() @Length(2, 2000) message!: string;
  @IsOptional() @IsBoolean() stream?: boolean;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => RequestContextDto) context?: RequestContextDto;
}
