import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { SupabaseScheduleDeliveryStore } from "./schedule-delivery.js";
import type { Database } from "./types.js";

describe("SupabaseScheduleDeliveryStore", () => {
  it("claims through the atomic RPC and fences the status update with its token", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "claimed", error: null });
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: { user_id: "user-1" }, error: null });
    const eq = vi.fn();
    const query = { eq, select: vi.fn(), maybeSingle };
    eq.mockReturnValue(query);
    query.select.mockReturnValue(query);
    const update = vi.fn().mockReturnValue(query);
    const client = {
      rpc,
      from: vi.fn().mockReturnValue({ update }),
    } as unknown as SupabaseClient<Database>;
    const store = new SupabaseScheduleDeliveryStore(client);

    const claim = await store.claim("user-1", "2026-09-28");
    expect(claim.status).toBe("claimed");
    expect(rpc).toHaveBeenCalledWith("claim_schedule_delivery", {
      p_user_id: "user-1",
      p_send_on: "2026-09-28",
      p_claim_token: claim.status === "claimed" ? claim.token : undefined,
    });
    if (claim.status !== "claimed") throw new Error("expected a claim");
    await store.mark("user-1", "2026-09-28", claim.token, "sent");
    expect(eq).toHaveBeenCalledWith("claim_token", claim.token);
    expect(eq).toHaveBeenCalledWith("status", "attempted");
    expect(update).toHaveBeenCalledWith({
      status: "sent",
      sent_at: expect.any(String),
    });
  });

  it("does not permit a lost claim to be marked sent", async () => {
    const query = {
      eq: vi.fn(),
      select: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    query.eq.mockReturnValue(query);
    query.select.mockReturnValue(query);
    const client = {
      from: vi.fn().mockReturnValue({ update: vi.fn().mockReturnValue(query) }),
    } as unknown as SupabaseClient<Database>;
    const store = new SupabaseScheduleDeliveryStore(client);
    await expect(
      store.mark("user-1", "2026-09-28", "old-token", "sent"),
    ).rejects.toThrow("claim was lost");
  });
});
