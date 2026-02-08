import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { GenerateQrDto } from './dto/generate-qr.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { FiatBrowserService } from './services/fiat-browser.service';
import { WebhookService } from './services/webhook.service';
import { TwoFactorRequiredError } from './errors/two-factor-required.error';
import { JobQueueService } from './services/job-queue.service';
import { QrImageProcessingService } from './services/qr-image-processing.service';
@Injectable()
export class FiatAutomationService {
  private readonly logger = new Logger(FiatAutomationService.name);

  constructor(
    private readonly browserService: FiatBrowserService,
    private readonly webhookService: WebhookService,
    private readonly jobQueueService: JobQueueService,
    private readonly qrImageProcessingService: QrImageProcessingService,
  ) {}

  async processGenerateQr(dto: GenerateQrDto): Promise<void> {
    try {
      const qrBase64 = await this.browserService.generateQr(
        dto.amount,
        dto.details,
      );
      const processedQr = await this.qrImageProcessingService.processQrImage(
        qrBase64,
        dto.details,
        dto.amount.toString(),
        dto.typeOfPayment,
      );
      const ipfsLink =
        processedQr.ipfsUrl ?? this.qrImageProcessingService.getDefaultQrLink();

      if (!processedQr.ipfsUrl) {
        this.logger.warn(
          'No se obtuvo URL de IPFS, enviando enlace de respaldo',
        );
      }

      await this.webhookService.sendQrGenerated(dto.orderId, ipfsLink);
    } catch (error) {
      await this.handleAutomationError(error);
      throw error;
    }
  }

  async generateQrWithTimeout(
    amount: number,
    details: string,
    orderId: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const registered = this.jobQueueService.tryRegisterQrJob(orderId, details);
    if (!registered) {
      throw new ConflictException(
        `Ya existe un QR en proceso o generado para la orden "${orderId}" o glosa "${details}"`,
      );
    }

    const task = this.jobQueueService.enqueue(() =>
      this.browserService.generateQr(amount, details),
    );

    try {
      return await this.withTimeout(task, timeoutMs);
    } catch (error) {
      await this.handleAutomationError(error);
      return null;
    }
  }

  async processVerifyPayment(dto: VerifyPaymentDto): Promise<void> {
    try {
      const success = await this.browserService.verifyPayment(dto.details);
      await this.webhookService.sendVerificationResult(dto.orderId, success);
    } catch (error) {
      await this.handleAutomationError(error);
      throw error;
    }
  }

  async verifyPaymentInline(
    dto: VerifyPaymentDto,
    timeoutMs: number,
  ): Promise<boolean> {
    const task = this.jobQueueService.enqueue(() =>
      this.browserService.verifyPayment(dto.details),
    );

    try {
      const result = await this.withTimeout(task, timeoutMs);
      return Boolean(result);
    } catch (error) {
      await this.handleAutomationError(error);
      return false;
    }
  }

  private async handleAutomationError(error: unknown): Promise<void> {
    if (error instanceof TwoFactorRequiredError) {
      await this.webhookService.sendTwoFactorRequired();
      return;
    }

    if (error instanceof Error) {
      this.logger.error(
        `Fiat automation failed: ${error.message}`,
        error.stack,
      );
      return;
    }

    try {
      this.logger.error(`Fiat automation failed: ${JSON.stringify(error)}`);
    } catch {
      this.logger.error(`Fiat automation failed: ${String(error)}`);
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T | null> {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      ),
    ]);
  }
}
