import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UploadDocumentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  processingConfig?: string;

  /** Store the file first; the caller will submit parsing settings separately. */
  @IsOptional()
  @IsString()
  deferProcessing?: string;
}
