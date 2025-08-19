import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';

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

  async uploadFile(filePath: string, key: string, contentType: string): Promise<string> {
    try {
      const fileContent = fs.readFileSync(filePath);

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileContent,
        ContentType: contentType,
        // No ACL needed - files are private and accessed via signed URLs
      });

      await this.s3Client.send(command);

      // Return a signed URL instead of public URL
      return await this.getSignedUrl(key, 3600); // 1 hour expiration
    } catch (error) {
      console.error('Error uploading file to S3:', error);
      throw new Error(`Failed to upload file to S3: ${error.message}`);
    }
  }

  async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.s3Client.send(command);
    } catch (error) {
      console.error('Error deleting file from S3:', error);
      throw new Error(`Failed to delete file from S3: ${error.message}`);
    }
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      return await getSignedUrl(this.s3Client, command, { expiresIn });
    } catch (error) {
      console.error('Error generating signed URL:', error);
      throw new Error(`Failed to generate signed URL: ${error.message}`);
    }
  }

  async refreshSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    return await this.getSignedUrl(key, expiresIn);
  }
}
