import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SessionGuard } from '../auth/session.guard';

@Global()
@Module({
  providers: [AuditService, MessagingService, NotificationsService, SessionGuard],
  exports: [AuditService, MessagingService, NotificationsService, SessionGuard],
})
export class CommonModule {}
