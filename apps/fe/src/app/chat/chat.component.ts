import {
  Component,
  signal,
  computed,
  ElementRef,
  ViewChild,
  AfterViewChecked,
  OnInit,
  OnDestroy,
  NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

export type MessageRole = 'user' | 'agent';
export type ChatPhase = 'waiting_image' | 'analyzing' | 'interviewing' | 'generating' | 'done';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text?: string;
  imageUrl?: string;
  loading?: boolean;
  landingUrl?: string;
  sectionPreview?: { name: string; html: string };
}

interface SseEvent {
  type: 'delta' | 'message_end' | 'phase' | 'section_preview' | 'section_done' | 'landing_done' | 'error';
  text?: string;
  phase?: ChatPhase;
  sectionName?: string;
  sectionHtml?: string;
  url?: string;
  message?: string;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent implements OnInit, AfterViewChecked, OnDestroy {
  @ViewChild('messageList') messageListRef!: ElementRef<HTMLDivElement>;

  messages = signal<ChatMessage[]>([]);
  inputText = signal('');
  isTyping = signal(false);
  previewUrl = signal<string | null>(null);
  selectedFile = signal<File | null>(null);
  phase = signal<ChatPhase>('waiting_image');
  landingUrl = signal<string | null>(null);

  phaseLabel = computed(() => {
    const labels: Record<ChatPhase, string> = {
      waiting_image: 'Ожидание фото',
      analyzing: 'Анализ...',
      interviewing: 'Интервью',
      generating: 'Генерация...',
      done: 'Готово',
    };
    return labels[this.phase()];
  });

  canSend = computed(
    () =>
      (this.inputText().trim().length > 0 || this.selectedFile() !== null) &&
      !this.isTyping() &&
      this.phase() !== 'done',
  );

  private sessionId: string | null = null;
  private eventSource: EventSource | null = null;
  private currentAgentMsgId: string | null = null;
  private shouldScroll = false;

  constructor(
    private readonly http: HttpClient,
    private readonly zone: NgZone,
    private readonly sanitizer: DomSanitizer,
  ) {}

  getSafeHtml(html: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  ngOnInit() {
    this.http.post<{ sessionId: string }>('/api/chat/session', {}).subscribe({
      next: ({ sessionId }) => {
        this.sessionId = sessionId;
        this.connectSse(sessionId);
      },
      error: () => this.addAgentMessage('Не удалось подключиться к серверу.'),
    });
  }

  ngOnDestroy() {
    this.eventSource?.close();
  }

  ngAfterViewChecked() {
    if (this.shouldScroll) {
      this.scrollToBottom();
      this.shouldScroll = false;
    }
  }

  // ── SSE ───────────────────────────────────────────────────────────────────

  private connectSse(sessionId: string) {
    this.eventSource = new EventSource(`/api/chat/${sessionId}/events`);

    this.eventSource.onopen = () => {
      this.zone.run(() =>
        this.addAgentMessage('Привет! Загрузи фото товара, и я помогу создать лендинг.'),
      );
    };

    this.eventSource.onmessage = (e: MessageEvent) => {
      this.zone.run(() => this.handleSseEvent(e.data as string));
    };

    this.eventSource.onerror = () => {
      this.zone.run(() => this.isTyping.set(false));
    };
  }

  private handleSseEvent(raw: string) {
    let event: SseEvent;
    try {
      event = JSON.parse(raw) as SseEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case 'delta':
        this.appendAgentToken(event.text ?? '');
        break;

      case 'message_end':
        this.currentAgentMsgId = null;
        this.isTyping.set(false);
        this.shouldScroll = true;
        break;

      case 'phase':
        this.phase.set(event.phase ?? 'waiting_image');
        if (event.phase === 'analyzing' || event.phase === 'generating') {
          this.isTyping.set(true);
        }
        break;

      case 'section_preview':
        if (event.sectionName && event.sectionHtml) {
          const id = `preview-${Date.now()}`;
          this.messages.update((msgs) => [
            ...msgs,
            { id, role: 'agent', sectionPreview: { name: event.sectionName!, html: event.sectionHtml! } },
          ]);
          this.shouldScroll = true;
        }
        break;

      case 'section_done':
        break;

      case 'landing_done':
        this.landingUrl.set(event.url ?? null);
        break;

      case 'error':
        this.addAgentMessage(`Ошибка: ${event.message ?? 'что-то пошло не так'}`);
        this.isTyping.set(false);
        break;
    }
  }

  // ── Send message ──────────────────────────────────────────────────────────

  send() {
    if (!this.canSend() || !this.sessionId) return;

    const text = this.inputText().trim();
    const file = this.selectedFile();

    // Add user message
    this.messages.update((msgs) => [
      ...msgs,
      {
        id: Date.now().toString(),
        role: 'user',
        text: text || undefined,
        imageUrl: this.previewUrl() ?? undefined,
      },
    ]);
    this.inputText.set('');
    this.selectedFile.set(null);
    this.previewUrl.set(null);
    this.isTyping.set(true);
    this.shouldScroll = true;

    const formData = new FormData();
    if (text) formData.append('text', text);
    if (file) formData.append('image', file);

    this.http
      .post(`/api/chat/${this.sessionId}/message`, formData)
      .subscribe({ error: () => this.isTyping.set(false) });
  }

  onEnter(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  // ── File ──────────────────────────────────────────────────────────────────

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.selectedFile.set(file);
    const reader = new FileReader();
    reader.onload = (e) => this.previewUrl.set(e.target?.result as string);
    reader.readAsDataURL(file);
  }

  removeFile() {
    this.selectedFile.set(null);
    this.previewUrl.set(null);
  }

  // ── Message helpers ───────────────────────────────────────────────────────

  private addAgentMessage(text: string) {
    const id = `agent-${Date.now()}`;
    this.messages.update((msgs) => [...msgs, { id, role: 'agent', text }]);
    this.shouldScroll = true;
  }

  private appendAgentToken(token: string) {
    if (!this.currentAgentMsgId) {
      const id = `agent-${Date.now()}`;
      this.currentAgentMsgId = id;
      this.messages.update((msgs) => [...msgs, { id, role: 'agent', text: token }]);
    } else {
      const id = this.currentAgentMsgId;
      this.messages.update((msgs) =>
        msgs.map((m) => (m.id === id ? { ...m, text: (m.text ?? '') + token } : m)),
      );
    }
    this.shouldScroll = true;
  }

  private scrollToBottom() {
    const el = this.messageListRef?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
