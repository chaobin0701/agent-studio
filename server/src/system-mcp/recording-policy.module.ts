import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { RecordingPolicyService } from "./recording-policy.service";

@Module({ imports: [AdminModule], providers: [RecordingPolicyService], exports: [RecordingPolicyService] })
export class RecordingPolicyModule {}
