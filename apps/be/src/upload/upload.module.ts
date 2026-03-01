import { Module } from '@nestjs/common';
import { AnalyzerModule } from '../analyzer/analyzer.module';
import { ImageComposerService } from './image-composer.service';
import { S3Module } from './s3.module';
import { UploadController } from './upload.controller';

@Module({
    imports: [AnalyzerModule, S3Module],
    controllers: [UploadController],
    providers: [ImageComposerService],
})
export class UploadModule {}
