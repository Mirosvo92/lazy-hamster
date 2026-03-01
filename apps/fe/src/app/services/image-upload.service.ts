import { Injectable } from '@angular/core';
import { HttpClient, HttpEventType, HttpProgressEvent, HttpResponse } from '@angular/common/http';
import { Observable, map, filter } from 'rxjs';

export interface AnalysisResult {
  brand: string;
  model: string;
  description: string;
  imageUrl: string;
}

export interface UploadProgress {
  type: 'progress' | 'complete';
  progress: number;
  result?: AnalysisResult;
}

@Injectable({ providedIn: 'root' })
export class ImageUploadService {
  constructor(private readonly http: HttpClient) {}

  upload(files: File[], projectId: string): Observable<UploadProgress> {
    const locale = navigator.language || 'en';
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    formData.append('locale', locale);
    formData.append('projectId', projectId);

    return this.http
      .post<AnalysisResult>('/api/upload', formData, {
        reportProgress: true,
        observe: 'events',
      })
      .pipe(
        filter(
          (event): event is HttpProgressEvent | HttpResponse<AnalysisResult> =>
            event.type === HttpEventType.UploadProgress ||
            event.type === HttpEventType.Response,
        ),
        map((event) => {
          if (event.type === HttpEventType.UploadProgress) {
            return {
              type: 'progress' as const,
              progress: event.total
                ? Math.round((100 * event.loaded) / event.total)
                : 0,
            };
          }
          return {
            type: 'complete' as const,
            progress: 100,
            result: (event as HttpResponse<AnalysisResult>).body as AnalysisResult,
          };
        }),
      );
  }
}
