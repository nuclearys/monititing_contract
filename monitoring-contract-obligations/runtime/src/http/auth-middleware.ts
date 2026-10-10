import type { IncomingMessage } from 'node:http';

type AuthService = Readonly<{
  userIdFromRequest(request: IncomingMessage): Promise<string | null>;
}>;

export function createAuthMiddleware(auth: AuthService) {
  return {
    userId(request: IncomingMessage): Promise<string | null> {
      return auth.userIdFromRequest(request);
    },
  };
}
