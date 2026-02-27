import { Component, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CommonModule } from '@angular/common';

const DEFAULT_USER_ID = 'default-user-001';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  creating = signal(false);

  constructor(
    private readonly router: Router,
    private readonly http: HttpClient,
  ) {}

  createProject(): void {
    this.creating.set(true);
    this.http
      .post<{ id: string }>('/api/projects', { userId: DEFAULT_USER_ID })
      .subscribe({
        next: (project) => {
          this.creating.set(false);
          this.router.navigate(['/new-project', project.id]);
        },
        error: () => {
          this.creating.set(false);
        },
      });
  }

  goToProjects(): void {
    this.router.navigate(['/projects']);
  }
}