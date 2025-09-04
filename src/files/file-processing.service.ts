import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as CryptoJS from 'crypto-js';
import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as child_process from 'child_process';

export interface FileProcessingResult {
  hash: string;
  sha256: string;
  md5: string;
  photoDnaHash?: string; // Placeholder for future PhotoDNA implementation
  size: number;
  mimeType?: string;
  thumbnailPath?: string; // Path to generated thumbnail
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

@Injectable()
export class FileProcessingService {
  async processFile(filePath: string, providedMimeType?: string): Promise<FileProcessingResult> {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const stats = fs.statSync(filePath);

      // Generate various hashes for duplicate detection
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
      
      // Create a combined hash for primary identification
      const combinedHash = crypto.createHash('sha256').update(sha256 + md5).digest('hex');

      // Detect MIME type (prefer provided)
      const mimeType = providedMimeType || this.detectMimeType(filePath);

      // Probe dimensions for videos and images
      let width: number | undefined;
      let height: number | undefined;
      let hasAudio: boolean | undefined;
      try {
        const dim = this.probeDimensions(filePath, mimeType);
        width = dim?.width;
        height = dim?.height;
      } catch {}

      try {
        if (mimeType?.startsWith('video/')) {
          hasAudio = this.probeHasAudio(filePath);
        } else {
          hasAudio = false;
        }
      } catch {}

      // Generate thumbnail for videos and GIFs
      let thumbnailPath: string | undefined;
      try {
        if (mimeType?.startsWith('video/')) {
          thumbnailPath = await this.generateVideoThumbnail(filePath);
        } else if (mimeType === 'image/gif') {
          thumbnailPath = await this.generateGifPreview(filePath);
        }
      } catch (thumbErr) {
        console.warn('Thumbnail generation failed:', (thumbErr as any)?.message || thumbErr);
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
        width,
        height,
        hasAudio,
      };
    } catch (error) {
      console.error('Error processing file:', error);
      throw new Error(`Failed to process file: ${error.message}`);
    }
  }

  async transcodeToMp4(inputPath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      try {
        const tempDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const outPath = path.join(tempDir, `mp4_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
        ffmpeg(inputPath)
          .outputOptions([
            '-y',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-c:a', 'aac',
            '-b:a', '128k',
          ])
          .on('end', () => {
            if (fs.existsSync(outPath)) resolve(outPath);
            else reject(new Error('MP4 file not created'));
          })
          .on('error', (err: any) => reject(err))
          .save(outPath);
      } catch (e) {
        reject(e);
      }
    });
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
    const byExt = mimeTypes[ext];
    if (byExt) return byExt;

    // Fallback: use ffprobe to detect container/codec
    try {
      const out = child_process.execSync(
        `ffprobe -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { encoding: 'utf8' }
      ).trim();
      const format = out.toLowerCase();
      if (format.includes('gif')) return 'image/gif';
      if (format.includes('webm')) return 'video/webm';
      if (format.includes('matroska')) return 'video/webm';
      if (format.includes('mp4') || format.includes('mov') || format.includes('m4a') || format.includes('3gp') || format.includes('mj2') || format.includes('quicktime')) return 'video/mp4';
      if (format.includes('avi')) return 'video/x-msvideo';
    } catch {}

    return 'application/octet-stream';
  }

  private probeDimensions(filePath: string, mimeType?: string): { width: number; height: number } | undefined {
    try {
      const out = child_process.execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${filePath}"`,
        { encoding: 'utf8' }
      ).trim();
      if (!out) return undefined;
      const [wStr, hStr] = out.split('x');
      const w = parseInt(wStr, 10);
      const h = parseInt(hStr, 10);
      if (isFinite(w) && isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
    } catch {}
    return undefined;
  }

  private probeHasAudio(filePath: string): boolean {
    try {
      // Count audio streams; if at least one, we consider it has audio
      const out = child_process.execSync(
        `ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${filePath}"`,
        { encoding: 'utf8' }
      ).trim();
      if (!out) return false;
      // Any numeric index indicates at least one audio stream
      return /\d/.test(out);
    } catch {
      return false;
    }
  }

  async generateVideoThumbnail(videoPath: string): Promise<string> {
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

  async generateGifPreview(gifPath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      try {
        const tempDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const previewFileName = `gif_preview_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
        const previewPath = path.join(tempDir, previewFileName);

        console.log(`Generating GIF preview for ${gifPath} -> ${previewPath}`);

        ffmpeg(gifPath)
          .frames(1)
          .outputOptions([
            '-y',
            // Use first good frame and preserve aspect: scale width to 640, compute height (-1)
            '-vf', 'thumbnail,scale=640:-1:flags=lanczos'
          ])
          .output(previewPath)
          .on('end', () => {
            console.log(`GIF preview generated successfully: ${previewPath}`);
            resolve(previewPath);
          })
          .on('error', (err: any) => {
            console.error('Error generating GIF preview:', err);
            reject(new Error(`Failed to generate GIF preview: ${err.message}`));
          })
          .run();
      } catch (e: any) {
        reject(e);
      }
    });
  }

  generateThumbnail(filePath: string, outputPath: string): Promise<void> {
    // Legacy method - kept for compatibility
    return this.generateVideoThumbnail(filePath).then(() => {});
  }
}
