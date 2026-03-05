import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { LanggraphCompatController } from './langgraph-compat.controller';
import { LanggraphCompatService } from './langgraph-compat.service';

@Module({
    imports: [ChatModule],
    controllers: [LanggraphCompatController],
    providers: [LanggraphCompatService],
})
export class LanggraphCompatModule {}
