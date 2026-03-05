import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Subscription } from 'rxjs';
import { ChatAgentService, ChatEvent } from '../chat/chat-agent.service';
import { LanggraphCompatService } from './langgraph-compat.service';

const ASSISTANT_ID = 'landing-agent';
const NOW = () => new Date().toISOString();

@Controller('')
export class LanggraphCompatController {
    constructor(
        private readonly lgService: LanggraphCompatService,
        private readonly chatAgentService: ChatAgentService,
    ) {}

    @Get('info')
    getInfo() {
        return { version: '0.1.0', graphs: { [ASSISTANT_ID]: {} } };
    }

    @Get('assistants/search')
    searchAssistants() {
        const now = NOW();
        return [
            {
                assistant_id: ASSISTANT_ID,
                graph_id: ASSISTANT_ID,
                name: 'Landing Agent',
                metadata: {},
                config: {},
                created_at: now,
                updated_at: now,
            },
        ];
    }

    @Get('assistants/:id')
    getAssistant(@Param('id') id: string) {
        const now = NOW();
        return {
            assistant_id: id,
            graph_id: id,
            name: 'Landing Agent',
            metadata: {},
            config: {},
            created_at: now,
            updated_at: now,
        };
    }

    @Post('threads')
    createThread() {
        return this.lgService.createThread();
    }

    @Get('threads/:id')
    getThread(@Param('id') id: string) {
        const now = NOW();
        return { thread_id: id, created_at: now, updated_at: now, metadata: {} };
    }

    @Post('threads/:id/runs/stream')
    async streamRun(
        @Param('id') threadId: string,
        @Body() body: Record<string, unknown>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        @Res() res: any,
    ): Promise<void> {
        // Parse input message
        const messages = (
            (body?.input as Record<string, unknown>)?.messages as Array<
                Record<string, unknown>
            >
        ) ?? [];
        const firstMsg = messages[0] ?? {};
        let text = '';
        let imageUrl: string | undefined;

        if (typeof firstMsg.content === 'string') {
            text = firstMsg.content;
        } else if (Array.isArray(firstMsg.content)) {
            for (const part of firstMsg.content as Array<
                Record<string, unknown>
            >) {
                if (part.type === 'text') text = part.text as string;
                else if (part.type === 'image_url') {
                    imageUrl = (
                        (part.image_url as Record<string, unknown>)?.url as string
                    );
                }
            }
        }

        // Store original content (with image_url if present) so values events reflect it
        this.lgService.addHumanMessage(threadId, firstMsg.content as string ?? text);

        // Set up SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.flushHeaders();

        const write = (event: string, data: unknown) => {
            if (!res.writableEnded) {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        };
        const end = () => {
            if (!res.writableEnded) res.end();
        };

        write('metadata', { run_id: randomUUID() });

        let msgBuffer = '';
        let msgId = `msg_${randomUUID()}`;

        let sub: Subscription;
        sub = this.chatAgentService.getSessionEvents(threadId).subscribe({
            next: (raw: MessageEvent) => {
                const event = JSON.parse(raw.data as string) as ChatEvent;
                switch (event.type) {
                    case 'delta':
                        msgBuffer += event.text ?? '';
                        write('messages/partial', [
                            {
                                id: msgId,
                                type: 'AIMessageChunk',
                                content: msgBuffer,
                                additional_kwargs: {},
                            },
                        ]);
                        break;

                    case 'message_end':
                        this.lgService.addAIMessage(threadId, msgBuffer, msgId);
                        write('values', {
                            messages: this.lgService.getMessages(threadId),
                        });
                        msgBuffer = '';
                        msgId = `msg_${randomUUID()}`;
                        break;

                    case 'section_preview': {
                        const content = `[Section: ${event.sectionName}]\n\`\`\`html\n${event.sectionHtml}\n\`\`\``;
                        this.lgService.addAIMessage(threadId, content, msgId);
                        write('messages/partial', [
                            {
                                id: msgId,
                                type: 'AIMessageChunk',
                                content,
                                additional_kwargs: {},
                            },
                        ]);
                        write('values', {
                            messages: this.lgService.getMessages(threadId),
                        });
                        msgId = `msg_${randomUUID()}`;
                        break;
                    }

                    case 'landing_done': {
                        const content = `Landing page ready: ${event.url}`;
                        this.lgService.addAIMessage(threadId, content, msgId);
                        write('messages/partial', [
                            {
                                id: msgId,
                                type: 'AIMessageChunk',
                                content,
                                additional_kwargs: {},
                            },
                        ]);
                        write('values', {
                            messages: this.lgService.getMessages(threadId),
                        });
                        msgId = `msg_${randomUUID()}`;
                        break;
                    }

                    case 'input_required':
                        write('values', {
                            messages: this.lgService.getMessages(threadId),
                        });
                        write('end', null);
                        end();
                        sub.unsubscribe();
                        break;

                    case 'error':
                        write('error', { error: event.message ?? 'Unknown error' });
                        end();
                        sub.unsubscribe();
                        break;

                    case 'quick_replies':
                        this.lgService.addQuickRepliesToLastAI(
                            threadId,
                            event.options ?? [],
                        );
                        write('values', {
                            messages: this.lgService.getMessages(threadId),
                        });
                        break;

                    case 'phase':
                    case 'section_done':
                        // skip
                        break;
                }
            },
            error: (err: Error) => {
                write('error', { error: err.message ?? 'Unknown error' });
                end();
            },
            complete: () => {
                write('end', null);
                end();
            },
        });

        res.on('close', () => sub.unsubscribe());

        // Start / resume agent
        void this.chatAgentService.handleMessageByUrl(threadId, text, imageUrl);
    }

    @Get('threads/:id/state')
    getState(@Param('id') id: string) {
        return this.lgService.getThreadState(id);
    }

    @Post('threads/:id/history')
    getHistory(@Param('id') id: string) {
        const state = this.lgService.getThreadState(id);
        return [state];
    }
}
