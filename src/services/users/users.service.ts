import { UserRoles } from "@/data/users/user.data";
import { userRepository } from "@/repositories/user/user.repository";
import { ErrorData, StatusCodes } from "@/types/error";
import { createJwtToken } from "@/utils/auth/auth-utils";

/** Strips sensitive fields and normalizes the user id for API responses. */
const publicUser = (user: {
  _id?: { toString(): string } | string;
  email: string;
  role: UserRoles;
}) => ({
  _id: user._id?.toString?.() ?? user._id,
  email: user.email,
  role: user.role,
});

/**
 * Authentication and current-user business logic.
 */
export class UsersService {
  /**
   * Creates an account and returns a JWT plus public user fields.
   */
  async signup(input: { email: string; password: string }) {
    try {
      const user = await userRepository.createUser({
        email: input.email.trim().toLowerCase(),
        password: input.password,
        role: UserRoles.USER,
      });
      const publicFields = publicUser(user);
      const accessToken = createJwtToken({
        _id: publicFields._id as string,
        email: publicFields.email,
        role: publicFields.role,
      });
      return { accessToken, user: publicFields };
    } catch (error: unknown) {
      const mongoError = error as { code?: number };
      if (mongoError.code === 11000) {
        throw new ErrorData(
          "An account with this email already exists",
          "user",
          error,
          StatusCodes.CONFLICT,
          false
        );
      }
      throw error;
    }
  }

  /**
   * Authenticates email and password and returns a JWT plus public user fields.
   */
  async login(input: { email: string; password: string }) {
    const user = await userRepository.findByEmailWithPassword(
      input.email.trim().toLowerCase()
    );
    if (!user) {
      throw new ErrorData(
        "Invalid email or password",
        "auth",
        new Error("Unknown email"),
        StatusCodes.UNAUTHORIZED,
        false
      );
    }

    const isMatch = await userRepository.comparePassword(
      input.password,
      user.password
    );
    if (!isMatch) {
      throw new ErrorData(
        "Invalid email or password",
        "auth",
        new Error("Wrong password"),
        StatusCodes.UNAUTHORIZED,
        false
      );
    }

    const publicFields = publicUser(user);
    const accessToken = createJwtToken({
      _id: publicFields._id as string,
      email: publicFields.email,
      role: publicFields.role,
    });
    return { accessToken, user: publicFields };
  }

  /**
   * Returns the authenticated user's public fields.
   */
  async me(userId: string) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new ErrorData(
        "Unauthorized",
        "auth",
        new Error("User not found"),
        StatusCodes.UNAUTHORIZED,
        false
      );
    }
    return publicUser(user);
  }
}

export const usersService = new UsersService();
