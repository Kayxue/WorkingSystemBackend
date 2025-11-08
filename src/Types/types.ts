import type { Session } from "hono-sessions";

export enum Role {
  WORKER = "worker",
  EMPLOYER = "employer",
  ADMIN = "admin",
}

export type sessionUser = {
  id: string;
  role: Role;
};

export type HonoGenericContext = {
  Variables: { session: Session<sessionUser>; session_key_rotation: boolean; user: any & { role: Role }; uploadedFiles: Record<string, any>; server: Bun.Server };
};
