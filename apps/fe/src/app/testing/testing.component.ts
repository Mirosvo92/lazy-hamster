import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';

@Component({
  selector: 'app-testing',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatIconModule, MatSelectModule, MatFormFieldModule],
  templateUrl: './testing.component.html',
  styleUrl: './testing.component.scss',
})
export class TestingComponent {
  testModel = 'gemini-2.5-flash-image';
  testSourceImageUrl = '';
  testPrompt = '';
  testAspectRatio = '3:2';
  testLoading = signal(false);
  testImageUrl = signal<string | null>(null);
  testError = signal<string | null>(null);

  landingPrompt = '';
  landingProductDescription = '';
  landingSellerData = '';
  landingImageUrls = ['', '', '', ''];
  landingLoading = signal(false);
  landingUrl = signal<string | null>(null);
  landingError = signal<string | null>(null);
  landingHtml = signal<string>('');
  landingStreaming = signal(false);

  uxArchitectBrief = '';
  uxArchitectLoading = signal(false);
  uxArchitectResult = signal<string | null>(null);
  uxArchitectError = signal<string | null>(null);

  resizeImageUrl = '';
  resizeSize: '1080x1080' | '1080x1920' | '1920x1080' = '1080x1080';
  resizeLoading = signal(false);
  resizeResult = signal<string | null>(null);
  resizeError = signal<string | null>(null);

  readonly sizePresentations = [
    { value: '1080x1080', label: '1080 × 1080 px — Квадрат (1:1)' },
    { value: '1080x1920', label: '1080 × 1920 px — Вертикаль (9:16)' },
    { value: '1920x1080', label: '1920 × 1080 px — Горизонталь (16:9)' },
  ] as const;

  constructor(private readonly http: HttpClient) {}

  testImageGen(): void {
    if (!this.testSourceImageUrl || !this.testPrompt) {
      this.testError.set('Please provide both image URL and prompt');
      return;
    }

    this.testLoading.set(true);
    this.testImageUrl.set(null);
    this.testError.set(null);

    this.http
      .post<{ imageUrl: string }>('/api/analyze/test-image', {
        model: this.testModel,
        imageUrl: this.testSourceImageUrl,
        prompt: this.testPrompt,
        aspectRatio: this.testAspectRatio || undefined,
      })
      .subscribe({
        next: (res) => {
          this.testLoading.set(false);
          this.testImageUrl.set(res.imageUrl);
        },
        error: (err) => {
          this.testLoading.set(false);
          this.testError.set(err?.error?.message || 'Test failed');
        },
      });
  }

  async streamGenerateLanding(): Promise<void> {
    this.landingStreaming.set(true);
    this.landingHtml.set('');
    this.landingUrl.set(null);
    this.landingError.set(null);

    try {
      const response = await fetch('/api/analyze/generate-landing-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          landingPrompt: this.landingPrompt,
          imageUrls: this.landingImageUrls,
          productDescription: this.landingProductDescription || undefined,
          sellerData: this.landingSellerData || undefined,
        }),
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6)) as { delta?: string; done?: boolean; url?: string; error?: string };

          if (event.delta) {
            this.landingHtml.update(h => h + event.delta);
          }
          if (event.done && event.url) {
            this.landingUrl.set(event.url);
          }
          if (event.error) {
            this.landingError.set(event.error);
          }
        }
      }
    } catch {
      this.landingError.set('Stream failed');
    } finally {
      this.landingStreaming.set(false);
    }
  }

  generateLanding(): void {
    this.landingLoading.set(true);
    this.landingUrl.set(null);
    this.landingError.set(null);

    this.http.post<{ url: string }>('/api/analyze/generate-landing', {
      landingPrompt: this.landingPrompt,
      imageUrls: this.landingImageUrls,
      productDescription: this.landingProductDescription || undefined,
      sellerData: this.landingSellerData || undefined,
    }).subscribe({
      next: (res) => {
        this.landingLoading.set(false);
        this.landingUrl.set(res.url);
      },
      error: (err) => {
        this.landingLoading.set(false);
        this.landingError.set(err?.error?.message || 'Failed to generate landing');
      },
    });
  }

  resizeImage(): void {
    if (!this.resizeImageUrl) return;

    this.resizeLoading.set(true);
    this.resizeResult.set(null);
    this.resizeError.set(null);

    this.http
      .post<{ dataUrl: string }>('/api/analyze/resize-image', {
        imageUrl: this.resizeImageUrl,
        size: this.resizeSize,
      })
      .subscribe({
        next: (res) => {
          this.resizeLoading.set(false);
          this.resizeResult.set(res.dataUrl);
        },
        error: (err) => {
          this.resizeLoading.set(false);
          this.resizeError.set(err?.error?.message || 'Resize failed');
        },
      });
  }

  generateUxArchitect(): void {
    this.uxArchitectLoading.set(true);
    this.uxArchitectResult.set(null);
    this.uxArchitectError.set(null);

    this.http
      .post<{ architecture: string }>('/api/analyze/generate-ux-architect', {
        briefText: this.uxArchitectBrief,
      })
      .subscribe({
        next: (res) => {
          this.uxArchitectLoading.set(false);
          this.uxArchitectResult.set(res.architecture);
        },
        error: (err) => {
          this.uxArchitectLoading.set(false);
          this.uxArchitectError.set(err?.error?.message || 'Failed to generate UX architecture');
        },
      });
  }
}
