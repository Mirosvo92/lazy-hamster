import { Component, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AnalysisResult } from '../services/image-upload.service';
import { TokenService } from '../services/token.service';

interface ProjectData {
  id: string;
  landingPrompt: string;
  imagePrompts: string;
  sourceImageUrl: string;
  analysisData: string;
  formAnswers: string;
  imageGenerationStatus: string;
  images: Array<{ url: string; prompt: string | null }>;
  landings: Array<{ id: string; url: string; status: string }>;
}

@Component({
  selector: 'app-prompt',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
  ],
  templateUrl: './prompt.component.html',
  styleUrl: './prompt.component.scss',
})

export class PromptComponent implements OnInit, OnDestroy {
  loading = signal(true);
  loadingStep = signal<'checking' | 'image-prompts' | 'landing-prompt' | null>('checking');
  error = signal<string | null>(null);
  landingPrompt = signal('');
  copied = signal(false);

  generatedImages = signal<{ url: string; prompt: string }[]>([]);
  generatingImages = signal(false);
  canContinueGeneration = signal(false);

  generatingLanding = signal(false);
  landingUrl = signal<string | null>(null);
  landingError = signal<string | null>(null);
  landingStopped = signal(false);

  private analysis: AnalysisResult | null = null;
  private formAnswers: Record<string, unknown> = {};
  private projectId = '';
  private currentLandingId = '';
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private imagesPollTimer: ReturnType<typeof setTimeout> | null = null;

  private imagePromptsForGeneration: string[] = [];
  private sourceImageUrlForGeneration = '';

  constructor(
    private readonly router: Router,
    private readonly http: HttpClient,
    private readonly route: ActivatedRoute,
    private readonly tokenService: TokenService,
  ) {}

  ngOnInit(): void {
    this.projectId = this.route.snapshot.paramMap.get('id') ?? '';

    this.http.get<ProjectData>(`/api/projects/${this.projectId}`).subscribe({
      next: (project) => this.initFromProject(project),
      error: () => this.router.navigate(['/new-project', this.projectId]),
    });
  }

  private initFromProject(project: ProjectData): void {
    const images = project.images.slice(0, 4);
    const landing = project.landings[0];

    // Restore persisted generation state
    if (project.imagePrompts) {
      try { this.imagePromptsForGeneration = JSON.parse(project.imagePrompts); } catch { /* */ }
    }
    if (project.sourceImageUrl) {
      this.sourceImageUrlForGeneration = project.sourceImageUrl;
    }
    if (project.analysisData) {
      try { this.analysis = JSON.parse(project.analysisData) as AnalysisResult; } catch { /* */ }
    }
    if (project.formAnswers) {
      try { this.formAnswers = JSON.parse(project.formAnswers) as Record<string, unknown>; } catch { /* */ }
    }

    if (images.length === 4) {
      this.generatedImages.set(images.map((img) => ({ url: img.url, prompt: img.prompt ?? '' })));

      if (landing?.status === 'completed' && landing.url) {
        if (project.landingPrompt) this.landingPrompt.set(project.landingPrompt);
        this.landingUrl.set(landing.url);
        this.loading.set(false);
        this.loadingStep.set(null);
        return;
      }

      if (landing?.status === 'generating' && landing.id) {
        if (project.landingPrompt) this.landingPrompt.set(project.landingPrompt);
        this.currentLandingId = landing.id;
        this.loading.set(false);
        this.loadingStep.set(null);
        this.generatingLanding.set(true);
        this.pollLandingStatus();
        return;
      }

      if (project.landingPrompt) {
        this.landingPrompt.set(project.landingPrompt);
        this.loading.set(false);
        this.loadingStep.set(null);
        return;
      }

      // Try to generate landing prompt using history state or restored analysis
      const state = history.state;
      if (state?.analysis) this.analysis = state.analysis as AnalysisResult;
      if (state?.formAnswers) this.formAnswers = state.formAnswers as Record<string, unknown>;
      const urls = images.map((img) => img.url) as [string, string, string, string];
      this.loading.set(false);
      this.loadingStep.set(null);
      this.generateLandingPrompt(urls);
      return;
    }

    if (images.length > 0 || project.imageGenerationStatus === 'generating') {
      // Partial or in-progress — show what we have and poll/continue
      this.generatedImages.set(images.map((img) => ({ url: img.url, prompt: img.prompt ?? '' })));
      this.loading.set(false);
      this.loadingStep.set(null);

      if (project.imageGenerationStatus === 'generating') {
        // Backend is still generating — resume polling
        this.generatingImages.set(true);
        this.pollImageGenerationStatus();
      } else if (this.imagePromptsForGeneration.length > 0 && this.sourceImageUrlForGeneration) {
        this.canContinueGeneration.set(true);
      }
      return;
    }

    // No images yet — check if prompts are saved (page refresh before any image generated)
    if (project.imageGenerationStatus === 'generating') {
      this.loading.set(false);
      this.loadingStep.set(null);
      this.generatingImages.set(true);
      this.pollImageGenerationStatus();
      return;
    }

    if (this.imagePromptsForGeneration.length > 0 && this.sourceImageUrlForGeneration) {
      this.loading.set(false);
      this.loadingStep.set(null);
      this.canContinueGeneration.set(true);
      return;
    }

    // No state at all — run fresh generation from history state
    this.initFromState();
  }

  private initFromState(): void {
    const state = history.state;
    if (!state?.analysis || !state?.formAnswers) {
      this.router.navigate(['/new-project', this.projectId]);
      return;
    }
    this.analysis = state.analysis as AnalysisResult;
    this.formAnswers = state.formAnswers as Record<string, unknown>;
    this.generate();
  }

  private generate(): void {
    if (!this.analysis) return;

    this.loadingStep.set('image-prompts');

    this.http
      .post<{ imagePrompts: string[] }>('/api/analyze/generate-image-prompts', {
        brand: this.analysis.brand,
        model: this.analysis.model,
        description: this.analysis.description,
        projectId: this.projectId,
        sourceImageUrl: this.analysis.imageUrl,
        analysisData: JSON.stringify(this.analysis),
        formAnswers: JSON.stringify(this.formAnswers),
      })
      .subscribe({
        next: (res) => {
          this.tokenService.refresh();
          this.imagePromptsForGeneration = res.imagePrompts;
          this.sourceImageUrlForGeneration = this.analysis!.imageUrl;
          this.loading.set(false);
          this.loadingStep.set(null);
          this.startImageGenerationJob();
        },
        error: (err) => {
          this.error.set(err?.error?.message || 'Failed to generate image prompts. Please try again.');
          this.loading.set(false);
          this.loadingStep.set(null);
        },
      });
  }

  private startImageGenerationJob(): void {
    this.generatingImages.set(true);
    this.http
      .post('/api/analyze/start-image-generation', { projectId: this.projectId })
      .subscribe({
        next: () => this.pollImageGenerationStatus(),
        error: (err) => {
          this.error.set(err?.error?.message || 'Failed to start image generation. Please try again.');
          this.generatingImages.set(false);
        },
      });
  }

  private pollImageGenerationStatus(): void {
    this.imagesPollTimer = setTimeout(() => {
      this.http
        .get<{ status: string; images: { url: string; prompt: string }[] }>(
          `/api/analyze/image-generation-status/${this.projectId}`,
        )
        .subscribe({
          next: (res) => {
            // Add any new images that arrived since last poll
            const current = this.generatedImages();
            if (res.images.length > current.length) {
              this.generatedImages.set(res.images);
              this.tokenService.refresh();
            }

            if (res.status === 'completed') {
              this.generatingImages.set(false);
              const all = this.generatedImages();
              if (all.length === 4) {
                const urls = all.map((img) => img.url) as [string, string, string, string];
                this.generateLandingPrompt(urls);
              }
            } else if (res.status === 'failed') {
              this.generatingImages.set(false);
              this.error.set('Image generation failed. Please try again.');
            } else {
              this.pollImageGenerationStatus();
            }
          },
          error: () => this.pollImageGenerationStatus(),
        });
    }, 3000);
  }

  continueGeneration(): void {
    this.canContinueGeneration.set(false);
    this.startImageGenerationJob();
  }

  private generateLandingPrompt(imageUrls: [string, string, string, string]): void {
    if (!this.analysis) return;

    this.loadingStep.set('landing-prompt');

    this.http
      .post<{ landingPrompt: string }>('/api/analyze/generate-landing-prompt', {
        analysis: this.analysis,
        formAnswers: this.formAnswers,
        generatedImageUrls: imageUrls,
        projectId: this.projectId,
      })
      .subscribe({
        next: (res) => {
          this.tokenService.refresh();
          this.landingPrompt.set(res.landingPrompt);
          this.loadingStep.set(null);
        },
        error: (err) => {
          this.error.set(err?.error?.message || 'Failed to generate landing prompt. Please try again.');
          this.loadingStep.set(null);
        },
      });
  }

  async copyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.landingPrompt());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // ignore
    }
  }

  goBack(): void {
    this.router.navigate(['/details'], {
      state: { analysis: this.analysis },
    });
  }

  goHome(): void {
    this.router.navigate(['/']);
  }

  openSettingLanding(): void {
    // route will be added later
  }

  downloadImage(url: string): void {
    this.http.get(url, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = url.split('/').pop() || 'image.webp';
        a.click();
        URL.revokeObjectURL(objectUrl);
      },
      error: () => window.open(url, '_blank'),
    });
  }

  downloadLanding(): void {
    const url = this.landingUrl();
    if (!url) return;
    this.http.get(url, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = url.split('/').pop() || 'landing.html';
        a.click();
        URL.revokeObjectURL(objectUrl);
      },
      error: () => window.open(url, '_blank'),
    });
  }

  generateLandingPage(): void {
    if (this.generatedImages().length !== 4) return;

    this.generatingLanding.set(true);
    this.landingError.set(null);

    const imageUrls = this.generatedImages().map(img => img.url) as [string, string, string, string];

    let sellerData = '';
    if (Object.keys(this.formAnswers).length > 0) {
      sellerData = 'SELLER DATA:\n';
      for (const [key, value] of Object.entries(this.formAnswers)) {
        if (key === 'customScripts' || key === 'addCookies') continue;
        const displayValue = Array.isArray(value)
          ? value.join(', ')
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
        sellerData += `${key}: ${displayValue}\n`;
      }
    }

    const customScripts = typeof this.formAnswers['customScripts'] === 'string'
      ? this.formAnswers['customScripts']
      : undefined;

    const addCookies = this.formAnswers['addCookies'] === true;

    this.http
      .post<{ landingId: string }>('/api/analyze/generate-landing', {
        landingPrompt: this.landingPrompt(),
        imageUrls,
        projectId: this.projectId,
        productDescription: this.analysis?.description,
        sellerData,
        customScripts,
        addCookies: addCookies || undefined,
      })
      .subscribe({
        next: (res) => {
          this.currentLandingId = res.landingId;
          this.pollLandingStatus();
        },
        error: (err) => {
          this.landingError.set(err?.error?.message || 'Failed to start landing generation. Please try again.');
          this.generatingLanding.set(false);
        },
      });
  }

  private pollLandingStatus(): void {
    this.pollTimer = setTimeout(() => {
      this.http
        .get<{ status: string; url?: string }>(`/api/analyze/landing-status/${this.currentLandingId}`)
        .subscribe({
          next: (res) => {
            if (res.status === 'completed' && res.url) {
              this.tokenService.refresh();
              this.landingUrl.set(res.url);
              this.generatingLanding.set(false);
            } else if (res.status === 'failed') {
              this.landingError.set('Landing generation failed. Please try again.');
              this.generatingLanding.set(false);
            } else if (res.status === 'cancelled') {
              this.generatingLanding.set(false);
            } else {
              this.pollLandingStatus();
            }
          },
          error: () => this.pollLandingStatus(),
        });
    }, 4000);
  }

  stopLandingGeneration(): void {
    this.clearPollTimer();
    this.http
      .patch(`/api/analyze/landing-status/${this.currentLandingId}/cancel`, {})
      .subscribe();
    this.generatingLanding.set(false);
    this.landingStopped.set(true);
    this.currentLandingId = '';
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.imagesPollTimer !== null) {
      clearTimeout(this.imagesPollTimer);
      this.imagesPollTimer = null;
    }
  }

  ngOnDestroy(): void {
    this.clearPollTimer();
  }
}
