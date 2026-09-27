import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types.js";

export type ScheduleDeliveryClaim =
  | { status: "claimed"; token: string }
  | { status: "busy" | "sent" };

export interface ScheduleDeliveryStore {
  claim(userId: string, sendOn: string): Promise<ScheduleDeliveryClaim>;
  mark(
    userId: string,
    sendOn: string,
    token: string,
    status: "sent" | "failed",
  ): Promise<void>;
}

export class SupabaseScheduleDeliveryStore implements ScheduleDeliveryStore {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async claim(userId: string, sendOn: string): Promise<ScheduleDeliveryClaim> {
    const token = randomUUID();
    const { data, error } = await this.client.rpc("claim_schedule_delivery", {
      p_user_id: userId,
      p_send_on: sendOn,
      p_claim_token: token,
    });
    if (error) {
      throw new Error(`Schedule delivery claim failed: ${error.message}`);
    }
    if (data === "claimed") {
      return { status: "claimed", token };
    }
    if (data === "busy" || data === "sent") {
      return { status: data };
    }
    throw new Error(
      `Unexpected schedule delivery claim status: ${String(data)}`,
    );
  }

  async mark(
    userId: string,
    sendOn: string,
    token: string,
    status: "sent" | "failed",
  ): Promise<void> {
    const { data, error } = await this.client
      .from("schedule_deliveries")
      .update({
        status,
        sent_at: status === "sent" ? new Date().toISOString() : null,
      })
      .eq("user_id", userId)
      .eq("send_on", sendOn)
      .eq("claim_token", token)
      .eq("status", "attempted")
      .select("user_id")
      .maybeSingle();
    if (error) {
      throw new Error(`Schedule delivery update failed: ${error.message}`);
    }
    if (!data) {
      throw new Error(
        "Schedule delivery claim was lost before its status update",
      );
    }
  }
}
