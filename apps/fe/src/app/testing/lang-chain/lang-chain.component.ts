import { Component, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

@Component({
  selector: 'app-lang-chain',
  standalone: true,
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  templateUrl: './lang-chain.component.html',
  styleUrl: './lang-chain.component.scss',
})
export class LangChainComponent {
  prompt = signal('');
  loading = signal(false);
  url = signal<string | null>(null);
  safeUrl = signal<SafeResourceUrl | null>(null);

  constructor(
    private readonly http: HttpClient,
    private readonly sanitizer: DomSanitizer,
  ) {}

  generate() {
    const p = this.prompt().trim();
    if (!p) return;
    this.loading.set(true);
    this.url.set(null);
    this.safeUrl.set(null);
    this.http
      .post<{ url: string }>('/api/langChain-testing/generate', { prompt: p })
      .subscribe({
        next: (res) => {
          this.url.set(res.url);
          this.safeUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(res.url));
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }
}
