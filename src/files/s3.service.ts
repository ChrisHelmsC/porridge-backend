import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import { Upload } from '@aws-sdk/lib-storage';

@Injectable()
export class S3Service {
  private s3Client: S3Client;
  private bucketName: string;

  constructor(private configService: ConfigService) {
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET') || 'porridge-files';
    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
      credentials: {
        accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID') || '',
        secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY') || '',
      },
    });
  }

  async uploadFile(filePath: string, key: string, contentType: string, onProgress?: (uploadedBytes: number) => void): Promise<string> {
    try {
      const fileStream = fs.createReadStream(filePath);
      let uploaded = 0;
      const uploader = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucketName,
          Key: key,
          Body: fileStream,
          ContentType: contentType,
        },
      });
      uploader.on('httpUploadProgress', (p) => { if (typeof p.loaded === 'number') { uploaded = p.loaded; onProgress && onProgress(uploaded); } });
      await uploader.done();
      return await this.getSignedUrl(key, 3600);
    } catch (error) {
      console.error('Error uploading file to S3:', error);
      throw new Error(`Failed to upload file to S3: ${error.message}`);
    }
  }

  async getObjectStream(key: string): Promise<{ body: any; contentType?: string; contentLength?: number }> {
    const resp = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }));
    return { body: resp.Body as any, contentType: resp.ContentType, contentLength: resp.ContentLength };
  }

  async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({ Bucket: this.bucketName, Key: key });
      await this.s3Client.send(command);
    } catch (error) {
      console.error('Error deleting file from S3:', error);
      throw new Error(`Failed to delete file from S3: ${error.message}`);
    }
  }

  async getSignedUrl(key: string, expiresIn: number = 3600, downloadName?: string): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` } : {}),
      });
      return await getSignedUrl(this.s3Client, command, { expiresIn });
    } catch (error) {
      console.error('Error generating signed URL:', error);
      throw new Error(`Failed to generate signed URL: ${error.message}`);
    }
  }

  async refreshSignedUrl(key: string, expiresIn: number = 3600, downloadName?: string): Promise<string> {
    return await this.getSignedUrl(key, expiresIn, downloadName);
  }
}
