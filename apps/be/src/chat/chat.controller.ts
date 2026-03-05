import {
    Body,
    Controller,
    Param,
    Post,
    Sse,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Observable } from 'rxjs';
import { ChatAgentService } from './chat-agent.service';

@Controller('chat')
export class ChatController {
    constructor(private readonly chatService: ChatAgentService) {}

    @Post('session')
    createSession() {
        return this.chatService.createSession();
    }

    @Sse(':sessionId/events')
    events(@Param('sessionId') sessionId: string): Observable<MessageEvent> {
        return this.chatService.getSessionEvents(sessionId);
    }

    @Post(':sessionId/message')
    @UseInterceptors(FileInterceptor('image', { storage: memoryStorage() }))
    async sendMessage(
        @Param('sessionId') sessionId: string,
        @Body('text') text: string,
        @UploadedFile() image?: Express.Multer.File,
    ) {
        void this.chatService.handleMessage(sessionId, text, image);
        return { ok: true };
    }
}
