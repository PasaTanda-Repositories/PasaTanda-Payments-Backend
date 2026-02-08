import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { pathToFileURL } from 'node:url';

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
  private readonly qrTestsDir = path.join(process.cwd(), 'tmp', 'qr-tests');
  private readonly fineQrDir = path.join(process.cwd(), 'tmp', 'qr-fine');
  private readonly cropDir = path.join(process.cwd(), 'tmp', 'crop');
  private readonly saveLocally: boolean;
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
  private readonly headlineFontPath = path.join(
    this.assetsDir,
    'fonts',
    'StackSansHeadline.ttf',
  );

  constructor(private readonly configService: ConfigService) {
    this.saveLocally =
      (
        this.configService.get<string>('SAVE_QR_IMAGES_LOCALLY') || ''
      ).toLowerCase() === 'true';
    void this.ensureDirectories();
  }

  private async ensureDirectories(): Promise<void> {
    try {
      if (this.saveLocally) {
        await fs.mkdir(this.qrTestsDir, { recursive: true });
        await fs.mkdir(this.fineQrDir, { recursive: true });
        await fs.mkdir(this.cropDir, { recursive: true });
      }
      await fs.mkdir(this.assetsDir + '/images', { recursive: true });
      await fs.mkdir(this.assetsDir + '/fonts', { recursive: true });
    } catch (error) {
      this.logger.error(
        'Error creating directories',
        error instanceof Error ? error.stack : String(error),
      );
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
    typeOfPayment: string,
  ): Promise<{ ipfsUrl?: string; savedPath?: string; error?: string }> {
    try {
      const qrBuffer = Buffer.from(base64Qr, 'base64');
      const preparedQr = await this.prepareQrImage(qrBuffer);
      const finalImage = await this.generateBrandedImage(
        preparedQr,
        groupName,
        amountBs,
        typeOfPayment,
      );

      const timestamp = Date.now();
      const filename = `qr_${groupName.replace(/\s+/g, '_')}_${timestamp}.png`;
      const savedPath = path.join(this.fineQrDir, filename);
      if (this.saveLocally) {
        await fs.writeFile(savedPath, finalImage);
      }

      const ipfsUrl = await this.uploadToIPFS(finalImage, filename);
      this.logger.log(`📸 QR image processed and uploaded to IPFS: ${ipfsUrl}`);
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
      const cropWidth = 320;
      const cropHeight = 320;
      const offsetX = 15;
      const offsetY = 15;

      const fitsHorizontally = metadata.width >= offsetX + cropWidth;
      const fitsVertically = metadata.height >= offsetY + cropHeight;

      if (fitsHorizontally && fitsVertically) {
        workingBuffer = await sharp(qrBuffer)
          .extract({
            left: offsetX,
            top: offsetY,
            width: cropWidth,
            height: cropHeight,
          })
          .toBuffer();

        // Save the raw cropped QR to tmp/crop for inspection
        if (this.saveLocally) {
          try {
            const cropFilename = `crop_${Date.now()}_${cropWidth}x${cropHeight}.png`;
            const cropPath = path.join(this.cropDir, cropFilename);
            await fs.writeFile(cropPath, workingBuffer);
            this.logger.log(`Saved cropped QR to ${cropPath}`);
          } catch (err) {
            this.logger.warn('Failed to save cropped QR', err as Error);
          }
        }
      } else {
        const minSide = Math.min(metadata.width, metadata.height);
        const fallbackCrop = Math.max(Math.floor(minSide - 32), 0);
        const left = Math.max(
          Math.floor((metadata.width - fallbackCrop) / 2),
          0,
        );
        const top = Math.max(
          Math.floor((metadata.height - fallbackCrop) / 2),
          0,
        );

        if (fallbackCrop > 0) {
          workingBuffer = await sharp(qrBuffer)
            .extract({ left, top, width: fallbackCrop, height: fallbackCrop })
            .toBuffer();

          // Save fallback cropped image as well
          if (this.saveLocally) {
            try {
              const cropFilename = `crop_${Date.now()}_${fallbackCrop}x${fallbackCrop}.png`;
              const cropPath = path.join(this.cropDir, cropFilename);
              await fs.writeFile(cropPath, workingBuffer);
              this.logger.log(`Saved fallback cropped QR to ${cropPath}`);
            } catch (err) {
              this.logger.warn(
                'Failed to save fallback cropped QR',
                err as Error,
              );
            }
          }
        }
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

  private async generateBrandedImage(
    qrBuffer: Buffer,
    groupName: string,
    amountBs: string,
    typeOfPayment: string,
  ): Promise<Buffer> {
    const width = 1080;
    const height = 1080;
    const qrSize = 800;

    const frameSvg = await this.buildFrameSvg(
      width,
      height,
      groupName,
      amountBs,
      typeOfPayment,
    );
    const frameBuffer = await sharp(Buffer.from(frameSvg)).png().toBuffer();

    const qrResized = await sharp(qrBuffer)
      .resize(qrSize, qrSize, {
        fit: 'contain',
        background: '#00000000', // Transparent background
        kernel: sharp.kernel.nearest,
      })
      .png()
      .toBuffer();

    const offset = Math.floor((width - qrSize) / 2);

    return sharp(frameBuffer)
      .composite([{ input: qrResized, left: offset, top: offset }])
      .png()
      .toBuffer();
  }

  private async resolveHeadlineFontUrl(): Promise<string | null> {
    if (await this.fileExists(this.headlineFontPath)) {
      return pathToFileURL(this.headlineFontPath).href;
    }

    this.logger.warn(
      'No se encontró StackSansHeadline.ttf; el overlay usará la fuente por defecto.',
    );
    return null;
  }

  private async buildFrameSvg(
    width: number,
    height: number,
    groupName: string,
    amountBs: string,
    typeOfPayment: string,
  ): Promise<string> {
    const fontUrl = await this.resolveHeadlineFontUrl();
    const safeGroup = this.escapeSvg(groupName);
    const safeAmount = this.escapeSvg(amountBs);
    const safeTypeOfPayment = this.escapeSvg(typeOfPayment);

    const fontFace = fontUrl
      ? `@font-face { font-family: 'StackSansHeadline'; src: url('${fontUrl}') format('truetype'); }`
      : '';

    // Layout configuration
    const margin = 50;
    const cardWidth = width - margin * 2;
    const cardHeight = height - margin * 2;

    // Vertical positions
    const titleY = margin + 70;
    const footerY = height - margin - 30;

    // Side margins for vertical text
    const sideTextMargin = margin + 70;

    return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <style>
                ${fontFace}
                .base { font-family: 'StackSansHeadline', sans-serif; fill: #000; }
                .title { font-size: 55px; font-weight: 900; }
                .side-title { font-size: 55px; font-weight: 900; }
                .footer-text { font-size: 42px; font-weight: 400; }
                .amount-text { font-size: 48px; font-weight: 400; }
            </style>
            <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="8" stdDeviation="15" flood-color="#000000" flood-opacity="0.25"/>
            </filter>
        </defs>
        
        <!-- Background Canvas (Off-white to contrast the card) -->
        <rect width="100%" height="100%" fill="#f4f4f4" />
        
        <!-- Elevated Card with Drop Shadow (rounded corners) -->
        <rect x="${margin}" y="${margin}" width="${cardWidth}" height="${cardHeight}" rx="24" ry="24" fill="#ffffff" filter="url(#shadow)" />

        <!-- Header -->
        <text class="base title" x="${width / 2}" y="${titleY}" text-anchor="middle">PasaTanda</text>
        
        <!-- Left Side Logo -->
        <text class="base side-title" x="${sideTextMargin}" y="${height / 2}" text-anchor="middle" transform="rotate(-90 ${sideTextMargin} ${height / 2})">PasaTanda</text>
        
        <!-- Right Side Logo -->
        <text class="base side-title" x="${width - sideTextMargin}" y="${height / 2}" text-anchor="middle" transform="rotate(90 ${width - sideTextMargin} ${height / 2})">PasaTanda</text>
        
        <!-- Footer -->
        <text class="base footer-text" x="${margin + 50}" y="${footerY}" text-anchor="start">${safeGroup}</text>
        <text class="base amount-text" x="${width / 2}" y="${footerY}" text-anchor="middle">Bs. ${safeAmount}</text>
        <text class="base footer-text" x="${width - margin - 50}" y="${footerY}" text-anchor="end">${safeTypeOfPayment}</text>
      </svg>
    `;
  }

  /**
   * Upload image to IPFS via Pinata Cloud
   */
  private async uploadToIPFS(
    imageBuffer: Buffer,
    filename: string,
  ): Promise<string> {
    type PinataPinResponse = { IpfsHash: string };
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

      const response = await axios.post<PinataPinResponse>(
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
      this.logger.error(
        'Error uploading to IPFS',
        error instanceof Error ? error.stack : String(error),
      );
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
