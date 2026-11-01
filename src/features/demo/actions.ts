"use server";

import { z } from "zod";
import { getDb } from "@/db/client";
import { env } from "@/lib/env";
import { ActionError, adminAction } from "@/lib/actions";
import { switchDemoMarket } from "./reset";

/** 16 §2 "Switch demo market" (demo builds only): reseed with the other preset. */
export const switchDemoMarketAction = adminAction(
  z.object({}).strict(),
  { write: true },
  async (_input, ctx) => {
    if (!env().DEMO_MODE) throw new ActionError("This is not a demo build.", "FORBIDDEN");
    return switchDemoMarket(await getDb(), ctx.actor);
  },
);
