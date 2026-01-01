import { OnQueueActive, OnQueueCompleted, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';

import { MailerService } from '@nestjs-modules/mailer';
import bull from 'bull';
import { envs } from 'src/config/envs';
import { JOB_NAME, QUEUE_NAME } from 'src/constants/queue.constant';

@Processor(QUEUE_NAME.MAIL)
export class MailProcessor {
  private readonly logger = new Logger(MailProcessor.name, { timestamp: true });

  constructor(private readonly mailerService: MailerService) {}

  @Process(JOB_NAME.SEND_WELCOME)
  async handleSendUserWelcome(job: bull.Job<{ email: string; name: string; token: string }>) {
    const label = '[handleSendUserWelcome]';
    const { email, name, token } = job.data;
    this.logger.debug(`${label} - send: ${email}`);
    const activationUrl = `${envs.appUrl}/api/auth/activate?token=${token}`;

    await this.mailerService.sendMail({
      to: email,
      subject: 'Chào mừng bạn đến với Nest App! 🎉',
      template: 'welcome',
      context: {
        name: name,
        url: activationUrl,
      },
    });
  }

  @Process(JOB_NAME.SEND_FORGOT_PASSWORD)
  async handleSendPasswordResetOtp(job: bull.Job<{ email: string; name: string; otp: string }>) {
    const label = '[handleSendPasswordResetOtp]';
    const { email, name, otp } = job.data;
    this.logger.debug(`${label} - send: ${email}`);

    await this.mailerService.sendMail({
      to: email,
      subject: '[Nest App] Mã OTP Đặt lại mật khẩu',
      template: 'reset-password-otp',
      context: {
        name: name,
        otp: otp,
      },
    });
  }

  @OnQueueActive()
  onActive(job: bull.Job) {
    this.logger.debug(`Job ${job.id} starting...`);
  }

  @OnQueueFailed()
  onFailed(job: bull.Job, error: Error) {
    this.logger.error(
      `Job ${job.name} (ID: ${job.id}) failded. Error: ${error.message}`,
      error.stack,
    );
  }

  @OnQueueCompleted()
  onCompleted(job: bull.Job) {
    this.logger.log(`Job ${job.name} (ID: ${job.id}) success.`);
  }
}
