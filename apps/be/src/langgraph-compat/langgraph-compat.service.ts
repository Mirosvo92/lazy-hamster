import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ChatAgentService } from '../chat/chat-agent.service';

export type LGMessageContent =
    | string
    | Array<
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string } }
      >;

export interface LGMessage {
    id: string;
    type: 'human' | 'ai';
    content: LGMessageContent;
    additional_kwargs: Record<string, unknown>;
}

@Injectable()
export class LanggraphCompatService {
    private readonly messagesLog = new Map<string, LGMessage[]>();

    constructor(private readonly chatAgentService: ChatAgentService) {}

    createThread(): {
        thread_id: string;
        created_at: string;
        updated_at: string;
        metadata: Record<string, unknown>;
    } {
        const { sessionId } = this.chatAgentService.createSession();
        this.messagesLog.set(sessionId, []);
        const now = new Date().toISOString();
        return {
            thread_id: sessionId,
            created_at: now,
            updated_at: now,
            metadata: {},
        };
    }

    addHumanMessage(threadId: string, content: LGMessageContent): void {
        const msgs = this.getMessages(threadId);
        msgs.push({
            id: `msg_human_${randomUUID()}`,
            type: 'human',
            content,
            additional_kwargs: {},
        });
    }

    addAIMessage(threadId: string, content: string, msgId: string): void {
        const msgs = this.getMessages(threadId);
        const existing = msgs.find((m) => m.id === msgId);
        if (existing) {
            existing.content = content;
        } else {
            msgs.push({ id: msgId, type: 'ai', content, additional_kwargs: {} });
        }
    }

    getMessages(threadId: string): LGMessage[] {
        if (!this.messagesLog.has(threadId)) {
            this.messagesLog.set(threadId, []);
        }
        return this.messagesLog.get(threadId)!;
    }

    getThreadState(threadId: string) {
        const now = new Date().toISOString();
        return {
            values: { messages: this.getMessages(threadId) },
            next: [],
            metadata: { step: 0 },
            created_at: now,
            checkpoint: {
                checkpoint_id: threadId,
                thread_id: threadId,
                checkpoint_ns: '',
            },
            parent_checkpoint: null,
        };
    }
}
