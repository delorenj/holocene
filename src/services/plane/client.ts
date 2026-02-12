/**
 * Plane API client for Holocene
 *
 * Security note: API key should be passed server-side.
 * For M1 prototype, we use a proxy or inject via env at build time.
 */

import type { PlaneIssue, PlaneListResponse, PlaneProject } from './types';

export interface PlaneClientConfig {
  baseUrl: string;
  apiKey: string;
  workspace: string;
}

export class PlaneClient {
  private baseUrl: string;
  private apiKey: string;
  private workspace: string;

  constructor(config: PlaneClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.workspace = config.workspace;
  }

  private async fetch<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Plane API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async listProjects(): Promise<PlaneProject[]> {
    const response = await this.fetch<PlaneListResponse<PlaneProject>>(
      `/api/v1/workspaces/${this.workspace}/projects/`
    );
    return response.results;
  }

  async listIssues(
    projectId: string,
    options?: {
      perPage?: number;
      stateGroup?: string;
      priority?: string[];
    }
  ): Promise<PlaneIssue[]> {
    const params = new URLSearchParams();
    params.set('per_page', String(options?.perPage ?? 50));

    if (options?.stateGroup) {
      params.set('state__group', options.stateGroup);
    }

    if (options?.priority?.length) {
      params.set('priority__in', options.priority.join(','));
    }

    const response = await this.fetch<PlaneListResponse<PlaneIssue>>(
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/issues/?${params.toString()}`
    );
    return response.results;
  }

  async listAllActiveIssues(projectIds: string[]): Promise<PlaneIssue[]> {
    const results = await Promise.all(
      projectIds.map((projectId) =>
        this.listIssues(projectId, {
          perPage: 100,
        })
      )
    );
    return results.flat();
  }
}

// Factory for default 33GOD workspace
export function create33GODClient(): PlaneClient {
  // In browser, use proxy to avoid CORS; in Node, could use direct API
  const isDev = typeof window !== 'undefined';
  
  if (isDev) {
    // Use local proxy (no API key needed in client - proxy injects it)
    return new PlaneClient({
      baseUrl: '/api/plane',
      apiKey: '', // Proxy handles auth
      workspace: '33god',
    });
  }

  const apiKey = import.meta.env.VITE_PLANE_33GOD_API_KEY;
  if (!apiKey) {
    throw new Error('VITE_PLANE_33GOD_API_KEY is not set');
  }

  return new PlaneClient({
    baseUrl: 'https://plane.delo.sh',
    apiKey,
    workspace: '33god',
  });
}
