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
	UseGuards,
	Request,
	Patch,
	Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilesService } from './files.service';
import { UploadUrlDto } from './dto/upload-url.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';

@Controller('files')
@UseGuards(JwtAuthGuard)
export class FilesController {
	constructor(private readonly filesService: FilesService) {}

	@Post('upload')
	@UseInterceptors(FileInterceptor('file'))
	async uploadFile(@UploadedFile() file: Express.Multer.File, @Body() body: { tags?: string }, @Request() req: any) {
		if (!file) {
			throw new HttpException('No file provided', HttpStatus.BAD_REQUEST);
		}

		try {
			// Parse comma-separated tags if provided
			const tags = body.tags ? body.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : undefined;
			const result = await this.filesService.uploadFile(file, req.user.userId, undefined, tags);
			return {
				message: 'File uploaded successfully',
				...result,
			};
		} catch (error) {
			if (error instanceof HttpException) { throw error; }
			throw new HttpException('Failed to upload file', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	@Post('upload-url')
	async uploadFromUrl(@Body() body: { url: string; tags?: string }, @Request() req: any) {
		try {
			// Parse comma-separated tags if provided
			const tags = body.tags ? body.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : undefined;
			const result = await this.filesService.uploadFromUrl(body.url, req.user.userId, tags);
			return {
				message: 'File downloaded and uploaded successfully',
				...result,
			};
		} catch (error) {
			if (error instanceof HttpException) { throw error; }
			throw new HttpException('Failed to download and upload file from URL', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	// New: start ingest job with progress for URL
	@Post('ingest-url')
	async ingestUrl(@Body() body: { url: string; tags?: string }, @Request() req: any) {
		if (!body?.url) throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
		try {
			const tags = body.tags ? body.tags.split(',').map(tag => tag.trim()).filter(Boolean) : undefined;
			const job = await this.filesService.startIngestJob(body.url, req.user.userId, tags);
			return job; // { jobId }
		} catch (e) {
			throw new HttpException('Failed to start ingest job', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	@Post('retry-ingest')
	async retryIngest(@Body() body: { url: string; tags?: string }, @Request() req: any) {
		if (!body?.url) throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
		try {
			const tags = body.tags ? body.tags.split(',').map(tag => tag.trim()).filter(Boolean) : undefined;
			const job = await this.filesService.startIngestJob(body.url, req.user.userId, tags);
			return job; // { jobId }
		} catch (e) {
			throw new HttpException('Failed to retry ingest job', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	@Get('ingest/:jobId')
	async getIngest(@Param('jobId') jobId: string, @Request() req: any) {
		try {
			return await this.filesService.getIngestStatus(jobId, req.user.userId);
		} catch (e) {
			throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
		}
	}

	@Get()
	async getAllFiles(@Request() req: any) {
		try {
			return await this.filesService.getAllFiles(req.user.userId);
		} catch (error) {
			throw new HttpException(
				'Failed to retrieve files',
				HttpStatus.INTERNAL_SERVER_ERROR,
			);
		}
	}

	@Get(':id')
	async getFile(@Param('id') id: string, @Request() req: any) {
		try {
			const file = await this.filesService.getFileById(id, req.user.userId);
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

	@Get(':id/download')
	async downloadFile(@Param('id') id: string, @Request() req: any, @Res() res: any) {
		try {
			const f = await this.filesService.getFileEntity(id, req.user.userId);
			if (!f) throw new HttpException('File not found', HttpStatus.NOT_FOUND);
			const key = f.filename;
			const streamInfo = await this.filesService.getObjectStream(key);
			res.setHeader('Content-Disposition', `attachment; filename="${f.originalName || 'download'}"`);
			// Force generic content type to avoid inline viewers
			res.setHeader('Content-Type', 'application/octet-stream');
			if (typeof streamInfo.contentLength === 'number') res.setHeader('Content-Length', String(streamInfo.contentLength));
			(streamInfo.body as any).pipe(res);
		} catch (e) {
			throw new HttpException('Failed to download file', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	@Post(':id/refresh-url')
	async refreshFileUrl(@Param('id') id: string, @Request() req: any) {
		try {
			const newUrl = await this.filesService.refreshFileUrl(id, req.user.userId);
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

	@Patch(':id/tags')
	async updateTags(@Param('id') id: string, @Body() body: { tags: string[] }, @Request() req: any) {
		if (!Array.isArray(body.tags)) {
			throw new HttpException('tags must be an array of strings', HttpStatus.BAD_REQUEST);
		}
		try {
			const updated = await this.filesService.updateTags(id, req.user.userId, body.tags);
			return { message: 'Tags updated', file: updated };
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw new HttpException('Failed to update tags', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	@Patch(':id/title')
	async updateTitle(@Param('id') id: string, @Body() body: { title?: string | null }, @Request() req: any) {
		try {
			const updated = await this.filesService.updateTitle(id, req.user.userId, body?.title ?? null);
			return { message: 'Title updated', file: updated };
		} catch (error) {
			throw new HttpException('Failed to update title', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	@Delete(':id')
	async deleteFile(@Param('id') id: string, @Request() req: any) {
		try {
			await this.filesService.deleteFile(id, req.user.userId);
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

@Controller('admin')
export class AdminController {
  constructor(private readonly filesService: FilesService) {}

  // Authenticationless backfill endpoint: POST /admin/backfill-dimensions
  @Post('backfill-dimensions')
  async backfillDimensions() {
    const { processed, updated, errors } = await this.filesService.backfillMissingDimensions();
    return { message: 'Backfill complete', processed, updated, errors };
  }
}
