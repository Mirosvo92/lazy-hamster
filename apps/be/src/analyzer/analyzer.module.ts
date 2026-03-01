import { Module } from '@nestjs/common';
import { S3Module } from '../upload/s3.module';
import { AnalyzerController } from './analyzer.controller';
import { AnalyzerService } from './analyzer.service';
import { TestController } from './test.controller';
import { TestService } from './test.service';

@Module({
    imports: [S3Module],
    controllers: [AnalyzerController, TestController],
    providers: [AnalyzerService, TestService],
    exports: [AnalyzerService],
})
export class AnalyzerModule {}
