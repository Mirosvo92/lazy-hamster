import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./home/home.component').then((m) => m.HomeComponent),
  },
  {
    path: 'new-project/:id',
    loadComponent: () =>
      import('./new-project/new-project.component').then((m) => m.NewProjectComponent),
  },
  {
    path: 'result/:id',
    loadComponent: () =>
      import('./result/result.component').then((m) => m.ResultComponent),
  },
  {
    path: 'details/:id',
    loadComponent: () =>
      import('./details/details.component').then((m) => m.DetailsComponent),
  },
  {
    path: 'prompt/:id',
    loadComponent: () =>
      import('./prompt/prompt.component').then((m) => m.PromptComponent),
  },
  {
    path: 'testing',
    loadComponent: () =>
      import('./testing/testing.component').then((m) => m.TestingComponent),
  },
];
