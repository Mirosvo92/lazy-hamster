import { Module } from '@nestjs/common';
import { AnalyzerController } from './analyzer.controller';
import { AnalyzerService } from './analyzer.service';
import { TestController } from './test.controller';
import { TestService } from './test.service';
import { S3Module } from '../upload/s3.module';

@Module({
  imports: [S3Module],
  controllers: [AnalyzerController, TestController],
  providers: [AnalyzerService, TestService],
  exports: [AnalyzerService],
})
export class AnalyzerModule {}
