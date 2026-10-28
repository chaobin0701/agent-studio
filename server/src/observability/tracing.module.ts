import {
  Global,
  Injectable,
  Module,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigModule } from "../config/config.module";
import { AppConfigService } from "../config/config.service";
import { LangSmithLinkService } from "./langsmith-link";
import { LangSmithExecutionTracer } from "./execution-tracer";

@Injectable()
export class ExecutionTracingService
  extends LangSmithExecutionTracer
  implements OnApplicationShutdown
{
  constructor(config: AppConfigService) {
    super(config.tracing);
  }
  async onApplicationShutdown() {
    await this.close();
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [ExecutionTracingService, LangSmithLinkService],
  exports: [ExecutionTracingService, LangSmithLinkService],
})
export class TracingModule {}
