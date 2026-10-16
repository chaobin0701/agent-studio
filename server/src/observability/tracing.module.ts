import {
  Global,
  Injectable,
  Module,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigModule } from "../config/config.module";
import { AppConfigService } from "../config/config.service";
import { PhoenixExecutionTracer } from "./execution-tracer";

@Injectable()
export class ExecutionTracingService
  extends PhoenixExecutionTracer
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
  providers: [ExecutionTracingService],
  exports: [ExecutionTracingService],
})
export class TracingModule {}
