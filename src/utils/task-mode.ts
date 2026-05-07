import type { ChatRouteConfig, TaskMode, TaskPlan } from "../models/types.js";

export function normalizeTaskMode(mode: unknown): TaskMode | undefined {
  if (typeof mode !== "string" || mode.length === 0) {
    return undefined;
  }

  if (mode === "article_deep") {
    return "article_research";
  }

  return mode as TaskMode;
}

export function normalizeTaskPlan(plan: TaskPlan | undefined): TaskPlan | undefined {
  if (!plan) {
    return undefined;
  }

  const mode = normalizeTaskMode(plan.mode);
  if (!mode || mode === plan.mode) {
    return plan;
  }

  return {
    ...plan,
    mode
  };
}

export function normalizeChatRouteConfig(route: ChatRouteConfig): ChatRouteConfig {
  const mode = normalizeTaskMode(route.mode);
  if (!mode || mode === route.mode) {
    return route;
  }

  return {
    ...route,
    mode
  };
}
