import type { AxiosResponse } from 'axios';

export type HttpResponse<T> = AxiosResponse<T> | Response;

export function isAxiosResponse<T>(resp: HttpResponse<T>): resp is AxiosResponse<T> {
  return 'data' in resp && 'config' in resp;
}

export interface RestError {
  code?: string;
  message: string;
  details?: Array<{
    code?: string;
    message: string;
  }>;
}

export interface ResponseError {
  status: number;
  statusText: string;
  error: RestError;
}

export async function parseErrorResponse(response: Response): Promise<RestError> {
  try {
    const body = await response.json();
    return {
      code: body.code ?? String(response.status),
      message: body.message ?? response.statusText,
      details: body.details,
    };
  } catch {
    return {
      code: String(response.status),
      message: response.statusText,
    };
  }
}

export function parseAxiosErrorResponse(response: AxiosResponse): RestError {
  const data = response.data as Record<string, unknown> | undefined;
  return {
    code: data?.code as string | undefined ?? String(response.status),
    message: (data?.message as string | undefined) ?? response.statusText,
    details: data?.details as Array<{ code?: string; message: string }> | undefined,
  };
}