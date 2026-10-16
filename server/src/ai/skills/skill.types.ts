export type SkillDefinition = {
  readonly versionId?: number;
  readonly resourceId?: number;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly systemInstructions: string;
  readonly resources?: readonly import("../../agent-management/skill-resources").SkillResource[];
};
export type SkillSummary = Pick<
  SkillDefinition,
  "id" | "name" | "version" | "description"
>;
