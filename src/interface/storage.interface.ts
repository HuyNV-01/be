export interface UploadFileOptions {
  path: string;
  mimeType: string;
  bucket?: string;
  isPublic?: boolean;
}

export interface UploadResponse {
  key: string;
  url: string;
  bucket: string;
  provider: string;
}

export interface IStorageProvider {
  upload(file: Buffer, options: UploadFileOptions): Promise<UploadResponse>;
  delete(path: string, bucket?: string): Promise<void>;
  deleteMany(paths: string[], bucket?: string): Promise<void>;
  getPresignedUrl(path: string, bucket?: string): Promise<string>;
}
