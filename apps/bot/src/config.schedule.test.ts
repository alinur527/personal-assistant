import { describe, expect, it } from "vitest";
import { loadBotConfig } from "./config.js";

describe("schedule configuration", () => {
  it("uses Asia/Almaty and 20:00 with the static 25-04 A schedule", () => {
    const config = loadBotConfig({});
    expect(config.scheduleEnabled).toBe(false);
    expect(config.scheduleSendTime).toBe("20:00");
    expect(config.scheduleTimezone).toBe("Asia/Almaty");
    expect(config.scheduleGroup).toBe("25-04");
    expect(config.scheduleSubgroup).toBe("A");
    expect(loadBotConfig({ SCHEDULE_ENABLED: "false" }).scheduleEnabled).toBe(
      false,
    );
    expect(loadBotConfig({ SCHEDULE_ENABLED: "true" }).scheduleEnabled).toBe(
      true,
    );
  });

  it("rejects unsupported source settings instead of sending another group's lessons", () => {
    expect(() => loadBotConfig({ SCHEDULE_GROUP: "25-05" })).toThrow(/25-04/);
    expect(() => loadBotConfig({ SCHEDULE_SUBGROUP: "B" })).toThrow(
      /SCHEDULE_SUBGROUP=A/,
    );
    expect(() => loadBotConfig({ SCHEDULE_TIMEZONE: "invalid-zone" })).toThrow(
      /timezone/,
    );
  });

  it("uses the sole configured admin as owner and allows an explicit override", () => {
    expect(
      loadBotConfig({ LIFEOS_ADMIN_TELEGRAM_IDS: "123" })
        .scheduleOwnerTelegramId,
    ).toBe(123);
    expect(
      loadBotConfig({ LIFEOS_ADMIN_TELEGRAM_IDS: "123,456" })
        .scheduleOwnerTelegramId,
    ).toBeUndefined();
    expect(
      loadBotConfig({
        LIFEOS_ADMIN_TELEGRAM_IDS: "123",
        OWNER_TELEGRAM_ID: "456",
      }).scheduleOwnerTelegramId,
    ).toBe(456);
  });
});
