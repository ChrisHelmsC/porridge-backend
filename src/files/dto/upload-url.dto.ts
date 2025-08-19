import { IsUrl, IsNotEmpty } from 'class-validator';

export class UploadUrlDto {
  @IsUrl()
  @IsNotEmpty()
  url: string;
}
