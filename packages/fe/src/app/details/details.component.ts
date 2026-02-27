import { Component, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { AnalysisResult } from '../services/image-upload.service';
import { TokenService } from '../services/token.service';

export interface Question {
  id: string;
  label: string;
  type: 'chips' | 'chips_with_input' | 'select' | 'textarea' | 'number' | 'text';
  required: boolean;
  placeholder?: string;
  suggestions?: string[];
  options?: string[];
  defaultValue?: string | number;
  singleSelect?: boolean;
}

@Component({
  selector: 'app-details',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatChipsModule,
    MatIconModule,
  ],
  templateUrl: './details.component.html',
  styleUrl: './details.component.scss',
})
export class DetailsComponent implements OnInit {
  analysis = signal<AnalysisResult | null>(null);
  questions = signal<Question[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  brand = '';
  model = '';
  shortDescription = '';

  private projectId = '';

  answers: Record<string, any> = {};
  chipSelections: Record<string, Set<string>> = {};
  customChipInputs: Record<string, string> = {};
  chipInputValues: Record<string, Record<string, string>> = {};

  constructor(
    private readonly router: Router,
    private readonly http: HttpClient,
    private readonly route: ActivatedRoute,
    private readonly tokenService: TokenService,
  ) {}

  ngOnInit(): void {
    this.projectId = this.route.snapshot.paramMap.get('id') ?? '';
    const state = history.state;
    if (!state?.analysis) {
      this.router.navigate(['/']);
      return;
    }

    this.analysis.set(state.analysis);
    this.brand = state.analysis.brand ?? '';
    this.model = state.analysis.model ?? '';
    this.shortDescription = state.analysis.description ?? '';
    this.loadQuestions(state.analysis);
  }

  private loadQuestions(analysis: AnalysisResult): void {
    const locale = navigator.language || 'en';

    this.http
      .post<{ questions: Question[] }>('/api/analyze/generate-questions', {
        brand: analysis.brand,
        model: analysis.model,
        description: analysis.description,
        locale,
      })
      .subscribe({
        next: (res) => {
          this.tokenService.refresh();
          this.questions.set(res.questions);
          res.questions.forEach((q) => {
            if (q.type === 'chips' || q.type === 'chips_with_input') {
              this.chipSelections[q.id] = new Set();
              // Set default value for chips if provided
              if (q.defaultValue && typeof q.defaultValue === 'string') {
                this.chipSelections[q.id].add(q.defaultValue);
              }
            }
            if (q.type === 'chips_with_input') {
              this.chipInputValues[q.id] = {};
            }
          });
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(err?.error?.message || 'Failed to load questions. Please try again.');
          this.loading.set(false);
        },
      });
  }

  toggleChip(questionId: string, value: string): void {
    const set = this.chipSelections[questionId];
    const question = this.questions().find((q) => q.id === questionId);

    if (set.has(value)) {
      set.delete(value);
      if (this.chipInputValues[questionId]) {
        delete this.chipInputValues[questionId][value];
      }
    } else {
      // If singleSelect is enabled, clear previous selections
      if (question?.singleSelect) {
        set.clear();
        if (this.chipInputValues[questionId]) {
          this.chipInputValues[questionId] = {};
        }
      }
      set.add(value);
      if (this.chipInputValues[questionId]) {
        this.chipInputValues[questionId][value] = '';
      }
    }
  }

  isChipSelected(questionId: string, value: string): boolean {
    return this.chipSelections[questionId]?.has(value) ?? false;
  }

  getSelectedChips(questionId: string): string[] {
    return Array.from(this.chipSelections[questionId] || []);
  }

  addCustomChip(questionId: string): void {
    const value = this.customChipInputs[questionId]?.trim();
    if (!value) return;

    const q = this.questions().find((q) => q.id === questionId);
    if (q && !q.suggestions?.includes(value)) {
      q.suggestions = [...(q.suggestions || []), value];
    }
    this.chipSelections[questionId].add(value);
    if (this.chipInputValues[questionId]) {
      this.chipInputValues[questionId][value] = '';
    }
    this.customChipInputs[questionId] = '';
  }

  onCustomChipKeydown(event: KeyboardEvent, questionId: string): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.addCustomChip(questionId);
    }
  }

  isFormValid(): boolean {
    if (!this.brand.trim() || !this.model.trim()) return false;

    for (const q of this.questions()) {
      if (!q.required) continue;

      if (q.type === 'chips' || q.type === 'chips_with_input') {
        if (!this.chipSelections[q.id]?.size) return false;
      } else {
        const val = this.answers[q.id];
        if (val === undefined || val === null || val === '') return false;
      }
    }

    return true;
  }

  goBack(): void {
    this.router.navigate(['/result'], {
      state: { analysis: this.analysis() },
    });
  }

  onSubmit(): void {
    const result: Record<string, any> = {
      ...this.answers,
      brand: this.brand,
      model: this.model,
      shortDescription: this.shortDescription,
    };

    for (const [qId, set] of Object.entries(this.chipSelections)) {
      if (set.size > 0) {
        if (this.chipInputValues[qId]) {
          result[qId] = this.chipInputValues[qId];
        } else {
          result[qId] = Array.from(set);
        }
      }
    }

    this.router.navigate(['/prompt', this.projectId], {
      state: {
        analysis: this.analysis(),
        formAnswers: result,
      },
    });
  }
}
