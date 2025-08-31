import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationEntity } from './entities/notification.entity';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(NotificationEntity)
    private readonly repo: Repository<NotificationEntity>,
  ) {}

  private buildPrefixedMessage(message: string, metadata?: any): string {
    try {
      const fileName: string | undefined = metadata?.fileName || metadata?.originalName;
      const sourceUrl: string | undefined = metadata?.sourceUrl;
      const fileId: string | undefined = metadata?.fileId;
      const context = fileName || sourceUrl || fileId;
      if (context) return `[${context}] ${message}`;
      return message;
    } catch {
      return message;
    }
  }

  async create(userId: string, message: string, metadata?: any): Promise<NotificationEntity> {
    const prefixed = this.buildPrefixedMessage(message, metadata);
    const entity = this.repo.create({ userId, message: prefixed, metadata: metadata ?? null, read: false });
    return this.repo.save(entity);
  }

  async listForUser(userId: string): Promise<NotificationEntity[]> {
    return this.repo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async markRead(userId: string, id: string): Promise<void> {
    const found = await this.repo.findOne({ where: { id, userId } });
    if (!found) return;
    await this.repo.update(id, { read: true });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.repo.createQueryBuilder()
      .update(NotificationEntity)
      .set({ read: true })
      .where('userId = :userId', { userId })
      .execute();
  }
}

