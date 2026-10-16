import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { PromptController } from './prompt.controller';
import { PromptService } from './prompt.service';
import { PromptRuntimeService } from './prompt-runtime.service';
@Module({imports:[AdminModule],controllers:[PromptController],providers:[PromptService,PromptRuntimeService],exports:[PromptService,PromptRuntimeService]})
export class PromptsModule {}
