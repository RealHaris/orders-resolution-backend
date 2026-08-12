import type { User } from "@/data/users/user.data";

export declare global {
  namespace Express {
    export interface Request {
      payload?: {
        user: Pick<User, "_id" | "email" | "role">;
        iat?: number;
        exp?: number;
      };
      reqId?: string;
    }
  }
}
