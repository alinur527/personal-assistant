import { loadBotConfig } from "./config.js";
import { createBotDependencies } from "./dependencies.js";
import { createBotServer } from "./server.js";
import { TelegramHttpClient } from "./telegram/client.js";
import { ScheduleService, StaticScheduleProvider } from "@lifeos/core";
import { SupabaseScheduleDeliveryStore } from "@lifeos/db";
import { startDailySchedule } from "./schedule/daily.js";
import { createAssistant } from "./assistant/create.js";

const config = loadBotConfig();
const dependencies = createBotDependencies();
const telegram = config.telegramBotToken
  ? new TelegramHttpClient(config.telegramBotToken)
  : undefined;
const schedule = new ScheduleService(
  new StaticScheduleProvider(),
  config.scheduleGroup,
  config.scheduleSubgroup,
);
const server = createBotServer({
  config,
  store: dependencies.store,
  telegram,
  schedule,
  assistant: createAssistant({ config, ...dependencies, schedule }),
  dependencies: {
    supabaseConfigured: Boolean(dependencies.supabase),
    telegramConfigured: Boolean(telegram),
  },
});

server.listen(config.port, config.host, () => {
  console.info(
    `lifeos bot backend listening on http://${config.host}:${config.port}`,
  );

  if (config.scheduleEnabled) {
    if (
      !telegram ||
      !dependencies.store ||
      !dependencies.supabase ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !config.scheduleOwnerTelegramId
    ) {
      console.error(
        "[schedule] SCHEDULE_ENABLED requires Telegram, Supabase service role, and an owner Telegram ID",
      );
      server.close();
      process.exitCode = 1;
      return;
    }
    startDailySchedule({
      sendTime: config.scheduleSendTime,
      timezone: config.scheduleTimezone,
      ownerTelegramId: config.scheduleOwnerTelegramId,
      schedule,
      store: dependencies.store,
      deliveries: new SupabaseScheduleDeliveryStore(dependencies.supabase),
      telegram,
    });
    console.info(
      `[schedule] daily delivery enabled at ${config.scheduleSendTime} ${config.scheduleTimezone}`,
    );
  }

  if (dependencies.store?.syncFinanceExchangeRates) {
    const syncRates = () => {
      void dependencies
        .store!.syncFinanceExchangeRates()
        .then((count) => {
          if (count > 0) {
            console.info(`[finance] synced ${count} exchange rate quotes`);
          }
        })
        .catch((error: unknown) => {
          console.error("[finance] exchange rate sync failed", {
            errorType: error instanceof Error ? error.name : typeof error,
          });
        });
    };

    syncRates();
    setInterval(syncRates, 24 * 60 * 60 * 1000);
  }
});
