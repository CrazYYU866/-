import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import type { AuthUser } from '../auth/current-user';
import { AppException } from '../common/app-exception';

export function assertPartnerApp(user: AuthUser): void {
  if (user.app !== 'partner') {
    throw new AppException(ERROR_CODES.FORBIDDEN, 'Доступно только в приложении партнёра', HttpStatus.FORBIDDEN);
  }
}
