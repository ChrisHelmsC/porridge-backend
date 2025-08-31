import axios from 'axios';
import * as fs from 'fs';

export interface RemoteFingerprint {
	durationMs?: number;
	hasAudio?: boolean;
	audioFingerprint?: string;
	frameHashes?: string[];
}

export class FingerprintClient {
	constructor(private baseUrl: string) {}

	async fingerprintFile(localPath: string): Promise<RemoteFingerprint | null> {
		try {
			const stream = fs.createReadStream(localPath);
			const form = new (require('form-data'))();
			form.append('file', stream, { filename: 'upload.bin' });
			const res = await axios.post(`${this.baseUrl}/fingerprint`, form, {
				headers: form.getHeaders(),
				maxBodyLength: Infinity,
				maxContentLength: Infinity,
			});
			if (res.data && res.data.ok) {
				return {
					durationMs: res.data.durationMs,
					hasAudio: res.data.hasAudio,
					audioFingerprint: res.data.audioFingerprint,
					frameHashes: res.data.frameHashes,
				};
			}
			return null;
		} catch (e) {
			return null;
		}
	}
}
