import { Injectable } from '@nestjs/common';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

function toHex(bits: number[]): string {
	let hex = '';
	for (let i = 0; i < bits.length; i += 4) {
		const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
		hex += nibble.toString(16);
	}
	return hex;
}

// Compute 64-bit dHash on 9x8 grayscale image
async function computeDHash(buffer: Buffer): Promise<string> {
	// Resize to 9x8, grayscale, raw 8-bit pixels
	const raw = await sharp(buffer).resize(9, 8).grayscale().raw().toBuffer();
	const width = 9;
	const height = 8;
	const bits: number[] = [];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width - 1; x++) {
			const left = raw[y * width + x];
			const right = raw[y * width + (x + 1)];
			bits.push(left > right ? 1 : 0);
		}
	}
	return toHex(bits);
}

@Injectable()
export class FingerprintService {
  async imageDHash(filePath: string): Promise<string | null> {
    try {
      const buf = fs.readFileSync(filePath);
      return await computeDHash(buf);
    } catch {
      return null;
    }
  }
	async extractDurationMs(filePath: string): Promise<number | null> {
		try {
			const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
			const out = child_process.execSync(cmd, { encoding: 'utf8' });
			const seconds = parseFloat(out.trim());
			if (isNaN(seconds)) return null;
			return Math.round(seconds * 1000);
		} catch {
			return null;
		}
	}

	async sampleFrameHashes(filePath: string, fps: number = 1): Promise<string[] | null> {
		const framesDir = path.join(process.cwd(), 'temp', `frames_${Date.now()}`);
		fs.mkdirSync(framesDir, { recursive: true });
		const pattern = path.join(framesDir, 'frame_%05d.jpg');
		try {
			const cmd = `ffmpeg -y -i "${filePath}" -vf fps=${fps},scale=160:-1 -q:v 2 "${pattern}"`;
			child_process.execSync(cmd, { stdio: 'ignore' });
			const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
			if (files.length === 0) return [];
			const hashes: string[] = [];
			for (const f of files) {
				const buf = fs.readFileSync(path.join(framesDir, f));
				const dhash = await computeDHash(buf);
				hashes.push(dhash);
			}
			return hashes;
		} catch {
			return null;
		} finally {
			try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
		}
	}
}
