import { integerEnv, optionalEnv, type EnvSource } from "@lifeos/core";
import { DateTime } from "luxon";

export interface BotConfig {
  nodeEnv: string;
  host: string;
  port: number;
  telegramBotToken?: string;
  telegramWebhookPath: string;
  telegramWebhookSecret?: string;
  telegramWebAppUrl?: string;
  tmaUrl?: string;
  tmaStaticDir?: string;
  /** @deprecated Static ingest secrets are no longer accepted by the server. */
  lifeosIngestSecret?: string;
  lifeosHealthIngestJwtSecret?: string;
  /** @deprecated Static ingest secrets are no longer accepted by the server. */
  allowLegacyHealthIngestSecret: false;
  lifeosDefaultUserId?: string;
  lifeosDefaultTelegramUserId?: number;
  lifeosAdminTelegramIds: number[];
  lifeosSignupMode: "pending_approval";
  allowUnsafeTmaDevAuth: boolean;
  openRouterApiKey?: string;
  financeAiModel?: string;
  financeAiEnabled: boolean;
  assistantEnabled: boolean;
  assistantModelEnabled: boolean;
  assistantModel?: string;
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
  googleOAuthRedirectUri?: string;
  googleOAuthStateSecret?: string;
  syncthingApiUrl?: string;
  syncthingApiKey?: string;
  syncthingServerDeviceId?: string;
  scheduleEnabled: boolean;
  scheduleSendTime: string;
  scheduleTimezone: string;
  scheduleGroup: string;
  scheduleSubgroup: "A";
  scheduleOwnerTelegramId?: number;
}

export function telegramIdListEnv(source: EnvSource, name: string): number[] {
  const value = optionalEnv(source, name);

  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = Number(item);

      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must contain comma-separated Telegram ids`);
      }

      return parsed;
    });
}

function signupModeEnv(source: EnvSource): "pending_approval" {
  const value = optionalEnv(source, "LIFEOS_SIGNUP_MODE", "pending_approval");

  if (value !== "pending_approval") {
    throw new Error("LIFEOS_SIGNUP_MODE must be pending_approval");
  }

  return value;
}

function booleanEnv(
  source: EnvSource,
  name: string,
  fallback = false,
): boolean {
  const value = optionalEnv(source, name);

  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadBotConfig(source: EnvSource = process.env): BotConfig {
  const assistantModelEnabled = booleanEnv(
    source,
    "ASSISTANT_MODEL_ENABLED",
    false,
  );
  if (
    assistantModelEnabled &&
    (!optionalEnv(source, "OPENROUTER_API_KEY") ||
      !optionalEnv(source, "ASSISTANT_MODEL"))
  ) {
    throw new Error(
      "ASSISTANT_MODEL_ENABLED requires OPENROUTER_API_KEY and ASSISTANT_MODEL",
    );
  }
  const nodeEnv =
    optionalEnv(source, "NODE_ENV", "development") ?? "development";
  const allowUnsafeTmaDevAuth = booleanEnv(
    source,
    "ALLOW_UNSAFE_TMA_DEV_AUTH",
    false,
  );

  if (nodeEnv.toLowerCase() === "production" && allowUnsafeTmaDevAuth) {
    throw new Error(
      "ALLOW_UNSAFE_TMA_DEV_AUTH cannot be enabled when NODE_ENV=production",
    );
  }

  const scheduleSendTime =
    optionalEnv(source, "SCHEDULE_SEND_TIME", "20:00") ?? "20:00";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleSendTime)) {
    throw new Error("SCHEDULE_SEND_TIME must be HH:mm (24-hour time)");
  }
  const scheduleTimezone =
    optionalEnv(source, "SCHEDULE_TIMEZONE", "Asia/Almaty") ?? "Asia/Almaty";
  if (!DateTime.now().setZone(scheduleTimezone).isValid) {
    throw new Error("SCHEDULE_TIMEZONE must be a valid IANA timezone");
  }
  const scheduleGroup =
    optionalEnv(source, "SCHEDULE_GROUP", "25-04") ?? "25-04";
  if (scheduleGroup !== "25-04") {
    throw new Error(
      "Static schedule currently supports only SCHEDULE_GROUP=25-04",
    );
  }
  const scheduleSubgroup = optionalEnv(source, "SCHEDULE_SUBGROUP", "A") ?? "A";
  if (scheduleSubgroup !== "A") {
    throw new Error(
      "Static schedule currently supports only SCHEDULE_SUBGROUP=A",
    );
  }
  const adminTelegramIds = telegramIdListEnv(
    source,
    "LIFEOS_ADMIN_TELEGRAM_IDS",
  );
  const defaultTelegramUserId = optionalEnv(
    source,
    "LIFEOS_DEFAULT_TELEGRAM_USER_ID",
  )
    ? integerEnv(source, "LIFEOS_DEFAULT_TELEGRAM_USER_ID", 0)
    : undefined;
  const ownerIdRaw = optionalEnv(source, "OWNER_TELEGRAM_ID");
  const explicitOwnerId =
    ownerIdRaw === undefined ? undefined : Number(ownerIdRaw);
  if (
    explicitOwnerId !== undefined &&
    (!Number.isSafeInteger(explicitOwnerId) || explicitOwnerId <= 0)
  ) {
    throw new Error("OWNER_TELEGRAM_ID must be a positive Telegram id");
  }

  return {
    nodeEnv,
    host: optionalEnv(source, "HOST", "0.0.0.0") ?? "0.0.0.0",
    port: integerEnv(source, "PORT", 3000),
    telegramBotToken: optionalEnv(source, "TELEGRAM_BOT_TOKEN"),
    telegramWebhookPath:
      optionalEnv(source, "TELEGRAM_WEBHOOK_PATH", "/telegram/webhook") ??
      "/telegram/webhook",
    telegramWebhookSecret: optionalEnv(source, "TELEGRAM_WEBHOOK_SECRET"),
    telegramWebAppUrl: optionalEnv(source, "TELEGRAM_WEBAPP_URL"),
    tmaUrl:
      optionalEnv(source, "TMA_URL") ??
      optionalEnv(source, "TMA_APP_URL") ??
      optionalEnv(source, "TELEGRAM_WEBAPP_URL"),
    tmaStaticDir: optionalEnv(source, "TMA_STATIC_DIR"),
    lifeosIngestSecret: undefined,
    lifeosHealthIngestJwtSecret: optionalEnv(
      source,
      "LIFEOS_HEALTH_INGEST_JWT_SECRET",
    ),
    allowLegacyHealthIngestSecret: false,
    lifeosDefaultUserId: optionalEnv(source, "LIFEOS_DEFAULT_USER_ID"),
    lifeosDefaultTelegramUserId: defaultTelegramUserId,
    lifeosAdminTelegramIds: adminTelegramIds,
    lifeosSignupMode: signupModeEnv(source),
    allowUnsafeTmaDevAuth,
    openRouterApiKey: optionalEnv(source, "OPENROUTER_API_KEY"),
    financeAiModel: optionalEnv(source, "FINANCE_AI_MODEL"),
    financeAiEnabled: booleanEnv(source, "FINANCE_AI_ENABLED", false),
    assistantEnabled: booleanEnv(source, "ASSISTANT_ENABLED", false),
    assistantModelEnabled,
    assistantModel: optionalEnv(source, "ASSISTANT_MODEL"),
    googleOAuthClientId: optionalEnv(source, "GOOGLE_OAUTH_CLIENT_ID"),
    googleOAuthClientSecret: optionalEnv(source, "GOOGLE_OAUTH_CLIENT_SECRET"),
    googleOAuthRedirectUri: optionalEnv(source, "GOOGLE_OAUTH_REDIRECT_URI"),
    googleOAuthStateSecret: optionalEnv(source, "GOOGLE_OAUTH_STATE_SECRET"),
    syncthingApiUrl: optionalEnv(source, "SYNCTHING_API_URL"),
    syncthingApiKey: optionalEnv(source, "SYNCTHING_API_KEY"),
    syncthingServerDeviceId: optionalEnv(source, "SYNCTHING_SERVER_DEVICE_ID"),
    scheduleEnabled: booleanEnv(source, "SCHEDULE_ENABLED", false),
    scheduleSendTime,
    scheduleTimezone,
    scheduleGroup,
    scheduleSubgroup,
    scheduleOwnerTelegramId:
      explicitOwnerId ??
      defaultTelegramUserId ??
      (adminTelegramIds.length === 1 ? adminTelegramIds[0] : undefined),
  };
}
