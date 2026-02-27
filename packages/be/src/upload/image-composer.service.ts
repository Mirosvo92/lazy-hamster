import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

@Injectable()
export class ImageComposerService {
  /**
   * Composes 3 images into a single horizontal composite image
   * @param files - Array of exactly 3 image files
   * @returns Object with composed image buffer and MIME type
   */
  async composeImages(files: Express.Multer.File[]): Promise<{
    buffer: Buffer;
    mimeType: string;
  }> {
    if (files.length !== 3) {
      throw new Error('Exactly 3 images required');
    }

    // Resize each image to 366x366 with cover fit
    const resized = await Promise.all(
      files.map((f) =>
        sharp(f.buffer)
          .resize(366, 366, {
            fit: 'cover',
            position: 'center',
          })
          .toBuffer(),
      ),
    );

    // Compose horizontally into 1098x366 canvas
    const composite = await sharp({
      create: {
        width: 1098,
        height: 366,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        { input: resized[0], left: 0, top: 0 },
        { input: resized[1], left: 366, top: 0 },
        { input: resized[2], left: 732, top: 0 },
      ])
      .jpeg({ quality: 85 })
      .toBuffer();

    return { buffer: composite, mimeType: 'image/jpeg' };
  }

  /**
   * Converts buffer to base64 data URL for OpenAI API
   * @param buffer - Image buffer
   * @param mimeType - MIME type of the image
   * @returns Base64 data URL
   */
  bufferToBase64DataUrl(buffer: Buffer, mimeType: string): string {
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }
}
