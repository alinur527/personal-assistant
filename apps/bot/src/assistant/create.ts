import {
  SupabaseAssistantStore,
  type LifeOSStore,
  type createLifeOSSupabaseClient,
} from "@lifeos/db";
import type { ScheduleService } from "@lifeos/core";
import type { BotConfig } from "../config.js";
import { AssistantBrain } from "./brain.js";
import { createAssistantTools } from "./tools.js";
import { OpenRouterAssistantProvider } from "./provider.js";

export function createAssistant(options: {
  config: BotConfig;
  supabase?: ReturnType<typeof createLifeOSSupabaseClient>;
  store?: LifeOSStore;
  schedule: ScheduleService;
}): AssistantBrain | undefined {
  if (!options.config.assistantEnabled) return undefined;
  if (!options.supabase || !options.store)
    throw new Error("ASSISTANT_ENABLED requires Supabase");
  const memories = new SupabaseAssistantStore(options.supabase);
  const provider =
    options.config.assistantModelEnabled &&
    options.config.openRouterApiKey &&
    options.config.assistantModel
      ? new OpenRouterAssistantProvider({
          apiKey: options.config.openRouterApiKey,
          model: options.config.assistantModel,
        })
      : undefined;
  return new AssistantBrain({
    registry: createAssistantTools({
      store: options.store,
      memories,
      schedule: options.schedule,
      scheduleTimezone: options.config.scheduleTimezone,
    }),
    memories,
    audit: memories,
    provider,
    log: (event) => console.error("[assistant]", event),
  });
}
