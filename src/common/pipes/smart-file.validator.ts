import { FileValidator } from '@nestjs/common';

import { FileSignatureHelper } from '../helper/file-signature.helper';

export interface SmartTypeOptions {
  fileType: RegExp;
  maxSize: number;
  verifyMagicBytes?: boolean;
}

export class SmartContentValidator extends FileValidator<{
  rules: SmartTypeOptions[];
  errorMessage?: string;
}> {
  isValid(file?: Express.Multer.File): boolean {
    if (!file) return false;

    if (file.buffer && FileSignatureHelper.isExecutableOrDangerous(file.buffer)) {
      return false;
    }

    const rule = this.findMatchingRule(file);
    if (!rule) return false;

    if (file.size > rule.maxSize) {
      return false;
    }

    if (rule.verifyMagicBytes !== false && file.buffer && file.buffer.length > 0) {
      const detected = FileSignatureHelper.detectByMagicBytes(file.buffer, file.originalname);
      if (
        detected.category !== 'unknown' &&
        !rule.fileType.test(detected.ext) &&
        !rule.fileType.test(detected.mime)
      ) {
        return false;
      }
    }

    return true;
  }

  buildErrorMessage(file: Express.Multer.File): string {
    if (!file) return 'File attachment is required';

    if (file.buffer && FileSignatureHelper.isExecutableOrDangerous(file.buffer)) {
      return 'Executable or potentially unsafe files are strictly prohibited!';
    }

    const rule = this.findMatchingRule(file);
    if (!rule) {
      return this.validationOptions.errorMessage || `File type ${file.mimetype} is not allowed`;
    }

    if (file.size > rule.maxSize) {
      return `File is too large! Max allowed size is ${rule.maxSize / 1024 / 1024}MB`;
    }

    return (
      this.validationOptions.errorMessage ||
      'File signature does not match its declared file extension'
    );
  }

  private findMatchingRule(file: Express.Multer.File): SmartTypeOptions | undefined {
    return this.validationOptions.rules.find(
      (r) => r.fileType.test(file.originalname) || r.fileType.test(file.mimetype),
    );
  }
}
