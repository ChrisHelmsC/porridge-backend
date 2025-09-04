import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { S3Service } from './s3.service';
import { FileProcessingService } from './file-processing.service';
import { FileEntity } from './entities/file.entity';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { FingerprintClient } from './fingerprint.client';
import { NotificationsService } from '../notifications/notifications.service';
import * as crypto from 'crypto';

export interface FileRecord {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  mp4Url?: string;
  thumbnailUrl?: string;
  sourceUrl?: string;
	title?: string | null;
  tags?: string[];
  hash: string;
  uploadedAt: string;
  width?: number;
  height?: number;
}

interface PotentialMatch { id: string; sourceUrl?: string; reason: 'audio' | 'longer'; }

@Injectable()
export class FilesService {
  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly s3Service: S3Service,
    private readonly fileProcessingService: FileProcessingService,
		private readonly remoteFingerprint: FingerprintClient,
		private readonly notificationsService: NotificationsService,
	) {}

  // Simple per-host concurrency limiter to avoid hammering domains like 4cdn
  private hostLimits: Map<string, { active: number; queue: Array<() => void>; limit: number }> = new Map();

  private async withHostLimit<T>(hostname: string, limit: number, task: () => Promise<T>): Promise<T> {
    let entry = this.hostLimits.get(hostname);
    if (!entry) {
      entry = { active: 0, queue: [], limit };
      this.hostLimits.set(hostname, entry);
    } else {
      entry.limit = limit; // allow dynamic adjustment per call
    }

    const acquire = async () => {
      if (entry!.active < entry!.limit) {
        entry!.active++;
        return;
      }
      await new Promise<void>((resolve) => entry!.queue.push(() => { entry!.active++; resolve(); }));
    };

    const release = () => {
      entry!.active = Math.max(0, entry!.active - 1);
      const next = entry!.queue.shift();
      if (next) next();
    };

    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  private buildPoliteHeaders(rawUrl: string): Record<string, string> {
    try {
      const u = new URL(rawUrl);
      const ext = path.extname(u.pathname).toLowerCase();
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      };
      // Accept heuristics
      if (ext === '.webm') headers['Accept'] = 'video/webm,video/*;q=0.9,*/*;q=0.8';
      else if (ext === '.mp4' || ext === '.mov') headers['Accept'] = 'video/mp4,video/*;q=0.9,*/*;q=0.8';
      else if (ext === '.gif') headers['Accept'] = 'image/gif,image/*;q=0.9,*/*;q=0.8';
      else if (ext === '.jpg' || ext === '.jpeg') headers['Accept'] = 'image/jpeg,image/*;q=0.9,*/*;q=0.8';
      else if (ext === '.png') headers['Accept'] = 'image/png,image/*;q=0.9,*/*;q=0.8';
      else headers['Accept'] = '*/*';

      // Referer for known hosts that enforce it
      if (u.hostname === 'i.4cdn.org' || u.hostname.endsWith('4cdn.org')) {
        // path like /gif/<file> → board is first segment
        const seg = u.pathname.split('/').filter(Boolean)[0] || '';
        headers['Referer'] = seg ? `https://boards.4chan.org/${seg}/` : 'https://boards.4chan.org/';
        headers['Origin'] = 'https://boards.4chan.org';
        headers['Accept-Language'] = 'en-US,en;q=0.9';
      } else if (u.hostname.endsWith('redgifs.com')) {
        headers['Referer'] = 'https://www.redgifs.com/';
      } else if (u.hostname.endsWith('imgur.com')) {
        headers['Referer'] = 'https://imgur.com/';
      }
      return headers;
    } catch {
      return { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
    }
  }

  private async sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

  private async fetchStreamWithBackoff(url: string, headers: Record<string, string> = {}, maxRetries = 3) {
    let lastErr: any;
    let hostname = 'unknown';
    try { hostname = new URL(url).hostname; } catch {}
    const hostLimit = hostname.endsWith('4cdn.org') ? 1 : 4;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await this.withHostLimit(hostname, hostLimit, async () => {
          return await axios({ method: 'GET', url, responseType: 'stream', headers, maxRedirects: 3, timeout: 20000, validateStatus: (s) => s < 500 || s === 429 });
        });
        if (resp.status === 429) {
          const ra = Number(resp.headers?.['retry-after'] || 0);
          const delay = ra > 0 ? ra * 1000 : (1000 << Math.min(attempt, 3)) + Math.floor(Math.random() * 250);
          if (attempt === maxRetries) throw new Error('HTTP 429 Too Many Requests');
          await this.sleep(delay);
          continue;
        }
        if (resp.status >= 200 && resp.status < 300) return resp;
        throw new Error(`Unexpected status ${resp.status}`);
      } catch (e: any) {
        lastErr = e;
        const status = e?.response?.status;
        if (status === 429 && attempt < maxRetries) {
          const ra = Number(e?.response?.headers?.['retry-after'] || 0);
          const delay = ra > 0 ? ra * 1000 : (1000 << Math.min(attempt, 3)) + Math.floor(Math.random() * 250);
          await this.sleep(delay);
          continue;
        }
        if (attempt === maxRetries) break;
        await this.sleep((500 << Math.min(attempt, 3)) + Math.floor(Math.random() * 200));
      }
    }
    throw lastErr || new Error('Failed to fetch stream');
  }

  private detectMimeFromMagic(filePath: string): { mime: string; ext: string } | null {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(32);
      fs.readSync(fd, buf, 0, 32, 0);
      fs.closeSync(fd);
      // PNG
      if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: '.png' };
      // JPEG
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: '.jpg' };
      // GIF87a/GIF89a
      if (buf.slice(0, 3).toString('ascii') === 'GIF') return { mime: 'image/gif', ext: '.gif' };
      // MP4 (ftyp)
      if (buf.slice(4, 8).toString('ascii') === 'ftyp') return { mime: 'video/mp4', ext: '.mp4' };
      // WebM/Matroska: EBML header 1A 45 DF A3
      if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return { mime: 'video/webm', ext: '.webm' };
      return null;
    } catch {
      return null;
    }
  }

  async backfillMissingDimensions(): Promise<{ processed: number; updated: number; errors: number }> {
    const all = await this.fileRepository.find({ order: { uploadedAt: 'DESC' } });
    let processed = 0, updated = 0, errors = 0;
    for (const f of all) {
      processed++;
      const needs = !(typeof (f as any).width === 'number' && (f as any).width! > 0) || !(typeof (f as any).height === 'number' && (f as any).height! > 0);
      if (!needs) continue;
      try {
        // Download to a temp path via S3 signed URL
        const signed = await this.s3Service.getSignedUrl(f.filename, 3600);
        const resp = await axios.get(signed, { responseType: 'arraybuffer', timeout: 30000 });
        const tempDir = path.join(process.cwd(), 'temp'); if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const tmpPath = path.join(tempDir, `dim_${f.id}_${Date.now()}`);
        fs.writeFileSync(tmpPath, Buffer.from(resp.data));
        try {
          const fp = await this.fileProcessingService.processFile(tmpPath, f.mimeType);
          const width = fp.width;
          const height = fp.height;
          if (width && height) {
            await this.fileRepository.update(f.id, { width, height });
            updated++;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } catch {
        errors++;
      }
    }
    return { processed, updated, errors };
  }

	private audioSubsequenceMatch(needleCsv: string, haystackCsv: string): boolean {
		if (!needleCsv || !haystackCsv) return false;
		return haystackCsv.includes(needleCsv);
	}

	private hammingHex(a: string, b: string): number { let d=0; for (let i=0;i<a.length;i++){const x=parseInt(a[i],16)^parseInt(b[i],16); d+=((x&1)+((x>>1)&1)+((x>>2)&1)+((x>>3)&1));} return d; }

	private bestWindowAvgHamming(needle: string[], haystack: string[]): number {
		if (haystack.length < needle.length) return Infinity;
		let best = Infinity;
		for (let start = 0; start <= haystack.length - needle.length; start++) {
			let sum = 0;
			for (let i = 0; i < needle.length; i++) sum += this.hammingHex(needle[i], haystack[start + i]);
			best = Math.min(best, sum / needle.length);
		}
		return best;
	}

	private async findParentMatch(newFile: FileEntity): Promise<PotentialMatch | undefined> {
		const candidates = await this.fileRepository.find({ order: { uploadedAt: 'DESC' } });
		console.log('[match] candidates:', candidates.length);
		const newLen = newFile.frameHashSequence?.length || 0;
		for (const cand of candidates) {
			if (cand.id === newFile.id) continue;

			// Case 1: Version with audio exists while new file is silent -> require visual match
			if (!newFile.hasAudio && cand.hasAudio && newFile.frameHashSequence && cand.frameHashSequence) {
				const avg1 = this.bestWindowAvgHamming(newFile.frameHashSequence, cand.frameHashSequence);
				const isShort1 = newLen > 0 && newLen <= 20;
				const threshold1 = isShort1 ? 24 : 12;
				console.log('[match] audio-version visual avgHamming', avg1, 'cand', cand.id, 'newLen', newLen, 'threshold', threshold1);
				if (avg1 <= threshold1) {
					return { id: cand.id, sourceUrl: cand.sourceUrl, reason: 'audio' };
				}
			}

			// Case 2: Longer version exists -> require candidate strictly longer and visual match
			const candLen = cand.frameHashSequence?.length || 0;
			const candIsLongerByFrames = candLen > newLen && newLen > 0;
			const candIsLongerByDuration = (cand.durationMs ?? 0) >= ((newFile.durationMs ?? 0) + 500);
			const considerLonger = (candIsLongerByFrames || candIsLongerByDuration) && !!newFile.frameHashSequence && !!cand.frameHashSequence;
			if (considerLonger) {
				const avg2 = this.bestWindowAvgHamming(newFile.frameHashSequence!, cand.frameHashSequence!);
				const isShort2 = newLen > 0 && newLen <= 20;
				const threshold2 = isShort2 ? 24 : 12;
				console.log('[match] longer-version visual avgHamming', avg2, 'cand', cand.id, 'newLen', newLen, 'candLen', candLen, 'threshold', threshold2);
				if (avg2 <= threshold2) {
					return { id: cand.id, sourceUrl: cand.sourceUrl, reason: 'longer' };
				}
			}
		}
		return undefined;
	}

	private async computeAndStoreFingerprints(tempPath: string, entity: FileEntity): Promise<FileEntity> {
		try {
			const fp = await this.remoteFingerprint.fingerprintFile(tempPath);
			if (fp) {
				entity.durationMs = fp.durationMs ?? null;
				entity.hasAudio = !!fp.hasAudio;
				entity.audioFingerprint = fp.audioFingerprint || null;
				entity.frameHashSequence = fp.frameHashes || null;
				console.log('[fingerprint] remote', { durationMs: entity.durationMs, hasAudio: entity.hasAudio, frames: entity.frameHashSequence?.length || 0, hasAudioFp: !!entity.audioFingerprint });
			} else {
				entity.hasAudio = false;
				console.log('[fingerprint] remote unavailable');
			}
		} catch (e) {
			console.log('[fingerprint] error', (e as any)?.message || e);
			entity.hasAudio = false;
		}
		return entity;
	}

	private async computeQuickCombinedHash(filePath: string): Promise<{ hash: string; sha256: string; md5: string }> {
		return await new Promise((resolve, reject) => {
			const sha256 = crypto.createHash('sha256');
			const md5 = crypto.createHash('md5');
			const stream = fs.createReadStream(filePath);
			stream.on('data', (chunk) => { sha256.update(chunk); md5.update(chunk); });
			stream.on('end', () => {
				const sha = sha256.digest('hex');
				const m = md5.digest('hex');
				const combined = crypto.createHash('sha256').update(sha + m).digest('hex');
				resolve({ hash: combined, sha256: sha, md5: m });
			});
			stream.on('error', reject);
		});
	}

	private ingestJobs: Map<string, any> = new Map();

	async startIngestJob(url: string, ownerId: string, tags?: string[]) {
		const jobId = uuidv4();
		const record = { id: jobId, state: 'pending', totalBytes: 0, downloadedBytes: 0, uploadedBytes: 0, ownerId, error: null as string | null, fileId: null as string | null, ext: '' as string, mimeType: null as string | null, sourceUrl: url, providedUrl: url, resolvedUrl: null as string | null, finalUrl: null as string | null };
		this.ingestJobs.set(jobId, record);

		(async () => {
			try {
				record.state = 'resolving';
				const mediaUrl = await this.resolveMediaUrl(url);
				record.resolvedUrl = mediaUrl;
				// Prefer non-silent Redgifs variant when applicable
				let effectiveUrl = mediaUrl;
				try {
					const mu = new URL(effectiveUrl);
					if (mu.hostname.toLowerCase() === 'media.redgifs.com' && /-silent\.mp4$/i.test(mu.pathname)) {
						const nonSilent = effectiveUrl.replace(/-silent(\.mp4)$/i, '$1');
						try {
							const head = await axios.head(nonSilent, { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.redgifs.com/' } });
							if (head.status >= 200 && head.status < 400) {
								effectiveUrl = nonSilent;
							}
						} catch {}
					}
				} catch {}
				try { record.ext = path.extname(new URL(effectiveUrl).pathname) || ''; } catch {}
				record.state = 'downloading';
				const politeHeaders = this.buildPoliteHeaders(effectiveUrl);
				const resp = await this.fetchStreamWithBackoff(effectiveUrl, politeHeaders, 3);
				record.totalBytes = Number(resp.headers?.['content-length'] || 0);
				const headerMime: string | undefined = (resp.headers?.['content-type'] as any) || undefined;
				if (headerMime) { record.mimeType = headerMime; }
				const tempDir = path.join(process.cwd(), 'temp'); if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
				const fileId = uuidv4();
				const urlExt = path.extname(new URL(effectiveUrl).pathname) || '.bin';
				const tempFilePath = path.join(tempDir, `${fileId}${urlExt}`);
				const writer = fs.createWriteStream(tempFilePath);
				record.finalUrl = effectiveUrl;
				resp.data.on('data', (chunk: Buffer) => { record.downloadedBytes += chunk.length; });
				resp.data.pipe(writer);
				await new Promise<void>((resolve, reject) => { writer.on('finish', () => resolve()); writer.on('error', reject); });

				const stats = fs.statSync(tempFilePath);
				if (stats.size === 0) {
					record.state = 'error';
					record.error = 'Downloaded file is empty (0 bytes)';
					try { await this.notificationsService.create(ownerId, 'Download failed: file is empty', { sourceUrl: url, jobId }); } catch {}
					return;
				}

				record.state = 'uploading';
				if (!record.totalBytes) record.totalBytes = stats.size;

				// Derive a sensible content-type from extension or magic bytes
				let uploadContentType = this.getMimeTypeFromExtension(urlExt) || record.mimeType || 'application/octet-stream';
				if (uploadContentType === 'application/octet-stream') {
					const sniff = this.detectMimeFromMagic(tempFilePath);
					if (sniff) {
						uploadContentType = sniff.mime;
					}
				}
				record.mimeType = uploadContentType;
				const s3Key = `${fileId}${urlExt}`;
				await this.s3Service.uploadFile(tempFilePath, s3Key, uploadContentType, (bytes) => { record.uploadedBytes = bytes; });

				record.state = 'saving';
				const mockFile: Express.Multer.File = { fieldname: 'file', originalname: path.basename(new URL(effectiveUrl).pathname), encoding: '7bit', mimetype: uploadContentType, size: stats.size, destination: tempDir, filename: path.basename(tempFilePath), path: tempFilePath, buffer: Buffer.alloc(0), stream: null as any };
				const saved = await this.uploadFile(mockFile, ownerId, url, tags);
				record.fileId = saved.file.id;
				record.state = 'done';
			} catch (e) {
				record.state = 'error';
				record.error = (e as any)?.message || String(e);
				try { await this.notificationsService.create(ownerId, 'Download failed', { sourceUrl: url, jobId, error: record.error }); } catch {}
			} finally {
				// temp cleanup handled inside uploadFile background; best-effort here
			}
		})();

		return { jobId };
	}

	async getIngestStatus(jobId: string, ownerId: string) {
		const rec = this.ingestJobs.get(jobId);
		if (!rec || rec.ownerId !== ownerId) throw new Error('Job not found');
		return { id: rec.id, state: rec.state, totalBytes: rec.totalBytes, downloadedBytes: rec.downloadedBytes, uploadedBytes: rec.uploadedBytes, fileId: rec.fileId, error: rec.error, ext: rec.ext, mimeType: rec.mimeType, sourceUrl: rec.sourceUrl, providedUrl: rec.providedUrl, resolvedUrl: rec.resolvedUrl, finalUrl: rec.finalUrl };
	}

	async uploadFile(file: Express.Multer.File, ownerId: string, sourceUrl?: string, tags?: string[]): Promise<{ file: FileRecord; match?: { id: string; sourceUrl?: string } }> {
    const fileId = uuidv4();
    const fileExtension = path.extname(file.originalname);
    const filename = `${fileId}${fileExtension}`;

		// Prefer a real MIME type; ignore generic octet-stream and fall back to extension
		const isGeneric = !file.mimetype || file.mimetype === 'application/octet-stream' || file.mimetype === 'binary/octet-stream';
		const byExt = this.getMimeTypeFromExtension(path.extname(file.originalname));
		const uploadContentType = isGeneric ? (byExt || 'application/octet-stream') : file.mimetype;

		// Quick duplicate check by combined hash before S3 upload
		const quick = await this.computeQuickCombinedHash(file.path);
		const existingFile = await this.fileRepository.findOne({ where: { hash: quick.hash, ownerId } });
    if (existingFile) {
			try { fs.unlinkSync(file.path); } catch {}
			throw new HttpException({ message: 'Duplicate file detected. This file was already uploaded.', fileId: existingFile.id }, HttpStatus.CONFLICT);
		}

		// Upload media to S3 first
    let s3Url: string;
    try {
      s3Url = await this.s3Service.uploadFile(file.path, filename, uploadContentType);
    } catch (e: any) {
      console.error('[files] S3 upload failed:', e?.message || e);
      try { fs.unlinkSync(file.path); } catch {}
      throw new Error('S3 upload failed');
    }

		// Generate thumbnail synchronously for immediate availability
    let thumbnailUrl: string | undefined;
    try {
      // Quick thumbnail generation for videos and GIFs
      const shouldGenerateThumbnail = uploadContentType.startsWith('video/') || uploadContentType === 'image/gif';
      if (shouldGenerateThumbnail) {
        const thumbnailPath = uploadContentType.startsWith('video/') 
          ? await this.fileProcessingService.generateVideoThumbnail(file.path)
          : await this.fileProcessingService.generateGifPreview(file.path);
        
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          const thumbnailFilename = `thumbnails/${fileId}.jpg`;
          thumbnailUrl = await this.s3Service.uploadFile(thumbnailPath, thumbnailFilename, 'image/jpeg');
          try { fs.unlinkSync(thumbnailPath); } catch {}
        }
      }
    } catch (thumbErr) {
      console.warn('Synchronous thumbnail generation failed:', (thumbErr as any)?.message || thumbErr);
    }

		// Create entity; background processing will compute fingerprints later
		let fileEntity = this.fileRepository.create({
      id: fileId,
      filename,
      originalName: file.originalname,
      mimeType: uploadContentType,
      size: file.size,
      url: s3Url,
      thumbnailUrl,
      sourceUrl,
      tags,
			hash: quick.hash,
			ownerId,
			hasAudio: false,
			transcodeStatus: (uploadContentType === 'video/webm') ? 'pending' : null,
    });

    let savedFile;
    try {
      savedFile = await this.fileRepository.save(fileEntity);
    } catch (e: any) {
      console.error('[files] DB save failed:', e?.message || e);
      throw new Error('DB save failed');
    }

		// Background processing (fire-and-forget)
		(async () => {
			try {
				// Process file fully: hashing, thumbnail, MIME refine
				const processing = await this.fileProcessingService.processFile(file.path);
				let updatedThumbUrl: string | undefined = undefined;
				if (processing.thumbnailPath && fs.existsSync(processing.thumbnailPath)) {
					try {
						const thumbnailFilename = `thumbnails/${fileId}.jpg`;
						updatedThumbUrl = await this.s3Service.uploadFile(processing.thumbnailPath, thumbnailFilename, 'image/jpeg');
					} finally {
						try { fs.unlinkSync(processing.thumbnailPath); } catch {}
					}
				}
				await this.fileRepository.update(savedFile.id, {
					hash: processing.hash,
					...(updatedThumbUrl ? { thumbnailUrl: updatedThumbUrl } : {}),
					mimeType: processing.mimeType || savedFile.mimeType,
					size: processing.size || savedFile.size,
          ...(processing.width ? { width: processing.width } : {}),
          ...(processing.height ? { height: processing.height } : {}),
					...(typeof processing.hasAudio === 'boolean' ? { hasAudio: processing.hasAudio } : {}),
				});

				// Transcode WEBM to MP4 for mobile compatibility
				const isWebm = (processing.mimeType || savedFile.mimeType).includes('webm') || savedFile.filename.toLowerCase().endsWith('.webm');
				if (isWebm) {
					try {
						await this.fileRepository.update(savedFile.id, { transcodeStatus: 'processing' });
						const mp4Path = await this.fileProcessingService.transcodeToMp4(file.path);
						const mp4Key = `mp4/${savedFile.id}.mp4`;
						await this.s3Service.uploadFile(mp4Path, mp4Key, 'video/mp4');
						await this.fileRepository.update(savedFile.id, { mp4Key, transcodeStatus: 'ready' });
						try { fs.unlinkSync(mp4Path); } catch {}
					} catch (e) {
						console.error('Transcode failed', (e as any)?.message || e);
						await this.fileRepository.update(savedFile.id, { transcodeStatus: 'failed' });
					}
				}

				const withFp = await this.computeAndStoreFingerprints(file.path, { ...savedFile });
				await this.fileRepository.update(savedFile.id, {
					durationMs: withFp.durationMs ?? null,
					hasAudio: (typeof withFp.hasAudio === 'boolean') ? withFp.hasAudio : (typeof processing.hasAudio === 'boolean' ? processing.hasAudio! : false),
					audioFingerprint: withFp.audioFingerprint ?? null,
					frameHashSequence: withFp.frameHashSequence ?? null,
				});
				const updated = await this.fileRepository.findOne({ where: { id: savedFile.id } });
				if (updated) {
					const match = await this.findParentMatch(updated);
					if (match) {
						let message = match.reason === 'audio'
							? 'We found a version of your upload that contains audio.'
							: 'We found a longer version of your upload.';
						if (match.reason === 'longer' && match.sourceUrl) {
							message += ` Source: ${match.sourceUrl}`;
						}
						await this.notificationsService.create(updated.ownerId!, message, { fileId: updated.id, sourceUrl: match.sourceUrl, matchType: match.reason, match });
					}
				}
			} catch (err) {
				console.error('Background processing failed', err);
				// No user-facing notification on processing failures per requirements
			} finally {
				try { fs.unlinkSync(file.path); } catch {}
			}
		})();

		// Return immediately
		return { file: { ...savedFile, uploadedAt: savedFile.uploadedAt.toISOString() } as FileRecord };
	}

	async uploadFromUrl(url: string, ownerId: string, tags?: string[]): Promise<{ file: FileRecord; match?: { id: string; sourceUrl?: string } }> {
		try {
			const mediaUrl = await this.resolveMediaUrl(url);
			const politeHeaders = this.buildPoliteHeaders(mediaUrl);
			const response = await this.fetchStreamWithBackoff(mediaUrl, politeHeaders, 3);
			const tempDir = path.join(process.cwd(), 'temp');
			if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
	    const fileId = uuidv4();
	    let contentType = response.headers['content-type'] || 'application/octet-stream';
	    const urlExt = path.extname(new URL(mediaUrl).pathname);
	    const headerExt = this.getExtensionFromMimeType(contentType);
	    const fileExtension = headerExt || urlExt || '.bin';
	    const tempFilePath = path.join(tempDir, `${fileId}${fileExtension}`);
	    const writer = fs.createWriteStream(tempFilePath);
	    response.data.pipe(writer);
			await new Promise<void>((resolve, reject) => { writer.on('finish', () => resolve()); writer.on('error', reject); });
	    const stats = fs.statSync(tempFilePath);
	    const originalName = path.basename(new URL(mediaUrl).pathname) || `download${fileExtension}`;
	    let effectiveMimeType = contentType;
			// If server returned generic MIME, prefer extension-based detection
			if (!headerExt && urlExt) { effectiveMimeType = this.getMimeTypeFromExtension(urlExt) || contentType; }
			const mockFile: Express.Multer.File = { fieldname: 'file', originalname: originalName, encoding: '7bit', mimetype: effectiveMimeType, size: stats.size, destination: tempDir, filename: `${fileId}${fileExtension}`, path: tempFilePath, buffer: Buffer.alloc(0), stream: null as any };
			return await this.uploadFile(mockFile, ownerId, url, tags);
	    
	    // Fallback: try to get a preview image (og:image/twitter:image) and save that, preserving user's URL as sourceUrl
		} catch (error) {
			try {
				const pageResp = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
				const html = String(pageResp.data || '');
				const og = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i);
				const tw = html.match(/name=["']twitter:image["']\s+content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["']\s+name=["']twitter:image["']/i);
				const previewUrl: string | undefined = (og?.[1] || tw?.[1]) as string | undefined;
				if (!previewUrl) throw new Error('No preview image found');
				const polite = this.buildPoliteHeaders(previewUrl);
				const img = await this.fetchStreamWithBackoff(previewUrl, polite, 2);
				const tempDir = path.join(process.cwd(), 'temp');
				if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
				const fileId = uuidv4();
				const ext = path.extname(new URL(previewUrl).pathname) || '.jpg';
				const tempFilePath = path.join(tempDir, `${fileId}${ext}`);
				const writer = fs.createWriteStream(tempFilePath);
				img.data.pipe(writer);
				await new Promise<void>((resolve, reject) => { writer.on('finish', () => resolve()); writer.on('error', reject); });
				const stats = fs.statSync(tempFilePath);
				if (stats.size === 0) throw new Error('Preview image download empty');
				const contentType = img.headers['content-type'] || this.getMimeTypeFromExtension(ext) || 'image/jpeg';
				const originalName = path.basename(new URL(previewUrl).pathname) || `preview${ext}`;
				const mockFile: Express.Multer.File = { fieldname: 'file', originalname: originalName, encoding: '7bit', mimetype: contentType, size: stats.size, destination: tempDir, filename: path.basename(tempFilePath), path: tempFilePath, buffer: Buffer.alloc(0), stream: null as any };
				return await this.uploadFile(mockFile, ownerId, url, tags);
			} catch (fallbackErr: any) {
				throw new Error(`Failed to download file from URL: ${ (error as any)?.message || error }; preview fallback failed: ${fallbackErr?.message || fallbackErr}`);
			}
		}
	}

	async getAllFiles(ownerId: string): Promise<FileRecord[]> {
		const files = await this.fileRepository.find({ where: { ownerId }, order: { uploadedAt: 'DESC' } });
    const filesWithFreshUrls = await Promise.all(files.map(async (file) => {
      const url = await this.s3Service.getSignedUrl(file.filename, 3600);
      let thumbnailUrl = file.thumbnailUrl;
      if (file.thumbnailUrl) {
        const thumbnailKey = `thumbnails/${file.id}.jpg`;
        thumbnailUrl = await this.s3Service.getSignedUrl(thumbnailKey, 3600);
      }
			// @ts-ignore new optional mp4Key column
			const mp4Key: string | undefined = (file as any).mp4Key;
			let mp4Url: string | undefined = undefined;
			if (mp4Key) {
				mp4Url = await this.s3Service.getSignedUrl(mp4Key, 3600);
			}
			return { ...file, url, mp4Url, thumbnailUrl, uploadedAt: file.uploadedAt.toISOString() } as FileRecord;
		}));
    return filesWithFreshUrls;
  }

	async getFileById(id: string, ownerId: string): Promise<FileRecord | null> {
		const file = await this.fileRepository.findOne({ where: { id, ownerId } });
    if (!file) return null;
    const url = await this.s3Service.getSignedUrl(file.filename, 3600);
    let thumbnailUrl = file.thumbnailUrl;
    if (file.thumbnailUrl) {
      const thumbnailKey = `thumbnails/${file.id}.jpg`;
      thumbnailUrl = await this.s3Service.getSignedUrl(thumbnailKey, 3600);
    }
		// @ts-ignore new optional mp4Key column
		const mp4Key: string | undefined = (file as any).mp4Key;
		let mp4Url: string | undefined = undefined;
		if (mp4Key) {
			mp4Url = await this.s3Service.getSignedUrl(mp4Key, 3600);
		}
		return { ...file, url, mp4Url, thumbnailUrl, uploadedAt: file.uploadedAt.toISOString() } as FileRecord;
	}

	async refreshFileUrl(id: string, ownerId: string): Promise<string> {
		const file = await this.fileRepository.findOne({ where: { id, ownerId } });
		if (!file) { throw new Error('File not found'); }
		const newUrl = await this.s3Service.refreshSignedUrl(file.filename, 3600, file.originalName || undefined);
    await this.fileRepository.update(id, { url: newUrl });
    return newUrl;
  }

	async deleteFile(id: string, ownerId: string): Promise<void> {
		const file = await this.fileRepository.findOne({ where: { id, ownerId } });
		if (!file) { throw new Error('File not found'); }
    await this.s3Service.deleteFile(file.filename);
    await this.fileRepository.delete(id);
  }

	async updateTags(id: string, ownerId: string, tags: string[]): Promise<FileRecord> {
		const file = await this.fileRepository.findOne({ where: { id, ownerId } });
		if (!file) { throw new Error('File not found'); }
		const normalized = (tags || []).map(t => t.trim().toLowerCase()).filter(Boolean);
		await this.fileRepository.update(id, { tags: normalized });
		const updated = await this.fileRepository.findOne({ where: { id, ownerId } });
		if (!updated) { throw new Error('File not found after update'); }
		const url = await this.s3Service.getSignedUrl(updated.filename, 3600);
		let thumbnailUrl = updated.thumbnailUrl;
		if (updated.thumbnailUrl) {
			const thumbnailKey = `thumbnails/${updated.id}.jpg`;
			thumbnailUrl = await this.s3Service.getSignedUrl(thumbnailKey, 3600);
		}
		return { ...updated, url, thumbnailUrl, uploadedAt: updated.uploadedAt.toISOString() } as FileRecord;
	}

	async updateTitle(id: string, ownerId: string, title: string | null): Promise<FileRecord> {
		const file = await this.fileRepository.findOne({ where: { id, ownerId } });
		if (!file) { throw new Error('File not found'); }
		const normalized = (title || '').trim();
		await this.fileRepository.update(id, { title: normalized || null });
		const updated = await this.fileRepository.findOne({ where: { id, ownerId } });
		if (!updated) { throw new Error('File not found after update'); }
		const url = await this.s3Service.getSignedUrl(updated.filename, 3600);
		let thumbnailUrl = updated.thumbnailUrl;
		if (updated.thumbnailUrl) {
			const thumbnailKey = `thumbnails/${updated.id}.jpg`;
			thumbnailUrl = await this.s3Service.getSignedUrl(thumbnailKey, 3600);
		}
		return { ...updated, url, thumbnailUrl, uploadedAt: updated.uploadedAt.toISOString() } as FileRecord;
	}

  private async resolveMediaUrl(url: string): Promise<string> {
		if (url.includes('redgifs.com')) {
			// Normalize redgifs embed/watch/ifr URLs by stripping query params; prefer non-silent direct media
			try {
				const u = new URL(url);
				u.search = '';
				u.hash = '';
				let candidate = u.toString();
				if (u.hostname.toLowerCase() === 'media.redgifs.com' && /-silent\.mp4$/i.test(u.pathname)) {
					const nonSilent = candidate.replace(/-silent(\.mp4)$/i, '$1');
					try {
						const resp = await axios.head(nonSilent, { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.redgifs.com/' } });
						if (resp.status >= 200 && resp.status < 400) {
							candidate = nonSilent;
						}
					} catch {}
				}
				url = candidate;
			} catch {}
			return await this.resolveRedgifsUrl(url);
		}
    if (url.includes('imgur.com') && !url.endsWith('.gif') && !url.endsWith('.mp4')) {
      return await this.resolveImgurUrl(url);
    }
    if (url.includes('reddit.com') || url.includes('redd.it')) {
      return await this.resolveRedditUrl(url);
    }
		// Generic fallback: for arbitrary pages, try to discover a direct video URL
		try {
			return await this.resolveGenericUrl(url);
		} catch {}
    return url;
  }

  private async resolveGenericUrl(rawUrl: string): Promise<string> {
		// If already a likely direct media URL, return as-is
		if (/\.(mp4|webm|mov|mkv|m3u8|mpd)(\?|#|$)/i.test(rawUrl)) {
			return rawUrl;
		}
		try {
			const page = await axios.get(rawUrl, {
				timeout: 8000,
				headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
				maxRedirects: 5,
				validateStatus: (s) => !!s && s < 500,
			});
			const html = String(page.data || '');
			const base = new URL(page.request?.res?.responseUrl || page.request?.responseURL || rawUrl);

			const absolutize = (u: string): string => {
				try { return new URL(u, base).toString(); } catch { return u; }
			};

			// 1) JSON-LD VideoObject
			const ldScripts = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
			for (const m of ldScripts) {
				try {
					const json = JSON.parse(m[1]);
					const objs = Array.isArray(json) ? json : [json];
					for (const obj of objs) {
						const type = (obj['@type'] || obj['type'] || '').toString().toLowerCase();
						if (type.includes('videoobject')) {
							const candidate = obj['contentUrl'] || obj['embedUrl'] || obj['url'];
							if (candidate && typeof candidate === 'string') {
								const direct = absolutize(candidate);
								if (/\.(mp4|webm|mov|m3u8|mpd)(\?|#|$)/i.test(direct)) return direct;
							}
						}
					}
				} catch {}
			}

			// 2) OpenGraph/Twitter video
			const ogVideo = (html.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["']\s+property=["']og:video["']/i))?.[1];
			if (ogVideo) {
				const direct = absolutize(ogVideo);
				if (/\.(mp4|webm|mov|m3u8|mpd)(\?|#|$)/i.test(direct)) return direct;
			}

			// 3) <video> and <source> tags
			const videoSrcs: string[] = [];
			for (const m of html.matchAll(/<video[^>]*src=["']([^"']+)["'][^>]*>/gi)) { videoSrcs.push(absolutize(m[1])); }
			for (const m of html.matchAll(/<source[^>]*type=["']video\/(mp4|webm|ogg)["'][^>]*src=["']([^"']+)["'][^>]*>/gi)) { videoSrcs.push(absolutize(m[2])); }
			for (const m of html.matchAll(/<source[^>]*src=["']([^"']+\.(?:mp4|webm|mov|m3u8|mpd))(?:\?[^"']*)?["'][^>]*>/gi)) { videoSrcs.push(absolutize(m[1])); }
			if (videoSrcs.length > 0) {
				// Prefer mp4/webm, then m3u8/mpd
				const preferred = [...videoSrcs].sort((a, b) => {
					const score = (u: string) => (/\.mp4(\?|#|$)/i.test(u) ? 3 : /\.webm(\?|#|$)/i.test(u) ? 2 : /\.(m3u8|mpd)(\?|#|$)/i.test(u) ? 1 : 0);
					return score(b) - score(a);
				});
				for (const u of preferred) {
					try { const head = await axios.head(u, { timeout: 3000, headers: { 'User-Agent': 'Mozilla/5.0' } }); if (head.status < 400) return u; } catch {}
				}
			}

			// 4) Heuristic: absolute links to common video extensions in page text
			const linkMatches = Array.from(html.matchAll(/https?:[^\s"'<>]+\.(?:mp4|webm|mov|m3u8|mpd)(?:\?[^\s"'<>]*)?/gi)).map(m => absolutize(m[0]));
			for (const u of linkMatches) {
				try { const head = await axios.head(u, { timeout: 3000, headers: { 'User-Agent': 'Mozilla/5.0' } }); if (head.status < 400) return u; } catch {}
			}

			// If nothing found, return original
			return rawUrl;
		} catch {
			return rawUrl;
		}
	}

  private async resolveImgurUrl(url: string): Promise<string> {
    try {
      const imgurId = url.split('/').pop()?.split('.')[0];
			if (!imgurId) { throw new Error('Could not extract Imgur ID'); }
      const formats = ['.gif', '.mp4', '.jpg', '.png'];
      for (const format of formats) {
        const directUrl = `https://i.imgur.com/${imgurId}${format}`;
				try { const response = await axios.head(directUrl); if (response.status === 200) { return directUrl; } } catch {}
			}
      throw new Error('Could not find valid Imgur media format');
    } catch (error) {
      console.error('Error resolving Imgur URL:', error);
      throw new Error(`Failed to resolve Imgur URL: ${error.message}`);
    }
  }

  private async resolveRedditUrl(rawUrl: string): Promise<string> {
    try {
      const ensureDirectFromVReddit = async (id: string): Promise<string> => {
        const candidates = [
          `https://v.redd.it/${id}/DASH_1080.mp4`,
          `https://v.redd.it/${id}/DASH_720.mp4`,
          `https://v.redd.it/${id}/DASH_480.mp4`,
          `https://v.redd.it/${id}/DASH_360.mp4`,
          `https://v.redd.it/${id}/DASH_240.mp4`,
        ];
        for (const c of candidates) {
          try {
            const resp = await axios.head(c, { timeout: 2500, headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (resp.status >= 200 && resp.status < 400) return c;
          } catch {}
        }
        return `https://v.redd.it/${id}/HLSPlaylist.m3u8`;
      };

      const extractFromJson = (json: any): string | undefined => {
        try {
          const root = Array.isArray(json) ? (json[0]?.data?.children?.[0]?.data ?? {}) : json?.data?.children?.[0]?.data ?? json;
          const cp = (root.crosspost_parent_list && root.crosspost_parent_list[0]) || {};
          // Prefer Redgifs from oEmbed html if present (often contains sound-ready media)
          const oembedHtml: string | undefined = root.secure_media?.oembed?.html || cp.secure_media?.oembed?.html;
          if (oembedHtml && /redgifs\.com/i.test(oembedHtml)) {
            const m = oembedHtml.match(/src=["']([^"']+redgifs\.com[^"']+)["']/i) || oembedHtml.match(/href=["']([^"']+redgifs\.com[^"']+)["']/i);
            const embed = m?.[1];
            if (embed) return embed;
          }
          const rv = root.secure_media?.reddit_video?.fallback_url || root.preview?.reddit_video_preview?.fallback_url || cp.secure_media?.reddit_video?.fallback_url || cp.preview?.reddit_video_preview?.fallback_url;
          if (rv && typeof rv === 'string') return rv;
          const overridden = root.url_overridden_by_dest || root.url;
          if (typeof overridden === 'string' && overridden) return overridden;
          // Gallery support
          if (root.is_gallery && root.gallery_data && root.media_metadata) {
            try {
              const firstId = root.gallery_data.items?.[0]?.media_id;
              const meta = firstId ? root.media_metadata[firstId] : undefined;
              let galleryUrl = meta?.s?.u || meta?.s?.gif;
              // Fallback to highest available preview if source missing
              if (!galleryUrl && Array.isArray(meta?.p) && meta.p.length > 0) {
                galleryUrl = meta.p[meta.p.length - 1]?.u;
              }
              if (galleryUrl && typeof galleryUrl === 'string') return String(galleryUrl).replace(/&amp;/g, '&');
            } catch {}
          }
          // Image preview
          const img = root.preview?.images?.[0]?.source?.url;
          if (img && typeof img === 'string') return img.replace(/&amp;/g, '&');
          // oEmbed thumbnail (may be image)
          const thumb = root.secure_media?.oembed?.thumbnail_url || cp.secure_media?.oembed?.thumbnail_url;
          if (thumb && typeof thumb === 'string') return String(thumb);
        } catch {}
        return undefined;
      };

      // Normalize and follow redirects for share links
      let workingUrl = rawUrl;
      try {
        const u0 = new URL(rawUrl);
        if (u0.hostname.toLowerCase() === 'redd.it' && u0.pathname.length > 1) {
          const id = u0.pathname.replace(/\//g, '');
          workingUrl = `https://www.reddit.com/comments/${id}`;
        }
        // Strip tracking query params for reddit links (share_id, utm_*) as they can break resolution
        if (u0.hostname.toLowerCase().includes('reddit.com')) {
          const clean = new URL(rawUrl);
          clean.search = '';
          clean.hash = '';
          workingUrl = clean.toString();
        }
      } catch {}

      // Fetch page to capture canonical URL or final redirected URL (for /s/ share links)
      const pageResp = await axios.get(workingUrl, { 
        timeout: 8000, 
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }, 
        maxRedirects: 10, 
        validateStatus: (s) => !!s && s < 500 
      });
      const finalHtml = String(pageResp.data || '');
      const findMeta = (pattern: RegExp) => { const m = finalHtml.match(pattern); return (m && m[1]) ? m[1] : undefined; };
      const redirectedUrl: string | undefined = (pageResp as any)?.request?.res?.responseUrl || (pageResp as any)?.request?.responseURL;
      let canonical = findMeta(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i) || findMeta(/property=["']og:url["']\s+content=["']([^"']+)["']/i) || redirectedUrl;
      // Clean canonical by removing query/hash
      if (canonical) {
        try { const c = new URL(canonical); c.search = ''; c.hash = ''; canonical = c.toString(); } catch {}
      }

      // Try JSON API for post metadata
      let postJsonUrl: string | undefined;
      try {
        if (canonical) {
          const base = canonical.endsWith('/') ? canonical.slice(0, -1) : canonical;
          postJsonUrl = `${base}.json?raw_json=1`;
        } else {
          const u = new URL(workingUrl);
          // Ensure no query/hash when deriving id
          u.search = '';
          u.hash = '';
          const parts = u.pathname.split('/').filter(Boolean);
          // /r/<sub>/comments/<id>/...
          const idx = parts.findIndex(p => p === 'comments');
          if (idx >= 0 && parts.length > idx + 1) {
            const id = parts[idx + 1];
            postJsonUrl = `https://www.reddit.com/comments/${id}.json?raw_json=1`;
          }
        }
      } catch {}

      if (postJsonUrl) {
        // TODO: Migrate to OAuth-based Reddit API and add robust rate-limit handling.
        // The .json endpoint is undocumented and may be rate limited or change behavior.
        // Implement retry/backoff, caching, and fallbacks to HTML/OG tags when the JSON call fails.
        // Try multiple hosts for JSON to reduce transient failures
        const jsonCandidates: string[] = [];
        try {
          const urlObj = new URL(postJsonUrl);
          const path = urlObj.pathname + (urlObj.search || '');
          jsonCandidates.push(postJsonUrl);
          jsonCandidates.push(`https://api.reddit.com${path.replace(/\.json$/, '')}`);
          jsonCandidates.push(`https://old.reddit.com${urlObj.pathname}.json?raw_json=1`);
        } catch { jsonCandidates.push(postJsonUrl); }
        for (const endpoint of jsonCandidates) {
          try {
            const j = await axios.get(endpoint, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
            let mediaUrl = extractFromJson(j.data);
            if (mediaUrl) {
              // Normalize redgifs URLs by stripping embed params to prefer direct media with audio
              try {
                const mu = new URL(mediaUrl);
                if (mu.hostname.endsWith('redgifs.com')) { mu.search = ''; mu.hash = ''; mediaUrl = mu.toString(); }
              } catch {}
              try {
                const v = new URL(mediaUrl);
                const host = v.hostname.toLowerCase();
                if (host === 'v.redd.it') {
                  const id = v.pathname.split('/').filter(Boolean)[0] || '';
                  if (id) return await ensureDirectFromVReddit(id);
                }
              } catch {}
              if (mediaUrl.endsWith('.gifv')) return mediaUrl.replace(/\.gifv$/i, '.mp4');
              // Prefer non-silent variants for Redgifs direct links
              try {
                const u = new URL(mediaUrl);
                if (u.hostname.endsWith('redgifs.com')) {
                  const nonSilent = mediaUrl.replace(/-silent(\.[a-z0-9]+)$/i, '$1');
                  if (nonSilent !== mediaUrl) {
                    try {
                      const head = await axios.head(nonSilent, { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                      if (head.status >= 200 && head.status < 400) return nonSilent;
                    } catch {}
                  }
                }
              } catch {}
              try { return await this.resolveMediaUrl(mediaUrl); } catch { return mediaUrl; }
            }
          } catch {}
        }
      }

      // Fallbacks: i.redd.it or v.redd.it direct inference
      try {
        const u = new URL(canonical || workingUrl);
        const host = u.hostname.toLowerCase();
        const parts = u.pathname.split('/').filter(Boolean);
        if (host === 'i.redd.it') return u.toString();
        if (host === 'v.redd.it' && parts.length > 0) {
          return await ensureDirectFromVReddit(parts[0]);
        }
      } catch {}

      // As a last HTML fallback, try og:video/og:image
      const ogVideo = findMeta(/property=["']og:video["']\s+content=["']([^"']+)["']/i) || findMeta(/content=["']([^"']+)["']\s+property=["']og:video["']/i) || findMeta(/property=["']og:video:secure_url["']\s+content=["']([^"']+)["']/i);
      if (ogVideo) {
        try {
          const vu = new URL(ogVideo);
          const host = vu.hostname.toLowerCase();
          if (host === 'v.redd.it') {
            return await ensureDirectFromVReddit(vu.pathname.split('/').filter(Boolean)[0] || '');
          }
          // For non-Reddit hosts (e.g., Redgifs), resolve to direct media (prefer audio-capable variants)
          try { return await this.resolveMediaUrl(vu.toString()); } catch { return ogVideo; }
        } catch {}
        return ogVideo;
      }

      // Fallback: search for Redgifs embeds in HTML and resolve
      const redgifsIframe = (finalHtml.match(/<iframe[^>]+src=["']([^"']+redgifs\.com[^"']+)["'][^>]*>/i) || [])[1];
      if (redgifsIframe) {
        try {
          const cleaned = redgifsIframe.replace(/-silent(\.[a-z0-9]+)$/i, '$1');
          return await this.resolveMediaUrl(cleaned);
        } catch {}
      }
      const redgifsSource = (finalHtml.match(/<source[^>]+src=["']([^"']+redgifs\.com[^"']+)["'][^>]*>/i) || [])[1];
      if (redgifsSource) {
        try {
          const cleaned = redgifsSource.replace(/-silent(\.[a-z0-9]+)$/i, '$1');
          return await this.resolveMediaUrl(cleaned);
        } catch {}
      }
      const redgifsAnchor = (finalHtml.match(/<a[^>]+href=["']([^"']+redgifs\.com[^"']+)["'][^>]*>/i) || [])[1];
      if (redgifsAnchor) {
        try {
          const cleaned = redgifsAnchor.replace(/-silent(\.[a-z0-9]+)$/i, '$1');
          return await this.resolveMediaUrl(cleaned);
        } catch {}
      }
      const ogImage = findMeta(/property=["']og:image["']\s+content=["']([^"']+)["']/i) || findMeta(/content=["']([^"']+)["']\s+property=["']og:image["']/i) || findMeta(/name=["']twitter:image["']\s+content=["']([^"']+)["']/i) || findMeta(/content=["']([^"']+)["']\s+name=["']twitter:image["']/i);
      if (ogImage) return ogImage;
      return rawUrl;
    } catch (e) {
      return rawUrl;
    }
  }

	private async resolveRedgifsUrl(rawUrl: string): Promise<string> {
		const startedAt = Date.now();
		const log = (...args: any[]) => console.log('[redgifs]', ...args);
		const MAX_MS = 8000; // overall deadline
		const HEAD_TIMEOUT = 2000;
		const AUTH_TIMEOUT = 2000;
		const META_TIMEOUT = 3000;
		const HTML_TIMEOUT = 2000;

		const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
			let to: NodeJS.Timeout;
			return await Promise.race([
				p.finally(() => clearTimeout(to)),
				new Promise<T>((_, reject) => { to = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms as any); })
			]);
		};

		const headOk = async (url: string): Promise<string> => {
			try {
				const resp = await withTimeout(
					axios.head(url, { timeout: HEAD_TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.redgifs.com/' } }),
					HEAD_TIMEOUT + 200,
					`HEAD ${url}`,
				);
				if (resp.status >= 200 && resp.status < 300) return url;
				throw new Error(`HEAD status ${resp.status}`);
			} catch (e) {
				throw e;
			}
		};

		try {
			const u = new URL(rawUrl);
			const parts = u.pathname.split('/').filter(Boolean);
			// support /watch/<id>, /ifr/<id>, /<id>
			const idRaw = parts[1] || parts[0] || '';
			if (!idRaw) throw new Error('Could not extract Redgifs ID');
			const id = idRaw.replace(/[^a-zA-Z0-9]/g, '');
			log('resolve start', { id, host: u.hostname });

			// Prepare candidates for direct media
			const pascal = id
				.replace(/[-_]+/g, ' ')
				.replace(/(^|\s)([a-zA-Z])/g, (_, s, c) => s + c.toUpperCase())
				.replace(/\s+/g, '');
			const candidates = [
				`https://media.redgifs.com/${pascal}-mobile.mp4`,
				`https://media.redgifs.com/${pascal}.mp4`,
				`https://thumbs2.redgifs.com/${pascal}-mobile.mp4`,
			];

			// Strategy A: Redgifs API
			const apiPromise = (async () => {
				try {
					const auth = await withTimeout(
						axios.get('https://api.redgifs.com/v2/auth/temporary', { timeout: AUTH_TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0' } }),
						AUTH_TIMEOUT + 200,
						'auth',
					);
					const token = (auth.data && (auth.data.token || auth.data?.accessToken)) || undefined;
					log('auth ok', { elapsedMs: Date.now() - startedAt });
					if (token) {
						const meta = await withTimeout(
							axios.get(`https://api.redgifs.com/v2/gifs/${id}`, {
								timeout: META_TIMEOUT,
								headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Mozilla/5.0' },
							}),
							META_TIMEOUT + 200,
							'meta',
						);
						const urls = meta.data?.gif?.urls || {};
						const direct: string | undefined = urls.hd || urls.sd || urls.gif || urls.max1mbGif || urls.thumbnail;
						if (direct) {
							log('api resolved', { elapsedMs: Date.now() - startedAt, direct });
							return direct;
						}
					}
					throw new Error('no direct via api');
				} catch (e) {
					log('api failed', (e as any)?.message || e);
					throw e;
				}
			})();

			// Strategy B: Concurrent HEAD to common patterns
			const headPromise = (async () => {
				const probes = candidates.map((c) => headOk(c));
				// first to succeed
				// Promise.any not in older runtimes; emulate
				return await new Promise<string>((resolve, reject) => {
					let rejections = 0;
					for (const p of probes) {
						p.then((url) => { log('head resolved', { url, elapsedMs: Date.now() - startedAt }); resolve(url); })
						 .catch(() => { if (++rejections === probes.length) reject(new Error('all HEAD failed')); });
					}
				});
			})();

			// Strategy C: Scrape HTML for og:video
			const htmlPromise = (async () => {
				try {
					const htmlResp = await withTimeout(
						axios.get(rawUrl, { timeout: HTML_TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0' } }),
						HTML_TIMEOUT + 200,
						'html',
					);
					const html = String(htmlResp.data || '');
					const m = html.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["']\s+property=["']og:video["']/i);
					const direct = m?.[1];
					if (direct) {
						log('html resolved', { direct, elapsedMs: Date.now() - startedAt });
						return direct;
					}
					throw new Error('no og:video');
				} catch (e) {
					log('html failed', (e as any)?.message || e);
					throw e;
				}
			})();

			// Race strategies with overall deadline
			// Wrap to tag the winner type; enforce overall deadline via withTimeout
			const taggedApi = apiPromise.then((u) => ({ type: 'api' as const, url: u }));
			const taggedHead = headPromise.then((u) => ({ type: 'head' as const, url: u }));
			const taggedHtml = htmlPromise.then((u) => ({ type: 'html' as const, url: u }));
			const firstTagged = await withTimeout(Promise.any([taggedApi, taggedHead, taggedHtml]), MAX_MS, 'overall');
			let candidate = firstTagged.url;
			const winnerType = firstTagged.type;
			// If API wasn't the winner, allow a short grace for API to arrive and override candidate
			if (winnerType !== 'api') {
				try {
					const apiGrace = await withTimeout(apiPromise, 700, 'apiGrace');
					if (apiGrace) {
						candidate = apiGrace;
					}
				} catch {}
			}
			// Prefer non-silent direct media if candidate is a Redgifs silent URL
			try {
				const cu = new URL(candidate);
				if (cu.hostname.toLowerCase() === 'media.redgifs.com' && /-silent\.mp4$/i.test(cu.pathname)) {
					const nonSilent = candidate.replace(/-silent(\.mp4)$/i, '$1');
					try {
						const head = await withTimeout(
							axios.head(nonSilent, { timeout: HEAD_TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.redgifs.com/' } }),
							HEAD_TIMEOUT + 200,
							'head nonSilent',
						);
						if (head.status >= 200 && head.status < 400) {
							candidate = nonSilent;
						}
					} catch {}
				}
			} catch {}
			log('resolved success', { result: candidate, totalMs: Date.now() - startedAt });
			return candidate;
		} catch (err) {
			log('resolve failed, falling back to original', (err as any)?.message || err, { totalMs: Date.now() - startedAt });
			return rawUrl;
    }
  }

  private getExtensionFromMimeType(mimeType: string): string {
		const mimeToExt: { [key: string]: string } = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi', 'image/gif': '.gif', 'image/jpeg': '.jpg', 'image/png': '.png' };
    return mimeToExt[mimeType] || '';
  }

  private getMimeTypeFromExtension(ext: string): string | undefined {
    const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
		const extToMime: { [key: string]: string } = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
    return extToMime[normalized];
  }

	async getFileEntity(id: string, ownerId: string) {
		return await this.fileRepository.findOne({ where: { id, ownerId } });
	}

	async getObjectStream(key: string) {
		return await this.s3Service.getObjectStream(key);
	}
}
