import {
  Body,
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AnalyzerService } from '../analyzer/analyzer.service';
import { S3Service } from './s3.service';
import { PrismaService } from '../prisma/prisma.service';
import { ImageComposerService } from './image-composer.service';

const DEFAULT_USER_ID = 'default-user-001';
const DEFAULT_PROJECT_ID = 'default-project-001';

@Controller('upload')
export class UploadController {
  constructor(
    private readonly analyzerService: AnalyzerService,
    private readonly s3Service: S3Service,
    private readonly prisma: PrismaService,
    private readonly imageComposer: ImageComposerService,
  ) {}

  @Post()
  @UseInterceptors(
    FilesInterceptor('files', 3, {
      storage: memoryStorage(),
    }),
  )
  async uploadFile(
    @UploadedFiles(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\// }),
        ],
      }),
    )
    files: Express.Multer.File[],
    @Body('locale') locale?: string,
    @Body('projectId') projectId?: string,
  ) {
    if (files.length !== 3) {
      throw new BadRequestException('Expected exactly 3 images');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: DEFAULT_USER_ID },
    });

    // Compose images into single composite
    const { buffer, mimeType } = await this.imageComposer.composeImages(files);

    // Upload composite and analyze in parallel
    const [s3Result, analysis] = await Promise.all([
      this.s3Service.uploadBuffer(buffer, user.id, mimeType, 'jpg'),
      this.analyzerService.analyze(
        this.imageComposer.bufferToBase64DataUrl(buffer, mimeType),
        locale || 'en',
        user.id,
      ),
    ]);

    return {
      ...analysis,
      imageUrl: s3Result.url,
    };
  }
}
