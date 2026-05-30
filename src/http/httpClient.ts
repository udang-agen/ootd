import type { AxiosResponse } from 'axios';
import type { Credentials } from '../client/types.js';

export interface HttpClientOptions {
  headers?: Record<string, string>;
  queryParams?: Record<string, string | number | boolean | undefined>;
  responseType?: 'json' | 'arraybuffer' | 'blob' | 'stream' | 'text';
  body?: unknown;
  signal?: AbortSignal;
}

let axiosModule: typeof import('axios') | null = null;

async function loadAxios(): Promise<boolean> {
  if (axiosModule !== null) {
    return true;
  }
  try {
    const axios = await import('axios');
    axiosModule = axios;
    return true;
  } catch {
    axiosModule = null;
    return false;
  }
}

function isAxiosInstance(value: unknown): value is typeof import('axios').default {
  return typeof value === 'function' && 'isAxiosError' in (value as unknown as Record<string, unknown>);
}

function encodeQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export class HttpClient {
  private baseUrl: string;
  private credentials?: Credentials;
  private useAxios: boolean = false;

  constructor(config: {
    baseUrl: string;
    credentials?: Credentials;
    httpAgent?: unknown;
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.credentials = config.credentials;

    if (config.httpAgent) {
      if (config.httpAgent === fetch || config.httpAgent === undefined) {
        this.useAxios = false;
      } else if (isAxiosInstance(config.httpAgent)) {
        this.useAxios = true;
      } else {
        this.useAxios = true;
      }
    }
    // If no httpAgent provided, default to fetch - don't try to load axios
  }

  async init(): Promise<void> {
    // Only try to load axios if no explicit httpAgent was provided
    // The default is fetch, so we don't need to load axios
    if (!this.useAxios) {
      return;
    }
    const loaded = await loadAxios();
    if (!loaded) {
      this.useAxios = false;
    }
  }

  private resolveUrl(pathOrUrl: string): string {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      return pathOrUrl;
    }
    const base = this.baseUrl.replace(/\/+$/, '');
    const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return `${base}${path}`;
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.credentials) {
      const encoded = Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }
    return headers;
  }

  private prepareHeaders(options?: HttpClientOptions): Record<string, string> {
    return {
      ...this.getAuthHeaders(),
      ...options?.headers,
    };
  }

  private prepareUrl(pathOrUrl: string, options?: HttpClientOptions): string {
    const resolved = this.resolveUrl(pathOrUrl);
    if (!options?.queryParams || Object.keys(options.queryParams).length === 0) {
      return resolved;
    }
    const filteredParams: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(options.queryParams)) {
      if (value !== undefined) {
        filteredParams[key] = value;
      }
    }
    if (Object.keys(filteredParams).length === 0) {
      return resolved;
    }
    const separator = resolved.includes('?') ? '&' : '?';
    return `${resolved}${separator}${encodeQueryString(filteredParams).slice(1)}`;
  }

  async request<T>(
    method: string,
    url: string,
    options?: HttpClientOptions,
  ): Promise<AxiosResponse<T> | Response> {
    const headers = this.prepareHeaders(options);
    const fullUrl = this.prepareUrl(url, options);

    if (this.useAxios) {
      return this.axiosRequest<T>(method, fullUrl, headers, options);
    }
    return this.fetchRequest<T>(method, fullUrl, headers, options);
  }

  private async axiosRequest<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    options?: HttpClientOptions,
  ): Promise<AxiosResponse<T>> {
    const axios = axiosModule!;
    const isFormData = options?.body instanceof FormData;

    const axiosConfig: Record<string, unknown> = {
      method: method.toLowerCase(),
      url,
      headers,
      responseType: options?.responseType === 'arraybuffer' ? 'arraybuffer' : 'json',
      validateStatus: () => true, // Don't throw on non-2xx
    };

    if (options?.body !== undefined) {
      axiosConfig['data'] = options.body;
      // Let axios auto-detect Content-Type for FormData
      if (!isFormData && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    return axios.default(axiosConfig);
  }

  private async fetchRequest<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    options?: HttpClientOptions,
  ): Promise<Response> {
    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options?.body !== undefined) {
      if (options.body instanceof FormData) {
        fetchOptions.body = options.body;
        // Let fetch set the Content-Type with boundary for FormData
        const ctHeaders = { ...headers };
        delete ctHeaders['Content-Type'];
        fetchOptions.headers = ctHeaders;
      } else if (typeof options.body === 'string') {
        fetchOptions.body = options.body;
      } else {
        fetchOptions.body = JSON.stringify(options.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }
      }
    }

    if (options?.signal) {
      fetchOptions.signal = options.signal;
    }

    return fetch(url, fetchOptions);
  }

  async get<T>(url: string, options?: HttpClientOptions): Promise<AxiosResponse<T> | Response> {
    return this.request<T>('GET', url, options);
  }

  async post<T>(
    url: string,
    body?: unknown,
    options?: HttpClientOptions,
  ): Promise<AxiosResponse<T> | Response> {
    return this.request<T>('POST', url, { ...options, body });
  }

  async put<T>(
    url: string,
    body?: unknown,
    options?: HttpClientOptions,
  ): Promise<AxiosResponse<T> | Response> {
    return this.request<T>('PUT', url, { ...options, body });
  }

  async delete<T>(url: string, options?: HttpClientOptions): Promise<AxiosResponse<T> | Response> {
    return this.request<T>('DELETE', url, options);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getCredentials(): Credentials | undefined {
    return this.credentials;
  }
}