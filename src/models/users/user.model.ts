import { type HydratedDocument, model, Schema } from "mongoose";

import { type User, UserRoles } from "@/data/users/user.data";

export type IUserDocument = HydratedDocument<User>;

/** Normalizes email addresses to lowercase before persistence. */
const toLower = (value: string) => value.toLowerCase();

const userSchema = new Schema<User>(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      set: toLower,
      trim: true,
    },
    password: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: Object.values(UserRoles),
      required: true,
      default: UserRoles.USER,
    },
  },
  { timestamps: true }
);

export const UserModel = model<User>("User", userSchema);
