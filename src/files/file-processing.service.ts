import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as CryptoJS from 'crypto-js';
import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';

export interface FileProcessingResult {
  hash: string;
  sha256: string;
  md5: string;
  photoDnaHash?: string; // Placeholder for future PhotoDNA implementation
  size: number;
  mimeType?: string;
  thumbnailPath?: string; // Path to generated thumbnail
}

@Injectable()
export class FileProcessingService {
  async processFile(filePath: string): Promise<FileProcessingResult> {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const stats = fs.statSync(filePath);

      // Generate various hashes for duplicate detection
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
      
      // Create a combined hash for primary identification
      const combinedHash = crypto.createHash('sha256').update(sha256 + md5).digest('hex');

      // Detect MIME type
      const mimeType = this.detectMimeType(filePath);

      // Generate thumbnail for videos and GIFs
      let thumbnailPath: string | undefined;
      if (mimeType?.startsWith('video/')) {
        thumbnailPath = await this.generateVideoThumbnail(filePath);
      } else if (mimeType === 'image/gif') {
        thumbnailPath = await this.generateGifPreview(filePath);
      }

      // TODO: Implement PhotoDNA or similar perceptual hashing for media files
      // This would require additional libraries and possibly external services
      const photoDnaHash = await this.generatePerceptualHash(fileBuffer);

      return {
        hash: combinedHash,
        sha256,
        md5,
        photoDnaHash,
        size: stats.size,
        mimeType,
        thumbnailPath,
      };
    } catch (error) {
      console.error('Error processing file:', error);
      throw new Error(`Failed to process file: ${error.message}`);
    }
  }

  private async generatePerceptualHash(fileBuffer: Buffer): Promise<string> {
    // Placeholder for perceptual hashing implementation
    // In a real implementation, you would use libraries like:
    // - imagehash for images
    // - ffmpeg + imagehash for video thumbnails
    // - PhotoDNA API for Microsoft's PhotoDNA
    
    // For now, we'll create a simple content-based hash
    // This is NOT a perceptual hash but a placeholder
    const contentHash = crypto.createHash('sha1').update(fileBuffer.slice(0, 1024)).digest('hex');
    return `placeholder_${contentHash}`;
  }

  async detectDuplicates(hash: string, existingHashes: string[]): Promise<boolean> {
    // Exact match
    if (existingHashes.includes(hash)) {
      return true;
    }

    // TODO: Implement similarity detection for perceptual hashes
    // This would involve calculating distances between hashes
    // and determining if they're below a certain threshold

    return false;
  }

  async extractMetadata(filePath: string): Promise<any> {
    // Placeholder for metadata extraction
    // In a real implementation, you would use libraries like:
    // - exifr for image metadata
    // - ffprobe for video metadata
    
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      // TODO: Add more metadata extraction based on file type
    };
  }

  private detectMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.gif': 'image/gif',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private async generateVideoThumbnail(videoPath: string): Promise<string> {
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const thumbnailFileName = `thumbnail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
    const thumbnailPath = path.join(tempDir, thumbnailFileName);

    const tryAt = (seconds: number) => {
      return new Promise<void>((resolve, reject) => {
        console.log(`Attempting thumbnail at ${seconds}s for ${videoPath}`);
        ffmpeg(videoPath)
          .seekInput(seconds)
          .frames(1)
          .outputOptions([
            '-y',
            '-vf', 'thumbnail,scale=640:-1:flags=lanczos'
          ])
          .output(thumbnailPath)
          .on('end', () => {
            if (fs.existsSync(thumbnailPath)) {
              resolve();
            } else {
              reject(new Error('Thumbnail file not created'));
            }
          })
          .on('error', (err: any) => {
            reject(err);
          })
          .run();
      });
    };

    // Try common offsets to avoid black/empty first frames
    const candidates = [1, 0.5, 0];
    for (const t of candidates) {
      try {
        await tryAt(t);
        console.log(`Thumbnail generated successfully: ${thumbnailPath}`);
        return thumbnailPath;
      } catch (err) {
        console.warn(`Thumbnail attempt at ${t}s failed:`, err?.message || err);
      }
    }

    throw new Error('Failed to generate video thumbnail after multiple attempts');
  }

  private async generateGifPreview(gifPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const previewFileName = `gif_preview_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
      const previewPath = path.join(tempDir, previewFileName);

      console.log(`Generating GIF preview for ${gifPath} -> ${previewPath}`);

      const command = ffmpeg(gifPath);
      command
        .screenshots({
          timestamps: ['0'], // Take screenshot at the very beginning (first frame)
          filename: previewFileName,
          folder: tempDir,
          size: '640x480' // Good quality for GIF previews
        })
        .on('end', () => {
          console.log(`GIF preview generated successfully: ${previewPath}`);
          resolve(previewPath);
        })
        .on('error', (err: any) => {
          console.error('Error generating GIF preview:', err);
          reject(new Error(`Failed to generate GIF preview: ${err.message}`));
        });
    });
  }

  generateThumbnail(filePath: string, outputPath: string): Promise<void> {
    // Legacy method - kept for compatibility
    return this.generateVideoThumbnail(filePath).then(() => {});
  }
}
