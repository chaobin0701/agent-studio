import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';

/** Encrypts admin-managed provider secrets before they are persisted. */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(config: AppConfigService) {
    this.key = createHash('sha256').update(config.modelConfigEncryptionKey || config.jwt.secret).digest();
  }

  encrypt(value: string): string {
    if (!value.trim()) throw new Error('Secret cannot be empty');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, encrypted].map((item) => item.toString('base64url')).join('.');
  }

  decrypt(value: string): string {
    const [ivText, tagText, encryptedText] = value.split('.');
    if (!ivText || !tagText || !encryptedText) throw new Error('Invalid encrypted secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
  }
}
