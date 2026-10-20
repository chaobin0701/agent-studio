import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { InteractionService } from "./interaction.service";
@Module({imports:[AdminModule],providers:[InteractionService],exports:[InteractionService]})
export class InteractionModule {}
