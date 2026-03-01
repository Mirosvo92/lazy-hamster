import { Component, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { AnalysisResult } from '../services/image-upload.service';

@Component({
  selector: 'app-result',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCardModule, MatIconModule],
  templateUrl: './result.component.html',
  styleUrl: './result.component.scss',
})
export class ResultComponent implements OnInit {
  analysis = signal<AnalysisResult | null>(null);
  preview = signal<string | null>(null);

  private projectId = '';

  constructor(
    private readonly router: Router,
    private readonly route: ActivatedRoute,
  ) {}

  ngOnInit(): void {
    this.projectId = this.route.snapshot.paramMap.get('id') ?? '';
    const state = history.state;
    if (state?.analysis) {
      this.analysis.set(state.analysis);
      this.preview.set(state.preview ?? null);
    } else {
      this.router.navigate(['/']);
    }
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  onNext(): void {
    this.router.navigate(['/details', this.projectId], {
      state: { analysis: this.analysis() },
    });
  }
}
