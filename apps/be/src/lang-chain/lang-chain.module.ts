import { Module } from '@nestjs/common';
import { LangChainController } from './lang-chain.controller';
import { LangChainService } from './lang-chain.service';
import { S3Module } from '../upload/s3.module';

@Module({
    imports: [S3Module],
    controllers: [LangChainController],
    providers: [LangChainService],
})
export class LangChainModule {}
