type Version = {
  id: number;
  status: string;
  name?: string;
  responsibility?: string;
  mode?: string;
  modelPlanVersionId?: number | null;
};
type Agent = {
  name: string;
  currentVersionId?: number | null;
  hasUnpublishedChanges?: boolean;
  versions: Version[];
};
/** List facts come from the effective version, never a newer unfinished draft. */
export function agentSummary(
  agent: Agent | Record<string, any>,
  models: { id: number; name: string }[],
) {
  const versions: Version[] = Array.isArray(agent.versions) ? agent.versions : [];
  const version = agent.currentVersionId
    ? versions.find((v) => v.id === agent.currentVersionId)
    : (versions.find((v) => v.status === "draft") ?? versions[0]);
  return {
    name: version?.name ?? agent.name,
    responsibility: version?.responsibility ?? "",
    mode: version?.mode === "multi" ? "multi" : "single",
    model:
      models.find((m) => m.id === version?.modelPlanVersionId)?.name ??
      (version?.modelPlanVersionId
        ? `模型方案 #${version.modelPlanVersionId}`
        : "未选择模型"),
    state: agent.currentVersionId
      ? !version
        ? "missing"
        : agent.hasUnpublishedChanges
          ? "changed"
          : "published"
      : "draft",
  };
}
