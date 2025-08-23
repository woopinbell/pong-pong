import type { PublicUser, SessionUser } from "@pong-pong/shared";
import type { UserProjectionRow } from "./schema";

export function toPublicUser(row: UserProjectionRow, online = false): PublicUser {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
    role: row.role,
    status: row.status,
    rating: Number(row.rating),
    wins: Number(row.wins),
    losses: Number(row.losses),
    online
  };
}

export function toSessionUser(row: UserProjectionRow, online = false): SessionUser {
  return { ...toPublicUser(row, online), email: row.email };
}
