import { FileValidator } from '@nestjs/common';

export interface SmartTypeOptions {
  fileType: RegExp;
  maxSize: number;
}

export class SmartContentValidator extends FileValidator<{
  rules: SmartTypeOptions[];
}> {
  isValid(file?: Express.Multer.File): boolean {
    if (!file) return false;

    const rule = this.validationOptions.rules.find((r) =>
      r.fileType.test(file.originalname),
    );

    if (!rule) return false;

    if (file.size > rule.maxSize) {
      return false;
    }

    return true;
  }

  buildErrorMessage(file: Express.Multer.File): string {
    if (!file) return 'File is required';

    const rule = this.validationOptions.rules.find((r) =>
      r.fileType.test(file.originalname),
    );

    if (!rule) {
      return `File type ${file.mimetype} is not allowed`;
    }

    return `File is too large. Max size for this type is ${rule.maxSize / 1024 / 1024}MB`;
  }
}
