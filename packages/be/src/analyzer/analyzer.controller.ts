import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AnalyzerService } from './analyzer.service';
import { TestService } from './test.service';

const DEFAULT_USER_ID = 'default-user-001';
const DEFAULT_PROJECT_ID = 'default-project-001';

@Controller('analyze')
export class AnalyzerController {
  constructor(
    private readonly analyzerService: AnalyzerService,
    private readonly testService: TestService,
  ) {}

  @Post()
  async analyze(@Body() body: { imageUrl: string; locale?: string; userId?: string }) {
    return this.analyzerService.analyze(body.imageUrl, body.locale ?? 'en', body.userId ?? DEFAULT_USER_ID);
  }

  @Post('generate-questions')
  async generateQuestions(
    @Body()
    body: {
      brand: string;
      model: string;
      description: string;
      locale?: string;
      userId?: string;
    },
  ) {
    const questions = await this.analyzerService.generateQuestions(
      body.brand,
      body.model,
      body.description,
      body.locale ?? 'en',
      body.userId ?? DEFAULT_USER_ID,
    );
    return { questions };
  }

  @Post('generate-image-prompts')
  async generateImagePrompts(
    @Body()
    body: {
      brand: string;
      model: string;
      description: string;
      userId?: string;
      projectId?: string;
      sourceImageUrl?: string;
      analysisData?: string;
    },
  ) {
    const imagePrompts = await this.analyzerService.generateImagePrompts(
      body.brand,
      body.model,
      body.description,
      body.userId ?? DEFAULT_USER_ID,
    );
    if (body.projectId && imagePrompts.length > 0) {
      await this.analyzerService.saveImageGenerationState(
        body.projectId,
        imagePrompts,
        body.sourceImageUrl ?? '',
        body.analysisData ?? '',
      );
    }
    return { imagePrompts };
  }

  @Post('generate-product-image')
  async generateSingleProductImage(
    @Body()
    body: {
      prompt: string;
      sourceImageUrl: string;
      userId?: string;
      projectId?: string;
    },
  ) {
    const image = await this.analyzerService.generateSingleProductImage(
      body.prompt,
      body.sourceImageUrl,
      body.userId ?? DEFAULT_USER_ID,
      body.projectId ?? DEFAULT_PROJECT_ID,
    );
    return { image };
  }

  @Post('generate-landing-prompt')
  async generateLandingPrompt(
    @Body()
    body: {
      analysis: { brand: string; model: string; description: string };
      formAnswers: Record<string, unknown>;
      generatedImageUrls: [string, string, string, string];
      userId?: string;
      projectId?: string;
    },
  ) {
    return this.analyzerService.generateLandingPrompt(
      body.analysis,
      body.formAnswers,
      body.generatedImageUrls,
      body.userId ?? DEFAULT_USER_ID,
      body.projectId,
    );
  }

  @Post('generate-product-images')
  async generateProductImages(
    @Body()
    body: {
      imagePrompts: string[];
      sourceImageUrl: string;
      userId?: string;
      projectId?: string;
    },
  ) {
    const images = await this.analyzerService.generateProductImages(
      body.imagePrompts,
      body.sourceImageUrl,
      body.userId ?? DEFAULT_USER_ID,
      body.projectId ?? DEFAULT_PROJECT_ID,
    );
    return { images };
  }

  @Post('generate-landing')
  async generateLanding(
    @Body()
    body: {
      landingPrompt: string;
      imageUrls: [string, string, string, string];
      userId?: string;
      projectId: string;
      productDescription?: string;
      sellerData?: string;
    },
  ) {
    return this.analyzerService.startLandingGeneration(
      body.landingPrompt,
      body.imageUrls,
      body.userId ?? DEFAULT_USER_ID,
      body.projectId ?? DEFAULT_PROJECT_ID,
      body.productDescription,
      body.sellerData,
    );
  }

  @Get('landing-status/:id')
  async getLandingStatus(@Param('id') id: string) {
    return this.analyzerService.getLandingStatus(id);
  }

  @Patch('landing-status/:id/cancel')
  async cancelLanding(@Param('id') id: string) {
    await this.analyzerService.cancelLanding(id);
    return { ok: true };
  }

  @Post('orders/:landingId')
  async submitOrder(
    @Param('landingId') landingId: string,
    @Body() body: { name: string; email: string; phone: string },
  ) {
    return this.testService.submitOrder(landingId, body.name, body.email, body.phone);
  }
}
