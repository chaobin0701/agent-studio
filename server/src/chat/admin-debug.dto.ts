import { IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class InspectConversationDebugDto {
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  conversationIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  traceIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  issueDescription?: string;
}
