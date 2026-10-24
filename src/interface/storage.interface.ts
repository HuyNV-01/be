import { FileProviderEnum } from 'src/common/enum';
import { Readable } from 'stream';

export interface UploadFileOptions {
  path: string;
  mimeType: string;
  bucket?: string;
  isPublic?: boolean;
  metadata?: Record<string, string>;
  cacheControl?: string;
  contentDisposition?: string;
}

export interface UploadResponse {
  key: string;
  url: string;
  bucket: string;
  provider: FileProviderEnum | string;
  etag?: string;
}

export interface PresignedUploadOptions {
  path: string;
  mimeType: string;
  bucket?: string;
  expiresIn?: number;
  maxSizeBytes?: number;
}

export interface PresignedUploadResponse {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  bucket: string;
  provider: FileProviderEnum | string;
  expiresIn: number;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface DownloadStreamOptions {
  bucket?: string;
  range?: {
    start?: number;
    end?: number;
  };
}

export interface StorageStreamResult {
  stream: Readable;
  contentType: string;
  contentLength?: number;
  contentRange?: string;
  acceptRanges?: string;
  etag?: string;
  lastModified?: Date;
}

export interface StorageObjectMetadata {
  key: string;
  bucket: string;
  size: number;
  mimeType: string;
  etag?: string;
  lastModified?: Date;
}

export interface StorageHealthStatus {
  healthy: boolean;
  provider: FileProviderEnum | string;
  bucket: string;
  latencyMs: number;
  message?: string;
}

export interface IStorageProvider {
  readonly providerName: FileProviderEnum;
  upload(file: Buffer, options: UploadFileOptions): Promise<UploadResponse>;
  uploadStream?(
    stream: Readable,
    options: UploadFileOptions & { contentLength?: number },
  ): Promise<UploadResponse>;
  downloadStream?(path: string, options?: DownloadStreamOptions): Promise<StorageStreamResult>;
  headObject?(path: string, bucket?: string): Promise<StorageObjectMetadata | null>;
  copy?(sourcePath: string, destinationPath: string, bucket?: string): Promise<UploadResponse>;
  delete(path: string, bucket?: string): Promise<void>;
  deleteMany(paths: string[], bucket?: string): Promise<void>;
  getPresignedUrl(path: string, bucket?: string, expiresIn?: number): Promise<string>;
  getPresignedUploadUrl?(options: PresignedUploadOptions): Promise<PresignedUploadResponse>;
  healthCheck?(): Promise<StorageHealthStatus>;
}
