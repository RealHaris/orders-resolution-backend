import bcrypt from "bcrypt";

import type { User } from "@/data/users/user.data";
import { type IUserDocument, UserModel } from "@/models/users/user.model";

/**
 * Repository for User collection operations.
 */
export class UserRepository {
  /**
   * Hashes the password and inserts a new user.
   */
  async createUser(input: {
    email: string;
    password: string;
    role: User["role"];
  }): Promise<IUserDocument> {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(input.password, salt);
    const user = new UserModel({
      email: input.email,
      password: hash,
      role: input.role,
    });
    return await user.save();
  }

  /**
   * Finds a user by email including the password hash.
   */
  async findByEmailWithPassword(email: string): Promise<IUserDocument | null> {
    return UserModel.findOne({ email: email.toLowerCase() }).select(
      "+password"
    );
  }

  /**
   * Finds a user by id without the password hash.
   */
  async findById(id: string): Promise<User | null> {
    return UserModel.findById(id).lean<User | null>();
  }

  /**
   * Compares a candidate password with a bcrypt hash.
   */
  comparePassword(candidatePassword: string, hash: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      bcrypt.compare(candidatePassword, hash, (error, isMatch) => {
        if (error) return reject(error);
        resolve(isMatch);
      });
    });
  }
}

export const userRepository = new UserRepository();
