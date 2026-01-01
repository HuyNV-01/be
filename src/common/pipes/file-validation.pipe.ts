import { HttpStatus, ParseFilePipeBuilder, UnprocessableEntityException } from '@nestjs/common';

import { FILE_CONFIG } from 'src/constants/file-validators.constant';

import { SmartContentValidator } from './smart-file.validator';

interface FileValidationOptions {
  required?: boolean;
  maxSize?: number;
  fileType?: RegExp;
  errorMessage?: string;
}

export class FileValidators {
  static Image(options: FileValidationOptions = {}) {
    return FileValidators.buildPipe({
      maxSize: FILE_CONFIG.IMAGE.MAX_SIZE,
      fileType: FILE_CONFIG.IMAGE.MIME_TYPE,
      errorMessage: FILE_CONFIG.IMAGE.ERROR_MSG,
      ...options,
    });
  }

  static Document(options: FileValidationOptions = {}) {
    return FileValidators.buildPipe({
      maxSize: FILE_CONFIG.DOCS.MAX_SIZE,
      fileType: FILE_CONFIG.DOCS.MIME_TYPE,
      errorMessage: FILE_CONFIG.DOCS.ERROR_MSG,
      ...options,
    });
  }

  static Excel(options: FileValidationOptions = {}) {
    return FileValidators.buildPipe({
      maxSize: FILE_CONFIG.EXCEL.MAX_SIZE,
      fileType: FILE_CONFIG.EXCEL.MIME_TYPE,
      errorMessage: FILE_CONFIG.EXCEL.ERROR_MSG,
      ...options,
    });
  }

  static Video(options: FileValidationOptions = {}) {
    return FileValidators.buildPipe({
      maxSize: FILE_CONFIG.VIDEO.MAX_SIZE,
      fileType: FILE_CONFIG.VIDEO.MIME_TYPE,
      errorMessage: FILE_CONFIG.VIDEO.ERROR_MSG,
      ...options,
    });
  }

  static Audio(options: FileValidationOptions = {}) {
    return FileValidators.buildPipe({
      maxSize: FILE_CONFIG.AUDIO.MAX_SIZE,
      fileType: FILE_CONFIG.AUDIO.MIME_TYPE,
      errorMessage: FILE_CONFIG.AUDIO.ERROR_MSG,
      ...options,
    });
  }

  static Message(options: FileValidationOptions = {}) {
    return FileValidators.buildPipe({
      maxSize: FILE_CONFIG.MESSAGE_ATTACHMENT.MAX_SIZE,
      fileType: FILE_CONFIG.MESSAGE_ATTACHMENT.MIME_TYPE,
      errorMessage: FILE_CONFIG.MESSAGE_ATTACHMENT.ERROR_MSG,
      ...options,
    });
  }

  static SmartChat() {
    return new ParseFilePipeBuilder()
      .addValidator(
        new SmartContentValidator({
          rules: [
            {
              fileType: FILE_CONFIG.IMAGE.MIME_TYPE,
              maxSize: FILE_CONFIG.IMAGE.MAX_SIZE,
            },
            {
              fileType: FILE_CONFIG.VIDEO.MIME_TYPE,
              maxSize: FILE_CONFIG.VIDEO.MAX_SIZE,
            },
            {
              fileType: FILE_CONFIG.DOCS.MIME_TYPE,
              maxSize: FILE_CONFIG.DOCS.MAX_SIZE,
            },
          ],
        }),
      )
      .build({
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      });
  }

  static Custom(options: FileValidationOptions & { maxSize: number; fileType: RegExp }) {
    return FileValidators.buildPipe(options);
  }

  private static buildPipe(options: FileValidationOptions & { maxSize: number; fileType: RegExp }) {
    const { required = true, maxSize, fileType, errorMessage = 'Invalid file type' } = options;

    return new ParseFilePipeBuilder()

      .addFileTypeValidator({
        fileType: fileType,
      })

      .addMaxSizeValidator({
        maxSize: maxSize,
        message: (maxSize) => `File is too large! Max allowed size is ${maxSize / 1024 / 1024}MB`,
      })

      .build({
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        fileIsRequired: required,

        exceptionFactory: (error) => {
          if (error.includes('expected type is')) {
            return new UnprocessableEntityException(errorMessage);
          }

          if (error.includes('File is required')) {
            return new UnprocessableEntityException('File attachment is required');
          }

          return new UnprocessableEntityException(error);
        },
      });
  }
}
