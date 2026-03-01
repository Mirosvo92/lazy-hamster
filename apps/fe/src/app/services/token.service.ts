import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

const USER_ID = 'default-user-001';

@Injectable({ providedIn: 'root' })
export class TokenService {
  balance = signal<number | null>(null);

  constructor(private readonly http: HttpClient) {
    this.refresh();
  }

  refresh(): void {
    this.http
      .get<{ balance: number }>(`/api/users/${USER_ID}/balance`)
      .subscribe({ next: (res) => this.balance.set(res.balance) });
  }
}
