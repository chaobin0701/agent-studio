import { Module } from "@nestjs/common";
import { InteractionService } from "./interaction.service";
@Module({providers:[InteractionService],exports:[InteractionService]})
export class InteractionModule {}
