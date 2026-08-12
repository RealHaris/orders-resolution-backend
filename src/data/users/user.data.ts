/** Authenticated role for this product. */
export enum UserRoles {
  USER = "User",
}

/** User document shape. Password is never returned from APIs. */
export class User {
  _id?: string;
  email: string;
  password: string;
  role: UserRoles;
  createdAt: Date;
  updatedAt: Date;
}
