import "server-only";

import { headers } from "next/headers";

import { getAuth } from "@/lib/auth/server";
import { bus } from "@/events/bus";
import { ok, workflow } from "../shared";

export const signoutWorkflow = workflow<[{ userId: string }], void>(
  "auth.signout",
  async ({ userId }) => {
    const auth = await getAuth();
    await auth.api.signOut({ headers: await headers() });
    await bus.emit("user.signed_out", { userId }, { actorUserId: userId });
    return ok();
  },
);
