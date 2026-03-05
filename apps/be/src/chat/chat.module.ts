import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatAgentService } from './chat-agent.service';
import { S3Module } from '../upload/s3.module';

@Module({
    imports: [S3Module],
    controllers: [ChatController],
    providers: [ChatAgentService],
    exports: [ChatAgentService],
})
export class ChatModule {}
