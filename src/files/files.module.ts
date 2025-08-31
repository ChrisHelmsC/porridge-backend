import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesController, AdminController } from './files.controller';
import { FilesService } from './files.service';
import { S3Service } from './s3.service';
import { FileProcessingService } from './file-processing.service';
import { FileEntity } from './entities/file.entity';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FingerprintClient } from './fingerprint.client';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([FileEntity]),
    UsersModule,
    NotificationsModule,
    MulterModule.register({
      dest: './uploads',
      limits: {
        fileSize: 100 * 1024 * 1024,
      },
    }),
  ],
  controllers: [FilesController, AdminController],
  providers: [
    FilesService,
    S3Service,
    FileProcessingService,
    {
      provide: FingerprintClient,
      useFactory: (config: ConfigService) => new FingerprintClient(config.get<string>('FINGERPRINT_SERVICE_URL') || 'http://localhost:8001'),
      inject: [ConfigService],
    },
  ],
})
export class FilesModule {}
