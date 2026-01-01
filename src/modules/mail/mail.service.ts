import { InjectQueue } from '@nestjs/bull';
import { BadRequestException, HttpStatus, Injectable, Logger } from '@nestjs/common';

import bull from 'bull';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { JOB_NAME, QUEUE_NAME } from 'src/constants/queue.constant';

@Injectable()
export class MailService {
  constructor(@InjectQueue(QUEUE_NAME.MAIL) private mailQueue: bull.Queue) {}
  private readonly logger = new Logger(MailService.name, { timestamp: true });

  async sendUserWelcome(payload: { email: string; name: string; token: string }) {
    try {
      await this.mailQueue.add(JOB_NAME.SEND_WELCOME, payload);
    } catch (error) {
      this.logger.error(`ERROR queue: ${error}`);
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.EMAIL.ERROR,
        code: HTTP_RESPONSE.EMAIL.ERROR,
      });
    }
  }

  async sendPasswordResetOtp(payload: { email: string; name: string; otp: string }) {
    try {
      await this.mailQueue.add(JOB_NAME.SEND_FORGOT_PASSWORD, payload);
    } catch (error) {
      this.logger.error(`ERROR queue: ${error}`);
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.EMAIL.ERROR,
        code: HTTP_RESPONSE.EMAIL.ERROR,
      });
    }
  }
}
