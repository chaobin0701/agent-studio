type Version = { id: number; revision?: number; status: string };
type Agent = { id: number; currentVersionId?: number | null; versions: Version[] };

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function playgroundRoute(agent: Agent, selected?: number) {
  if (!positive(agent.id)) return undefined;
  const version = agent.versions.find((item) => item.id === selected);
  if (selected !== undefined && !version) return undefined;
  if (version?.status === "draft") {
    if (!positive(version.id) || !positive(version.revision)) return undefined;
    return {
      path: "/agent-playground",
      query: {
        agentId: String(agent.id),
        draftVersionId: String(version.id),
        draftRevision: String(version.revision),
      },
    };
  }
  if (version && version.id !== agent.currentVersionId) return undefined;
  if (!positive(agent.currentVersionId)) return undefined;
  return { path: "/agent-playground", query: { agentId: String(agent.id) } };
}

export function selectedDraftQuery(query: Record<string, unknown>) {
  const version = query.draftVersionId;
  const revision = query.draftRevision;
  if (version === undefined && revision === undefined) return { valid: true };
  if (
    typeof version !== "string" ||
    typeof revision !== "string" ||
    !/^[1-9]\d*$/.test(version) ||
    !/^[1-9]\d*$/.test(revision) ||
    !positive(Number(version)) ||
    !positive(Number(revision))
  ) return { valid: false };
  return { valid: true, versionId: Number(version), revision: Number(revision) };
}
