import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { S3Service } from './s3.service';
import { FileProcessingService } from './file-processing.service';
import { FileEntity } from './entities/file.entity';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

export interface FileRecord {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  thumbnailUrl?: string;
  sourceUrl?: string;
  tags?: string[];
  hash: string;
  uploadedAt: string;
}

@Injectable()
export class FilesService {
  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly s3Service: S3Service,
    private readonly fileProcessingService: FileProcessingService,
  ) {}

  async uploadFile(file: Express.Multer.File, sourceUrl?: string, tags?: string[]): Promise<FileRecord> {
    const fileId = uuidv4();
    const fileExtension = path.extname(file.originalname);
    const filename = `${fileId}${fileExtension}`;

    // Process the file to get hash and other metadata
    const processing = await this.fileProcessingService.processFile(file.path);
    const uploadContentType = processing.mimeType || file.mimetype || 'application/octet-stream';

    // Check for duplicates
    const existingFile = await this.fileRepository.findOne({
      where: { hash: processing.hash }
    });
    if (existingFile) {
      // Clean up the uploaded file since we have a duplicate
      fs.unlinkSync(file.path);
      // Generate fresh signed URL for existing file
      const freshUrl = await this.s3Service.getSignedUrl(existingFile.filename, 3600);
      
      // If a sourceUrl was provided and the existing file doesn't have one, update it
      if (sourceUrl && !existingFile.sourceUrl) {
        await this.fileRepository.update(existingFile.id, { sourceUrl });
        existingFile.sourceUrl = sourceUrl;
      }
      
      return {
        ...existingFile,
        url: freshUrl,
        uploadedAt: existingFile.uploadedAt.toISOString(),
      };
    }

    // Upload to S3
    const s3Url = await this.s3Service.uploadFile(file.path, filename, uploadContentType);

    // Upload thumbnail to S3 if generated
    let thumbnailUrl: string | undefined;
    if (processing.thumbnailPath && fs.existsSync(processing.thumbnailPath)) {
      try {
        const thumbnailFilename = `thumbnails/${fileId}.jpg`;
        thumbnailUrl = await this.s3Service.uploadFile(processing.thumbnailPath, thumbnailFilename, 'image/jpeg');
      } finally {
        try {
          fs.unlinkSync(processing.thumbnailPath);
        } catch {}
      }
    }

    // Create and save file entity
    const fileEntity = this.fileRepository.create({
      id: fileId,
      filename,
      originalName: file.originalname,
      mimeType: uploadContentType,
      size: file.size,
      url: s3Url,
      thumbnailUrl,
      sourceUrl,
      tags,
      hash: processing.hash,
    });

    const savedFile = await this.fileRepository.save(fileEntity);

    // Clean up local file
    fs.unlinkSync(file.path);

    return {
      ...savedFile,
      uploadedAt: savedFile.uploadedAt.toISOString(),
    };
  }

  async uploadFromUrl(url: string, tags?: string[]): Promise<FileRecord> {
    try {
      // Resolve the actual media URL (handles Reddit, Imgur, etc.)
      const mediaUrl = await this.resolveMediaUrl(url);
      
      // Download the file
      const response = await axios({
        method: 'GET',
        url: mediaUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const fileId = uuidv4();
      const contentType = response.headers['content-type'] || 'application/octet-stream';
      const urlExt = path.extname(new URL(mediaUrl).pathname);
      const headerExt = this.getExtensionFromMimeType(contentType);
      const fileExtension = headerExt || urlExt || '.bin';
      const tempFilePath = path.join(tempDir, `${fileId}${fileExtension}`);

      // Save the file locally first
      const writer = fs.createWriteStream(tempFilePath);
      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });

      // Get file stats
      const stats = fs.statSync(tempFilePath);
      const originalName = path.basename(new URL(mediaUrl).pathname) || `download${fileExtension}`;

      // Create a mock Multer file object
      let effectiveMimeType = contentType;
      if (!headerExt && urlExt) {
        effectiveMimeType = this.getMimeTypeFromExtension(urlExt) || contentType;
      }
      const mockFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: originalName,
        encoding: '7bit',
        mimetype: effectiveMimeType,
        size: stats.size,
        destination: tempDir,
        filename: `${fileId}${fileExtension}`,
        path: tempFilePath,
        buffer: Buffer.alloc(0),
        stream: null as any,
      };

      // Process using the existing upload logic, passing the source URL and tags
      return await this.uploadFile(mockFile, url, tags);
    } catch (error) {
      throw new Error(`Failed to download file from URL: ${error.message}`);
    }
  }

  async getAllFiles(): Promise<FileRecord[]> {
    const files = await this.fileRepository.find({
      order: { uploadedAt: 'DESC' }
    });
    
    // Generate fresh signed URLs for all files
    const filesWithFreshUrls = await Promise.all(files.map(async (file) => {
      const url = await this.s3Service.getSignedUrl(file.filename, 3600);
      
      let thumbnailUrl = file.thumbnailUrl;
      if (file.thumbnailUrl) {
        const thumbnailKey = `thumbnails/${file.id}.jpg`;
        thumbnailUrl = await this.s3Service.getSignedUrl(thumbnailKey, 3600);
      }
      
      return {
        ...file,
        url,
        thumbnailUrl,
        uploadedAt: file.uploadedAt.toISOString(),
      };
    }));
    
    return filesWithFreshUrls;
  }



  async getFileById(id: string): Promise<FileRecord | null> {
    const file = await this.fileRepository.findOne({
      where: { id }
    });
    
    if (!file) return null;
    
    const url = await this.s3Service.getSignedUrl(file.filename, 3600);
    
    let thumbnailUrl = file.thumbnailUrl;
    if (file.thumbnailUrl) {
      const thumbnailKey = `thumbnails/${file.id}.jpg`;
      thumbnailUrl = await this.s3Service.getSignedUrl(thumbnailKey, 3600);
    }
    
    return {
      ...file,
      url,
      thumbnailUrl,
      uploadedAt: file.uploadedAt.toISOString(),
    };
  }

  async refreshFileUrl(id: string): Promise<string> {
    const file = await this.fileRepository.findOne({
      where: { id }
    });
    
    if (!file) {
      throw new Error('File not found');
    }

    // Generate new signed URL
    const newUrl = await this.s3Service.refreshSignedUrl(file.filename, 3600); // 1 hour expiration
    
    // Update the file record with new URL
    await this.fileRepository.update(id, { url: newUrl });

    return newUrl;
  }

  async deleteFile(id: string): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id }
    });
    
    if (!file) {
      throw new Error('File not found');
    }

    // Delete from S3
    await this.s3Service.deleteFile(file.filename);

    // Remove from database
    await this.fileRepository.delete(id);
  }



  private async resolveMediaUrl(url: string): Promise<string> {
    // Handle Imgur URLs (convert gallery URLs to direct media)
    if (url.includes('imgur.com') && !url.endsWith('.gif') && !url.endsWith('.mp4')) {
      return await this.resolveImgurUrl(url);
    }
    
    // Return original URL if no special handling needed
    return url;
  }



  private async resolveImgurUrl(url: string): Promise<string> {
    try {
      // Convert Imgur URL to direct image URL
      const imgurId = url.split('/').pop()?.split('.')[0];
      if (!imgurId) {
        throw new Error('Could not extract Imgur ID');
      }
      
      // Try common Imgur formats
      const formats = ['.gif', '.mp4', '.jpg', '.png'];
      for (const format of formats) {
        const directUrl = `https://i.imgur.com/${imgurId}${format}`;
        try {
          const response = await axios.head(directUrl);
          if (response.status === 200) {
            return directUrl;
          }
        } catch {
          // Continue to next format
        }
      }
      
      throw new Error('Could not find valid Imgur media format');
    } catch (error) {
      console.error('Error resolving Imgur URL:', error);
      throw new Error(`Failed to resolve Imgur URL: ${error.message}`);
    }
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const mimeToExt: { [key: string]: string } = {
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/quicktime': '.mov',
      'video/x-msvideo': '.avi',
      'image/gif': '.gif',
      'image/jpeg': '.jpg',
      'image/png': '.png',
    };
    return mimeToExt[mimeType] || '';
  }

  private getMimeTypeFromExtension(ext: string): string | undefined {
    const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
    const extToMime: { [key: string]: string } = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.gif': 'image/gif',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
    };
    return extToMime[normalized];
  }
}
