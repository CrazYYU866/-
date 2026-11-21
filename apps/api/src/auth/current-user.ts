import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ClientApp } from '@kovsh/contracts';

export interface AuthUser {
  userId: string;
  sessionId: string;
  app: ClientApp;
}

export type AuthedRequest = { user?: AuthUser };

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new Error('CurrentUser используется без JwtAuthGuard');
  return user;
});
