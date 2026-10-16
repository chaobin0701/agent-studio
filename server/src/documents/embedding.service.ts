import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { embedWithProfile, embeddingFingerprint, embeddingProfileSchema, type EmbeddingProfile } from './profile-embedding';

export const EMBEDDING_DIMENSIONS = 2048;

@Injectable()
export class EmbeddingService {
  readonly model: string;
  readonly enabled: boolean;
  readonly fingerprint: string;
  private readonly runtime: AppConfigService;
  private readonly profile: EmbeddingProfile;

  constructor(config?: AppConfigService) {
    this.runtime = config ?? new AppConfigService();
    const embedding = this.runtime.embedding;
    this.model = embedding.model;
    this.enabled = Boolean(embedding.apiKey);
    this.profile = embeddingProfileSchema.parse({ provider: 'volcengine-multimodal', baseUrl: embedding.baseUrl,
      model: this.model, dimensions: EMBEDDING_DIMENSIONS });
    this.fingerprint = embeddingFingerprint(this.profile);
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (!this.enabled) throw new ServiceUnavailableException('Embedding provider is not configured');
    try { return await embedWithProfile(this.profile, inputs, this.runtime); }
    catch { throw new ServiceUnavailableException('Embedding provider returned an invalid vector or is unavailable'); }
  }
}
