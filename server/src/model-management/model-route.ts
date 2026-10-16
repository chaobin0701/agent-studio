import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmProvider } from "../ai/providers/llm-provider";
import type { ModelManagementService } from "./model-management.service";
import {
  LangChainOpenAIProvider,
  MODEL_SDK_IMPLEMENTATION_VERSION,
} from "../ai/providers/langchain-openai.provider";
import { ProviderAuthenticationError } from "../ai/providers/provider-errors";
import {
  llmDeploymentSchema,
  type PlanVersion,
  type DeploymentSnapshot,
} from "./model-management.types";

type Route = { version: PlanVersion | null; fallback: LlmProvider };
const routes = new AsyncLocalStorage<Route>();
export interface RoutedProvider extends LlmProvider {
  withPlanVersion<T>(
    version: PlanVersion | null,
    task: () => Promise<T>,
  ): Promise<T>;
  withPlan<T>(task: () => Promise<T>): Promise<T>;
  attemptPlan(maxRetries?: number): {
    provider: LlmProvider;
    deploymentId?: number;
    versionId?: number;
    deploymentAttempt: number;
    maxRetries: number;
  }[];
  planMetadata(): { versionId: number; planId: number; version: number } | null;
}
/** Request-scoped immutable parameters, live credential lookup, no retries inside adapters. */
export class ManagedRuntimeProvider implements RoutedProvider {
  constructor(
    private readonly management: ModelManagementService,
    private readonly fallback: () => LlmProvider,
  ) {}
  async withPlan<T>(task: () => Promise<T>): Promise<T> {
    if (routes.getStore()) return task();
    const version = await this.management.activePlan();
    return routes.run({ version, fallback: this.fallback() }, task);
  }
  withPlanVersion<T>(
    version: PlanVersion | null,
    task: () => Promise<T>,
  ): Promise<T> {
    return routes.run({ version, fallback: this.fallback() }, task);
  }
  private get route() {
    return routes.getStore();
  }
  private get version() {
    return this.route ? this.route.version : this.management.currentPlan;
  }
  get model() {
    return (
      this.version?.config.deployments[0]?.config.model ?? this.fallback().model
    );
  }
  get contextWindowTokens() {
    return this.version
      ? Math.min(
          ...this.version.config.deployments.map(
            (d) => llmDeploymentSchema.parse(d.config).contextWindowTokens,
          ),
        )
      : this.fallback().contextWindowTokens;
  }
  // Use a conservative budget so every candidate can accept the same request.
  get maxOutputTokens() {
    return this.version
      ? Math.min(
          ...this.version.config.deployments.map(
            (d) => llmDeploymentSchema.parse(d.config).maxOutputTokens,
          ),
        )
      : this.fallback().maxOutputTokens;
  }
  planMetadata() {
    const v = this.route?.version;
    return v
      ? { versionId: v.id, planId: v.plan_id, version: v.version }
      : null;
  }
  attemptPlan(maxRetries?: number) {
    const v = this.route?.version;
    if (!v) {
      const retries = Math.min(3, Math.max(0, maxRetries ?? 3));
      return Array.from({ length: retries + 1 }, (_, index) => ({
        provider: this.route?.fallback ?? this.fallback(),
        deploymentAttempt: index + 1,
        maxRetries: retries,
      }));
    }
    // One decision has one retry budget, shared by primary and backup. Reserve
    // a first attempt for each backup instead of exhausting the primary budget.
    const budget = 4;
    let remaining = budget;
    const deployments = v.config.deployments.slice(0, budget);
    return deployments.flatMap((d, deploymentIndex) => {
      const retries = Math.min(
        3,
        Math.max(
          0,
          maxRetries ?? llmDeploymentSchema.parse(d.config).maxRetries,
        ),
      );
      const provider = this.provider(d);
      const attempts = Math.min(
        retries + 1,
        remaining - (deployments.length - deploymentIndex - 1),
      );
      remaining -= attempts;
      return Array.from({ length: attempts }, (_, index) => ({
        provider,
        deploymentId: d.id,
        versionId: v.id,
        deploymentAttempt: index + 1,
        maxRetries: attempts - 1,
      }));
    });
  }
  private provider(d: DeploymentSnapshot): LlmProvider {
    const config = llmDeploymentSchema.parse(d.config);
    const management = this.management;
    const create = async () => {
      let apiKey: string;
      try {
        apiKey = await management.credential(d);
      } catch {
        throw new ProviderAuthenticationError();
      }
      return new LangChainOpenAIProvider({
        ...config,
        baseUrl: d.baseUrl,
        apiKey,
      });
    };
    return {
      model: config.model,
      implementationVersion: MODEL_SDK_IMPLEMENTATION_VERSION,
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokens: config.maxOutputTokens,
      async chat(request) {
        return (await create()).chat({ ...request, model: config.model });
      },
      async *stream(request) {
        yield* (await create()).stream({ ...request, model: config.model });
      },
    };
  }
  async chat(request: Parameters<LlmProvider["chat"]>[0]) {
    return this.withPlan(() => this.attemptPlan(0)[0]!.provider.chat(request));
  }
  async *stream(request: Parameters<LlmProvider["stream"]>[0]) {
    // LlmService captures the plan before constructing its attempt schedule.
    const p = this.attemptPlan(0)[0]!.provider;
    yield* p.stream(request);
  }
}
export function isRoutedProvider(
  provider: LlmProvider,
): provider is RoutedProvider {
  return "withPlan" in provider && "attemptPlan" in provider;
}
