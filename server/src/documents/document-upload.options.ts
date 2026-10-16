import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

// Browsers put UTF-8 bytes in multipart filename parameters without a charset.
// Multer otherwise defaults to Latin-1, corrupting names before normalization
// or persistence. Decode at the upload boundary, not with display heuristics.
export const DOCUMENT_UPLOAD_OPTIONS: MulterOptions = {
  defParamCharset: 'utf8',
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
    fields: 1,
    parts: 2,
    fieldSize: 8 * 1024,
  },
};
