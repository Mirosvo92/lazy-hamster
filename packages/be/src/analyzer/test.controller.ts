import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TestService } from './test.service';

const DEFAULT_USER_ID = 'default-user-001';

@Controller('analyze')
export class TestController {
  constructor(private readonly testService: TestService) {}

  @Post('test-image')
  async testImage(
    @Body()
    body: {
      model: string;
      imageUrl: string;
      prompt: string;
      aspectRatio?: string;
    },
  ) {
    const resultUrl = await this.testService.testImageGeneration(
      body.model,
      body.imageUrl,
      body.prompt,
      body.aspectRatio,
    );
    return { imageUrl: resultUrl };
  }

  @Post('generate-images')
  async generateImages(
    @Body()
    body: {
      imagePrompts: string[];
      sourceImageUrl: string;
    },
  ) {
    const images = await this.testService.generateImages(
      body.imagePrompts,
      body.sourceImageUrl,
      DEFAULT_USER_ID,
    );
    return { images };
  }

  @Post('generate-landing')
  async generateLanding(
    @Body()
    body: {
      landingPrompt: string;
      imageUrls: [string, string, string, string];
      productDescription?: string;
      sellerData?: string;
    },
  ) {
    return this.testService.generateLanding(
      body.landingPrompt,
      body.imageUrls,
      DEFAULT_USER_ID,
      body.productDescription,
      body.sellerData,
    );
  }

  @Post('generate-landing-stream')
  async generateLandingStream(
    @Body()
    body: {
      landingPrompt: string;
      imageUrls: [string, string, string, string];
      productDescription?: string;
      sellerData?: string;
    },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { url } = await this.testService.generateLandingStream(
        body.landingPrompt,
        body.imageUrls,
        DEFAULT_USER_ID,
        (delta: string) => sendEvent({ delta }),
        body.productDescription,
        body.sellerData,
      );
      sendEvent({ done: true, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stream failed';
      sendEvent({ error: message });
    } finally {
      res.end();
    }
  }

  @Post('generate-ux-architect')
  async generateUxArchitect(@Body() body: { briefText: string }) {
    return this.testService.generateUxArchitect(body.briefText);
  }

  @Post('resize-image')
  async resizeImage(
    @Body() body: { imageUrl: string; size: '1080x1080' | '1080x1920' | '1920x1080' },
  ) {
    return this.testService.resizeImage(body.imageUrl, body.size);
  }
}
