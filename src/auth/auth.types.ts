/** Claims carried by the signed access token (HS256, JWT_SECRET) */
export interface JwtPayload {
  userId: string;
  sessionId: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

/** Claims carried by the signed refresh token (HS256, JWT_REFRESH_SECRET) */
export interface RefreshTokenPayload {
  userId: string;
  sessionId?: string;
  iat?: number;
  jti?: string;
  exp?: number;
}

/** Minimal user data required to sign a token pair */
export interface TokenSubject {
  id: string;
  email: string;
  role: string;
}

/** Shape of the token pair issued at login/refresh (top-level in the response body) */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

/** Identity attached to the request by the global JwtAuthGuard */
export interface AuthUserPayload {
  userId: string;
  sessionId: string;
  email: string;
  role: string;
}
