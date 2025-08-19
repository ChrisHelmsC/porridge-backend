import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilesService } from './files.service';
import { UploadUrlDto } from './dto/upload-url.dto';

@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File, @Body() body: { tags?: string }) {
    if (!file) {
      throw new HttpException('No file provided', HttpStatus.BAD_REQUEST);
    }

    try {
      // Parse comma-separated tags if provided
      const tags = body.tags ? body.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : undefined;
      const result = await this.filesService.uploadFile(file, undefined, tags);
      return {
        message: 'File uploaded successfully',
        file: result,
      };
    } catch (error) {
      throw new HttpException(
        'Failed to upload file',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('upload-url')
  async uploadFromUrl(@Body() body: { url: string; tags?: string }) {
    try {
      // Parse comma-separated tags if provided
      const tags = body.tags ? body.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : undefined;
      const result = await this.filesService.uploadFromUrl(body.url, tags);
      return {
        message: 'File downloaded and uploaded successfully',
        file: result,
      };
    } catch (error) {
      throw new HttpException(
        'Failed to download and upload file from URL',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get()
  async getAllFiles() {
    try {
      return await this.filesService.getAllFiles();
    } catch (error) {
      throw new HttpException(
        'Failed to retrieve files',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }



  @Get(':id')
  async getFile(@Param('id') id: string) {
    try {
      const file = await this.filesService.getFileById(id);
      if (!file) {
        throw new HttpException('File not found', HttpStatus.NOT_FOUND);
      }
      return file;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to retrieve file',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post(':id/refresh-url')
  async refreshFileUrl(@Param('id') id: string) {
    try {
      const newUrl = await this.filesService.refreshFileUrl(id);
      return {
        message: 'File URL refreshed successfully',
        url: newUrl,
      };
    } catch (error) {
      throw new HttpException(
        'Failed to refresh file URL',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':id')
  async deleteFile(@Param('id') id: string) {
    try {
      await this.filesService.deleteFile(id);
      return {
        message: 'File deleted successfully',
      };
    } catch (error) {
      throw new HttpException(
        'Failed to delete file',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
