import { Component, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ImageUploadService } from '../services/image-upload.service';
import { TokenService } from '../services/token.service';

@Component({
  selector: 'app-new-project',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  templateUrl: './new-project.component.html',
  styleUrl: './new-project.component.scss',
})
export class NewProjectComponent {
  previews = signal<(string | null)[]>([null, null, null]);
  selectedFiles = signal<(File | null)[]>([null, null, null]);
  uploadedCount = signal<number>(0);
  uploading = signal(false);
  uploadProgress = signal(0);
  error = signal<string | null>(null);
  dragOverSlot = signal<number | null>(null);
  canUpload = computed(() => this.uploadedCount() === 3 && !this.uploading());

  readonly projectId: string;

  constructor(
    private readonly uploadService: ImageUploadService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly tokenService: TokenService,
  ) {
    this.projectId = this.route.snapshot.paramMap.get('id') ?? '';
  }

  onDragOver(event: DragEvent, slotIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOverSlot.set(slotIndex);
  }

  onDragLeave(event: DragEvent, slotIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOverSlot.set(null);
  }

  onDrop(event: DragEvent, slotIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOverSlot.set(null);
    const file = event.dataTransfer?.files[0];
    if (file) this.handleFile(file, slotIndex);
  }

  onFileSelected(event: Event, slotIndex: number): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.handleFile(file, slotIndex);
    input.value = '';
  }

  handleFile(file: File, slotIndex: number): void {
    if (!file.type.startsWith('image/')) {
      this.error.set(`Photo ${slotIndex + 1}: Please select an image`);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      this.error.set(`Photo ${slotIndex + 1}: File size must be under 10 MB`);
      return;
    }

    const existingFiles = this.selectedFiles();
    const duplicateIndex = existingFiles.findIndex(
      (f, idx) => f && idx !== slotIndex && f.name === file.name
    );
    if (duplicateIndex !== -1) {
      this.error.set(`File "${file.name}" already uploaded in Photo ${duplicateIndex + 1}`);
      return;
    }

    this.error.set(null);

    const files = [...this.selectedFiles()];
    files[slotIndex] = file;
    this.selectedFiles.set(files);

    const reader = new FileReader();
    reader.onload = () => {
      const previews = [...this.previews()];
      previews[slotIndex] = reader.result as string;
      this.previews.set(previews);
      this.uploadedCount.set(files.filter((f) => f !== null).length);
    };
    reader.readAsDataURL(file);
  }

  removeFile(slotIndex: number): void {
    const files = [...this.selectedFiles()];
    files[slotIndex] = null;
    this.selectedFiles.set(files);

    const previews = [...this.previews()];
    previews[slotIndex] = null;
    this.previews.set(previews);

    this.uploadedCount.set(files.filter((f) => f !== null).length);
    this.error.set(null);
  }

  onNext(): void {
    const files = this.selectedFiles().filter((f): f is File => f !== null);
    if (files.length !== 3) return;

    this.uploading.set(true);
    this.uploadProgress.set(0);
    this.error.set(null);

    this.uploadService.upload(files, this.projectId).subscribe({
      next: (event) => {
        this.uploadProgress.set(event.progress);
        if (event.type === 'complete' && event.result) {
          this.uploading.set(false);
          this.tokenService.refresh();
          this.router.navigate(['/result', this.projectId], {
            state: { analysis: event.result, preview: event.result.imageUrl },
          });
        }
      },
      error: (err) => {
        this.uploading.set(false);
        this.error.set(err?.error?.message || 'Upload failed');
      },
    });
  }

  reset(): void {
    this.previews.set([null, null, null]);
    this.selectedFiles.set([null, null, null]);
    this.uploadedCount.set(0);
    this.uploading.set(false);
    this.uploadProgress.set(0);
    this.error.set(null);
  }
}