/** Auth contracts shared with the server's auth module (`PublicUser` shape). */

export type PublicUserStatus = 'active' | 'invited' | 'suspended';

/** The only user shape the API ever returns (see server auth.types.ts). */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  status: string;
  emailVerified: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshInCookie: boolean;
}

export interface AuthSessionPayload {
  user: PublicUser;
  tokens: AuthTokens;
}

export type SessionStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous' | 'error';
