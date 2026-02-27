import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { AnalyzerModule } from '../analyzer/analyzer.module';
import { S3Module } from './s3.module';
import { ImageComposerService } from './image-composer.service';

@Module({
  imports: [AnalyzerModule, S3Module],
  controllers: [UploadController],
  providers: [ImageComposerService],
})
export class UploadModule {}
