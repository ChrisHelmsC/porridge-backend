import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { S3Service } from './s3.service';
import { FileProcessingService } from './file-processing.service';
import { FileEntity } from './entities/file.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([FileEntity]),
    MulterModule.register({
      dest: './uploads',
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB limit
      },
    }),
  ],
  controllers: [FilesController],
  providers: [FilesService, S3Service, FileProcessingService],
})
export class FilesModule {}
