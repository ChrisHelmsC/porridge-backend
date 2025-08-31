import { Controller, Get, Patch, Param, UseGuards, Request } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(@Request() req: any) {
    return this.notifications.listForUser(req.user.userId);
  }

  @Patch(':id/read')
  async markRead(@Param('id') id: string, @Request() req: any) {
    await this.notifications.markRead(req.user.userId, id);
    return { message: 'Notification marked read' };
  }

  @Patch('read-all')
  async markAll(@Request() req: any) {
    await this.notifications.markAllRead(req.user.userId);
    return { message: 'All notifications marked read' };
  }
}

