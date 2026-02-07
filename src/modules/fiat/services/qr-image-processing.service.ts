import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import FormData from 'form-data';

/**
 * QR Image Processing Service
 *
 * Processes bank QR codes with the following steps:
 * 1. Normalize the QR (crop and resize)
 * 2. Add centered logo (pasatandalogoqr.png)
 * 3. Place the QR over the template background (template.png)
 * 4. Overlay footer text (group + amount)
 * 5. Upload to IPFS via Pinata and store locally for inspection
 */
@Injectable()
export class QrImageProcessingService {
  private readonly logger = new Logger(QrImageProcessingService.name);
  private readonly tmpDir = path.join(process.cwd(), 'tmp', 'qr-tests');
  private readonly assetsDir = path.join(process.cwd(), 'assets');
  private readonly logoPath = path.join(
    this.assetsDir,
    'images',
    'pasatandalogoqr.png',
  );
  private readonly templatePath = path.join(
    this.assetsDir,
    'images',
    'template.png',
  );

  constructor(private readonly configService: ConfigService) {
    this.ensureDirectories();
  }

  private async ensureDirectories(): Promise<void> {
    try {
      await fs.mkdir(this.tmpDir, { recursive: true });
      await fs.mkdir(this.assetsDir + '/images', { recursive: true });
      await fs.mkdir(this.assetsDir + '/fonts', { recursive: true });
    } catch (error) {
      this.logger.error('Error creating directories', error);
    }
  }

  private async fileExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private escapeSvg(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Process QR image from base64:
   * - Normalize and resize the QR
   * - Add centered logo
   * - Compose with the template background and footer text
   */
  async processQrImage(
    base64Qr: string,
    groupName: string,
    amountBs: string,
  ): Promise<{ ipfsUrl?: string; savedPath?: string; error?: string }> {
    try {
      const qrBuffer = Buffer.from(base64Qr, 'base64');
      const preparedQr = await this.prepareQrImage(qrBuffer);
      const finalImage = await this.composeWithTemplate(
        preparedQr,
        groupName,
        amountBs,
      );

      const timestamp = Date.now();
      const filename = `qr_${groupName.replace(/\s+/g, '_')}_${timestamp}.png`;
      const savedPath = path.join(this.tmpDir, filename);
      await fs.writeFile(savedPath, finalImage);

      const ipfsUrl = await this.uploadToIPFS(finalImage, filename);

      return { ipfsUrl, savedPath };
    } catch (error) {
      this.logger.error('Error processing QR image', error);
      return {
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async prepareQrImage(qrBuffer: Buffer): Promise<Buffer> {
    const metadata = await sharp(qrBuffer).metadata();
    let workingBuffer = qrBuffer;

    if (metadata.width && metadata.height) {
      const minSide = Math.min(metadata.width, metadata.height);
      const cropSize = Math.max(Math.floor(minSide - 32), 0);
      const left = Math.max(Math.floor((metadata.width - cropSize) / 2), 0);
      const top = Math.max(Math.floor((metadata.height - cropSize) / 2), 0);

      if (cropSize > 0) {
        workingBuffer = await sharp(qrBuffer)
          .extract({ left, top, width: cropSize, height: cropSize })
          .toBuffer();
      }
    }

    const resized = await sharp(workingBuffer)
      .resize(900, 900, {
        fit: 'contain',
        background: '#fff',
        kernel: sharp.kernel.nearest,
      })
      .png()
      .toBuffer();

    return this.addCenterLogo(resized);
  }

  private async addCenterLogo(qrBuffer: Buffer): Promise<Buffer> {
    if (!(await this.fileExists(this.logoPath))) {
      return qrBuffer;
    }

    const meta = await sharp(qrBuffer).metadata();
    const qrSize = Math.min(meta.width ?? 900, meta.height ?? 900);
    const logoSize = Math.floor(qrSize * 0.22);

    const logo = await sharp(this.logoPath)
      .resize(logoSize, logoSize, { fit: 'contain' })
      .png()
      .toBuffer();

    const offset = Math.floor((qrSize - logoSize) / 2);

    return sharp(qrBuffer)
      .composite([
        {
          input: logo,
          left: offset,
          top: offset,
        },
      ])
      .png()
      .toBuffer();
  }

  private async composeWithTemplate(
    qrBuffer: Buffer,
    groupName: string,
    amountBs: string,
  ): Promise<Buffer> {
    if (!(await this.fileExists(this.templatePath))) {
      return this.buildFallbackTemplate(qrBuffer, groupName, amountBs);
    }

    const template = sharp(this.templatePath);
    const metadata = await template.metadata();
    const width = metadata.width ?? 1080;
    const height = metadata.height ?? 1080;
    const qrSize = Math.floor(Math.min(width, height) * 0.72);

    const qrWithSize = await sharp(qrBuffer)
      .resize(qrSize, qrSize, {
        fit: 'contain',
        background: '#fff',
        kernel: sharp.kernel.nearest,
      })
      .png()
      .toBuffer();

    const composed = await template
      .composite([
        {
          input: qrWithSize,
          left: Math.max(Math.floor((width - qrSize) / 2), 0),
          top: Math.max(Math.floor((height - qrSize) / 2), 0),
        },
      ])
      .png()
      .toBuffer();

    return this.overlayQrFooter(composed, groupName, amountBs);
  }

  private async overlayQrFooter(
    baseImage: Buffer,
    groupName: string,
    amountBs: string,
  ): Promise<Buffer> {
    const metadata = await sharp(baseImage).metadata();
    const width = metadata.width ?? 1080;
    const height = metadata.height ?? 1080;
    const footerSvg = this.buildFooterSvg(width, height, groupName, amountBs);

    return sharp(baseImage)
      .composite([
        {
          input: Buffer.from(footerSvg),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
  }

  private buildFooterSvg(
    width: number,
    height: number,
    groupName: string,
    amountBs: string,
  ): string {
    const safeGroup = this.escapeSvg(groupName);
    const safeAmount = this.escapeSvg(amountBs);
    const y = height - 50;

    return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <style>
          .footer { font: 38px 'Helvetica Neue', Arial, sans-serif; font-weight: 600; fill: #000; }
          .amount { font: 38px 'Helvetica Neue', Arial, sans-serif; font-weight: 700; fill: #000; }
        </style>
        <text x="${Math.floor(width * 0.12)}" y="${y}" text-anchor="start" class="footer">${safeGroup}</text>
        <text x="${Math.floor(width * 0.5)}" y="${y}" text-anchor="middle" class="amount">Bs. ${safeAmount}</text>
      </svg>
    `;
  }

  private async buildFallbackTemplate(
    qrBuffer: Buffer,
    groupName: string,
    amountBs: string,
  ): Promise<Buffer> {
    const qrPng = await sharp(qrBuffer).png().toBuffer();
    const qrDataUrl = `data:image/png;base64,${qrPng.toString('base64')}`;
    const safeGroup = this.escapeSvg(groupName);
    const safeAmount = this.escapeSvg(amountBs);

    const svg = `
      <svg width="1200" height="1400" viewBox="0 0 1200 1400" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <style>
            .title { font: 62px 'Helvetica Neue', Arial, sans-serif; font-weight: 700; fill: #000; }
            .label { font: 44px 'Helvetica Neue', Arial, sans-serif; font-weight: 500; fill: #000; }
          </style>
        </defs>
        <rect width="1200" height="1400" fill="#fff" />
        <text x="600" y="120" text-anchor="middle" class="title">PasaTanda</text>
        <image href="${qrDataUrl}" x="170" y="200" width="860" height="860" preserveAspectRatio="xMidYMid meet" />
        <text x="140" y="1250" text-anchor="start" class="label">${safeGroup}</text>
        <text x="600" y="1250" text-anchor="middle" class="label">Bs. ${safeAmount}</text>
      </svg>
    `;

    return sharp(Buffer.from(svg)).png().toBuffer();
  }


  /**
   * Upload image to IPFS via Pinata Cloud
   */
  private async uploadToIPFS(
    imageBuffer: Buffer,
    filename: string,
  ): Promise<string> {
    const apiKey = this.configService.get<string>('IPFS_API_KEY');
    const apiSecret = this.configService.get<string>('IPFS_API_SECRET');
    const groupId = this.configService.get<string>('IPFS_GROUP_ID');

    if (!apiKey || !apiSecret) {
      throw new Error('IPFS credentials not configured');
    }

    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename,
        contentType: 'image/png',
      });

      // Add metadata
      const metadata = JSON.stringify({
        name: filename,
        keyvalues: {
          type: 'qr_payment',
          timestamp: Date.now().toString(),
        },
      });
      formData.append('pinataMetadata', metadata);

      // Add to group if specified
      if (groupId) {
        const options = JSON.stringify({
          groupId,
        });
        formData.append('pinataOptions', options);
      }

      const response = await axios.post(
        'https://api.pinata.cloud/pinning/pinFileToIPFS',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            pinata_api_key: apiKey,
            pinata_secret_api_key: apiSecret,
          },
          maxBodyLength: Infinity,
        },
      );

      const ipfsHash = response.data.IpfsHash;
      return `https://gateway.pinata.cloud/ipfs/${ipfsHash}`;
    } catch (error) {
      this.logger.error('Error uploading to IPFS', error);
      throw error;
    }
  }

  /**
   * Get default QR link when generation fails
   */
  getDefaultQrLink(): string {
    return (
      this.configService.get<string>('DEFAULT_QR_IPFS_LINK') ||
      'https://gateway.pinata.cloud/ipfs/QmDefault'
    );
  }
}
