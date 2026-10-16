import { Module } from "@nestjs/common";
import { SkillRegistry } from "./skill-registry";

/** Skills are user-managed resources, never installed business defaults. */
@Module({ providers: [SkillRegistry], exports: [SkillRegistry] })
export class SkillsModule {}
