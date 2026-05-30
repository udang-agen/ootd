import type { AxiosResponse } from 'axios';
import type {
  Linkable,
  Feed,
  Document,
  Content,
} from '../types/linkable.js';
import type {
  ContentDownloadOptions,
  ContentsFeed,
} from '../types/content-retrieval.js';
import type {
  MultipartMetadata,
  UploadContentOptions,
  CheckInOptions,
} from '../types/content-upload.js';
import {
  CSRF_HEADER_CONSTANTS,
} from '../types/csrf.js';
import {
  LINK_REL_PRIMARY_CONTENT,
  LINK_REL_CONTENT_MEDIA,
  LINK_REL_CONTENTS,
  LINK_REL_CHECKOUT,
  LINK_REL_CANCEL_CHECKOUT,
  LINK_REL_CHECKIN_NEXT_MAJOR,
  LINK_REL_CHECKIN_NEXT_MINOR,
  LINK_REL_DELETE,
  LINK_REL_EDIT_MEDIA,
} from '../types/link-relations.js';
import { getDocumentumFormat, getExtensionFromFilename } from '../types/format-mapper.js';
import type { HttpResponse } from '../http/typeGuards.js';
import {
  isAxiosResponse,
  parseErrorResponse,
  parseAxiosErrorResponse,
} from '../http/typeGuards.js';
import { HttpClient } from '../http/httpClient.js';
import type { DocumentumClientConfig, FeedOptions, SingleOptions } from './types.js';

/**
 * Parses a JSON response body from either an AxiosResponse or a fetch Response.
 */
async function parseJsonBody<T>(response: HttpResponse<T>): Promise<T> {
  if (isAxiosResponse(response)) {
    return response.data as T;
  }
  return response.json() as Promise<T>;
}

/**
 * Extracts response body as ArrayBuffer from either response type.
 */
async function parseArrayBuffer(response: HttpResponse<unknown>): Promise<ArrayBuffer> {
  if (isAxiosResponse(response)) {
    return response.data as ArrayBuffer;
  }
  return response.arrayBuffer();
}

/**
 * Converts ArrayBuffer to Blob.
 */
function arrayBufferToBlob(buffer: ArrayBuffer, contentType?: string): Blob {
  return new Blob([buffer], { type: contentType ?? 'application/octet-stream' });
}

/**
 * Builds a multipart/form-data body for content uploads.
 * Creates a FormData object with metadata part and binary content part.
 */
function buildMultipartBody(
  metadata: MultipartMetadata,
  content: Blob | Buffer,
  filename: string,
): FormData {
  const formData = new FormData();

  // Metadata part as JSON blob
  const metadataBlob = new Blob(
    [JSON.stringify(metadata)],
    { type: 'application/vnd.emc.documentum+json' },
  );
  formData.append('metadata', metadataBlob);

  // Binary content part
  const contentBlob = content instanceof Blob
    ? content
    : new Blob([content as BlobPart], { type: 'application/octet-stream' });
  formData.append('binary', contentBlob, filename);

  return formData;
}

/**
 * Finds a link with the given rel in a Linkable resource.
 * @throws If no link with the given rel is found.
 */
function findLinkOrThrow(resource: Linkable, rel: string): string {
  if (!resource.links || resource.links.length === 0) {
    throw new Error(`Resource has no links array`);
  }
  const link = resource.links.find((l) => l.rel === rel);
  if (!link) {
    throw new Error(`No link found with rel "${rel}"`);
  }
  return link.href;
}

/**
 * Finds a link with the given rel in a Linkable resource, returning undefined if not found.
 */
function findLinkOptional(resource: Linkable, rel: string): string | undefined {
  if (!resource.links) return undefined;
  const link = resource.links.find((l) => l.rel === rel);
  return link?.href;
}

export class DocumentumClient {
  private httpClient: HttpClient;
  private repository: string;
  private config: DocumentumClientConfig;

  // CSRF state
  private currentClientToken?: string;
  private currentCsrfHeaderName?: string;
  private currentCsrfToken?: string;

  // Request queue for serialization
  private requestQueue: Promise<void> = Promise.resolve();
  private csrfEnabled: boolean;

  constructor(config: DocumentumClientConfig) {
    this.config = config;
    this.repository = config.repository;
    this.csrfEnabled = config.enableCsrfProtection ?? true;

    this.httpClient = new HttpClient({
      baseUrl: config.baseUrl,
      credentials: config.credentials,
      httpAgent: config.httpAgent,
    });
  }

  private csrfState(): TokenExtractionResult {
    return {
      clientToken: this.currentClientToken,
      csrfHeaderName: this.currentCsrfHeaderName,
      csrfToken: this.currentCsrfToken,
    };
  }

  /**
   * Initialize the client (load axios if needed).
   */
  async init(): Promise<void> {
    await this.httpClient.init();
  }

  // ────────────────────────────────────────
  // Request Queue
  // ────────────────────────────────────────

  /**
   * Enqueues an operation on the serialized request queue.
   * When CSRF protection is disabled, the operation runs immediately.
   */
  private async enqueueRequest<T>(
    operation: () => Promise<HttpResponse<T>>,
  ): Promise<HttpResponse<T>> {
    if (!this.csrfEnabled) {
      return operation();
    }

    const resultPromise = this.requestQueue.then(async () => {
      const result = await operation();
      return result;
    });

    this.requestQueue = resultPromise.then(() => {}, () => {});

    return resultPromise;
  }

  // ────────────────────────────────────────
  // CSRF Token Management
  // ────────────────────────────────────────

  /**
   * Attaches CSRF tokens to outgoing request headers.
   */
  private attachCsrfTokens(headers: Record<string, string>): void {
    if (this.currentClientToken) {
      headers[CSRF_HEADER_CONSTANTS.CLIENT_TOKEN_HEADER] = this.currentClientToken;
    }
    if (this.currentCsrfHeaderName && this.currentCsrfToken) {
      headers[this.currentCsrfHeaderName] = this.currentCsrfToken;
    }
  }

  /**
   * Creates the CSRF hooks object for the HttpClient.
   */
  private createCsrfHooks() {
    return {
      attachTokens: (headers: Record<string, string>) => this.attachCsrfTokens(headers),
      extractTokens: (_response: Response | AxiosResponse) => {
        // We handle token extraction via the response processing in enqueueRequest
        return this.csrfState();
      },
    };
  }

  /**
   * Updates CSRF token state from an HTTP response.
   */
  private updateTokensFromResponse(response: HttpResponse<unknown>): void {
    const getHeader = (name: string): string | null | undefined => {
      if (isAxiosResponse(response)) {
        const val = (response.headers as Record<string, string | string[]>)[name.toLowerCase()] ?? response.headers[name as keyof typeof response.headers];
        if (val === undefined || val === null) return null;
        return Array.isArray(val) ? val.join(', ') : String(val);
      }
      // fetch Response
      if (name.toLowerCase() === 'set-cookie') {
        // Multiple Set-Cookie headers are joined with comma in Headers API
        // But we need the raw values
        const allHeaders = response.headers as unknown as Record<string, string>;
        const raw = allHeaders['set-cookie'] ?? allHeaders['Set-Cookie'];
        return raw ?? null;
      }
      return response.headers.get(name);
    };

    const result = this.extractTokensFromHeaders(getHeader);
    if (result.clientToken !== undefined) this.currentClientToken = result.clientToken;
    if (result.csrfHeaderName !== undefined) this.currentCsrfHeaderName = result.csrfHeaderName;
    if (result.csrfToken !== undefined) this.currentCsrfToken = result.csrfToken;
  }

  /**
   * Extract client token and CSRF token information from response headers.
   */
  private extractTokensFromHeaders(
    getHeader: (name: string) => string | null | undefined,
  ): TokenExtractionResult {
    const result: TokenExtractionResult = {};

    // Extract client token from Set-Cookie
    const setCookie = getHeader('set-cookie');
    if (setCookie) {
      result.clientToken = this.extractClientTokenFromSetCookie(setCookie);
    }

    // Extract CSRF header name
    const csrfHeaderName = getHeader('documentum-csrf-header-name');
    if (csrfHeaderName) {
      result.csrfHeaderName = csrfHeaderName;
      // Extract the CSRF token from the header identified by csrfHeaderName
      const csrfToken = getHeader(csrfHeaderName.toLowerCase());
      if (csrfToken) {
        result.csrfToken = csrfToken;
      }
    }

    return result;
  }

  /**
   * Parse the DOCUMENTUM-CLIENT-TOKEN from a Set-Cookie header string.
   * Compatible with RFC 6265 and the Java client's expected format.
   */
  private extractClientTokenFromSetCookie(setCookie: string): string | undefined {
    const cookies = setCookie.split(',').map((c) => c.trim());
    for (const cookieStr of cookies) {
      const parts = cookieStr.split(';');
      const firstPart = parts[0]?.trim();
      if (!firstPart) continue;
      const eqIndex = firstPart.indexOf('=');
      if (eqIndex === -1) continue;
      const name = firstPart.substring(0, eqIndex).trim();
      if (name === CSRF_HEADER_CONSTANTS.CLIENT_TOKEN_COOKIE) {
        let value = firstPart.substring(eqIndex + 1).trim();
        // Java client reference behavior: strip after first comma
        const commaIndex = value.indexOf(',');
        if (commaIndex !== -1) {
          value = value.substring(0, commaIndex);
        }
        return value || undefined;
      }
    }
    return undefined;
  }

  /**
   * Internal request helper that wraps the HttpClient call with CSRF token management.
   * This is the core method that all public methods use.
   */
  private async request<T>(
    method: string,
    url: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      queryParams?: Record<string, string | number | boolean | undefined>;
      responseType?: 'json' | 'arraybuffer' | 'blob' | 'stream' | 'text';
      signal?: AbortSignal;
    },
  ): Promise<HttpResponse<T>> {
    return this.enqueueRequest(async () => {
      // Prepare headers with CSRF tokens
      if (this.csrfEnabled) {
        const csrfHeaders: Record<string, string> = {};
        this.attachCsrfTokens(csrfHeaders);

        // Merge CSRF headers into the existing headers
        if (options?.headers) {
          Object.assign(options.headers, csrfHeaders);
        } else {
          (options ??= {}).headers = csrfHeaders;
        }
      }

      let response: HttpResponse<T>;
      switch (method.toUpperCase()) {
        case 'GET':
          response = await this.httpClient.get<T>(url, {
            headers: options?.headers,
            queryParams: options?.queryParams as Record<string, string | number | boolean | undefined>,
            responseType: options?.responseType,
            signal: options?.signal,
          });
          break;
        case 'POST':
          response = await this.httpClient.post<T>(url, options?.body, {
            headers: options?.headers,
            queryParams: options?.queryParams as Record<string, string | number | boolean | undefined>,
            responseType: options?.responseType,
            signal: options?.signal,
          });
          break;
        case 'PUT':
          response = await this.httpClient.put<T>(url, options?.body, {
            headers: options?.headers,
            queryParams: options?.queryParams as Record<string, string | number | boolean | undefined>,
            responseType: options?.responseType,
            signal: options?.signal,
          });
          break;
        case 'DELETE':
          response = await this.httpClient.delete<T>(url, {
            headers: options?.headers,
            queryParams: options?.queryParams as Record<string, string | number | boolean | undefined>,
            responseType: options?.responseType,
            signal: options?.signal,
          });
          break;
        default:
          throw new Error(`Unsupported HTTP method: ${method}`);
      }

      // Update CSRF tokens from response
      this.updateTokensFromResponse(response);

      // If the response indicates an error, create a structured error
      await this.checkErrorResponse(response);

      return response;
    });
  }

  /**
   * Checks if the response is an error and throws if so.
   */
  private async checkErrorResponse(response: HttpResponse<unknown>): Promise<void> {
    if (isAxiosResponse(response)) {
      if (response.status >= 400) {
        const error = parseAxiosErrorResponse(response);
        throw Object.assign(new Error(error.message), {
          status: response.status,
          statusText: response.statusText,
          error,
        });
      }
    } else {
      if (!response.ok) {
        const error = await parseErrorResponse(response);
        throw Object.assign(new Error(error.message), {
          status: response.status,
          statusText: response.statusText,
          error,
        });
      }
    }
  }

  // ────────────────────────────────────────
  // HATEOAS Navigation Helpers
  // ────────────────────────────────────────

  /**
   * Follows a single link relation from a resource.
   * @param resource The resource containing the links.
   * @param rel The link relation name to follow.
   * @param options Optional query parameters for the request.
   * @returns The HTTP response containing the target resource.
   */
  async followLink<T extends Linkable>(
    resource: Linkable,
    rel: string,
    options?: SingleOptions,
  ): Promise<HttpResponse<T>> {
    const href = findLinkOrThrow(resource, rel);
    const queryParams = this.singleOptionsToParams(options);
    return this.request<T>('GET', href, { queryParams });
  }

  /**
   * Follows a link relation that returns a feed of resources.
   * @param resource The resource containing the links.
   * @param rel The link relation name to follow.
   * @param options Optional feed query parameters for the request.
   * @returns The HTTP response containing the feed of resources.
   */
  async followLinks<T extends Linkable>(
    resource: Linkable,
    rel: string,
    options?: FeedOptions,
  ): Promise<HttpResponse<Feed<T>>> {
    const href = findLinkOrThrow(resource, rel);
    const queryParams = this.feedOptionsToParams(options);
    return this.request<Feed<T>>('GET', href, { queryParams });
  }

  // ────────────────────────────────────────
  // Paging Helpers
  // ────────────────────────────────────────

  /**
   * Navigates to the next page of a feed.
   */
  async nextPage<T extends Linkable>(feed: Feed<T>): Promise<HttpResponse<Feed<T>>> {
    const href = findLinkOrThrow(feed, 'next');
    return this.request<Feed<T>>('GET', href);
  }

  /**
   * Navigates to the previous page of a feed.
   */
  async previousPage<T extends Linkable>(feed: Feed<T>): Promise<HttpResponse<Feed<T>>> {
    const href = findLinkOrThrow(feed, 'previous');
    return this.request<Feed<T>>('GET', href);
  }

  /**
   * Navigates to the first page of a feed.
   */
  async firstPage<T extends Linkable>(feed: Feed<T>): Promise<HttpResponse<Feed<T>>> {
    const href = findLinkOrThrow(feed, 'first');
    return this.request<Feed<T>>('GET', href);
  }

  /**
   * Navigates to the last page of a feed.
   */
  async lastPage<T extends Linkable>(feed: Feed<T>): Promise<HttpResponse<Feed<T>>> {
    const href = findLinkOrThrow(feed, 'last');
    return this.request<Feed<T>>('GET', href);
  }

  // ────────────────────────────────────────
  // Content Retrieval
  // ────────────────────────────────────────

  /**
   * Gets the feed of content renditions for a document.
   * @param doc The document or any Linkable resource with a `contents` link.
   * @returns The contents feed.
   */
  async getContents(doc: Linkable): Promise<HttpResponse<ContentsFeed>> {
    const href = findLinkOrThrow(doc, LINK_REL_CONTENTS);
    return this.request<ContentsFeed>('GET', href);
  }

  /**
   * Downloads the primary content of a document as a Blob.
   * Uses two-step traversal: primary-content link → content-media link → binary data.
   * @param doc The document or Linkable resource with a `primary-content` link.
   * @param options Download options including media-url-policy.
   * @returns The binary content as a Blob wrapped in an HttpResponse-compatible structure.
   */
  async getPrimaryContent(
    doc: Linkable,
    options?: ContentDownloadOptions,
  ): Promise<HttpResponse<Blob>> {
    const primaryContentHref = findLinkOrThrow(doc, LINK_REL_PRIMARY_CONTENT);

    const queryParams: Record<string, string | boolean | undefined> = {};
    if (options?.mediaUrlPolicy) {
      queryParams['media-url-policy'] = options.mediaUrlPolicy;
    } else {
      queryParams['media-url-policy'] = 'LOCAL';
    }

    // Step 1: GET the primary-content resource to discover the content-media link
    const primaryResponse = await this.request<unknown>('GET', primaryContentHref, {
      queryParams,
    });

    // Parse the response to find the content-media link
    const body = await parseJsonBody(primaryResponse);

    let contentMediaHref: string | undefined;

    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;

      // Check for a links array
      if (Array.isArray(obj.links)) {
        const contentMediaLink = (obj.links as Array<{ rel: string; href: string }>)
          .find((l) => l.rel === LINK_REL_CONTENT_MEDIA);
        if (contentMediaLink) {
          contentMediaHref = contentMediaLink.href;
        }
      }

      // Also check for entries (if it's a feed/contents resource)
      if (!contentMediaHref && Array.isArray(obj.entries)) {
        for (const entry of obj.entries as Array<Record<string, unknown>>) {
          if (Array.isArray(entry.links)) {
            const contentMediaLink = (entry.links as Array<{ rel: string; href: string }>)
              .find((l) => l.rel === LINK_REL_CONTENT_MEDIA);
            if (contentMediaLink) {
              contentMediaHref = contentMediaLink.href;
              break;
            }
          }
        }
      }

      // Check for a top-level content-media link in entries' content
      if (!contentMediaHref && Array.isArray(obj.entries)) {
        for (const entry of obj.entries as Array<Record<string, unknown>>) {
          const content = entry.content as Record<string, unknown> | undefined;
          if (content?.src) {
            contentMediaHref = content.src as string;
            break;
          }
        }
      }
    }

    if (!contentMediaHref) {
      throw new Error('No content-media link found in primary-content response');
    }

    // Step 2: GET the content-media href to download the binary content
    const binaryResponse = await this.request<ArrayBuffer>('GET', contentMediaHref, {
      responseType: 'arraybuffer',
    });

    // Convert the binary response to a Blob
    const buffer = await parseArrayBuffer(binaryResponse);
    const contentType = isAxiosResponse(binaryResponse)
      ? ((binaryResponse.headers as Record<string, string>)['content-type'] ?? 'application/octet-stream')
      : (binaryResponse.headers.get('content-type') ?? 'application/octet-stream');

    const blob = arrayBufferToBlob(buffer, contentType);

    // Wrap the blob in a structure that looks like an HttpResponse
    // For fetch responses, we create a synthetic Response-like object
    return new Response(blob, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': contentType },
    }) as HttpResponse<Blob>;
  }

  // ────────────────────────────────────────
  // Content Upload
  // ────────────────────────────────────────

  /**
   * Uploads content (adds a new rendition) to a document.
   * POST to the `contents` link relation with multipart/form-data body.
   * @param doc The document or Linkable resource with a `contents` link.
   * @param content The binary content to upload.
   * @param contentType The MIME type of the content.
   * @param options Upload options (format, appendProperties).
   * @param filename Optional filename for the content (used for format detection and multipart).
   * @returns The created Content resource.
   */
  async uploadContent(
    doc: Linkable,
    content: Blob | Buffer,
    contentType: string,
    options?: UploadContentOptions,
    filename?: string,
  ): Promise<HttpResponse<Content>> {
    const href = findLinkOrThrow(doc, LINK_REL_CONTENTS);

    // Determine format
    let format: string | undefined = options?.format;
    if (!format && filename) {
      const ext = getExtensionFromFilename(filename);
      if (ext) {
        format = getDocumentumFormat(ext);
      }
    }

    const queryParams: Record<string, string | boolean | undefined> = {};
    if (format) {
      queryParams['format'] = format;
    }

    // Build multipart metadata
    const metadata: MultipartMetadata = {
      properties: {},
    };

    if (filename) {
      const nameWithoutExt = filename.lastIndexOf('.') > 0
        ? filename.substring(0, filename.lastIndexOf('.'))
        : filename;
      metadata.properties.object_name = nameWithoutExt;
    }

    // Build the multipart body
    const multipartBody = buildMultipartBody(
      metadata,
      content,
      filename ?? 'content',
    );

    return this.request<Content>('POST', href, {
      body: multipartBody,
      queryParams,
    });
  }

  /**
   * Updates (replaces) the content of a document.
   * PUT to the `edit-media` link relation.
   * @param doc The document or Linkable resource with an `edit-media` link.
   * @param content The new binary content.
   * @param contentType The MIME type of the content.
   * @param options Upload options (format).
   * @param filename Optional filename for format detection.
   * @returns The updated Content resource.
   */
  async updateContent(
    doc: Linkable,
    content: Blob | Buffer,
    contentType: string,
    options?: UploadContentOptions,
    filename?: string,
  ): Promise<HttpResponse<Content>> {
    const href = findLinkOrThrow(doc, LINK_REL_EDIT_MEDIA);

    // Determine format
    let format: string | undefined = options?.format;
    if (!format && filename) {
      const ext = getExtensionFromFilename(filename);
      if (ext) {
        format = getDocumentumFormat(ext);
      }
    }

    const queryParams: Record<string, string | boolean | undefined> = {};
    if (format) {
      queryParams['format'] = format;
    }

    // Build multipart body similar to upload
    const multipartBody = buildMultipartBody(
      { properties: {} },
      content,
      filename ?? 'content',
    );

    return this.request<Content>('PUT', href, {
      body: multipartBody,
      queryParams,
    });
  }

  // ────────────────────────────────────────
  // Version Management
  // ────────────────────────────────────────

  /**
   * Checks out a document.
   * PUT to the `checkout` link relation.
   * @param doc The document to check out.
   * @returns The checked-out document.
   */
  async checkout(doc: Linkable): Promise<HttpResponse<Document>> {
    const href = findLinkOrThrow(doc, LINK_REL_CHECKOUT);
    return this.request<Document>('PUT', href);
  }

  /**
   * Cancels a checkout on a document.
   * DELETE to the `cancel-checkout` link relation.
   * @param doc The document to cancel checkout for.
   */
  async cancelCheckout(doc: Linkable): Promise<HttpResponse<void>> {
    const href = findLinkOrThrow(doc, LINK_REL_CANCEL_CHECKOUT);
    return this.request<void>('DELETE', href);
  }

  /**
   * Checks in a document as the next major version.
   * POST to the `checkin-next-major` link relation.
   * Supports both metadata-only checkin (JSON body) and checkin with new content (multipart).
   * @param doc The document to check in.
   * @param properties Optional properties to update during checkin.
   * @param content Optional new binary content.
   * @param contentType The MIME type of the new content (required if content is provided).
   * @param options Checkin options.
   * @param filename Optional filename for format detection.
   * @returns The checked-in document.
   */
  async checkinNextMajor(
    doc: Linkable,
    properties?: Record<string, unknown>,
    content?: Blob | Buffer,
    contentType?: string,
    options?: CheckInOptions,
    filename?: string,
  ): Promise<HttpResponse<Document>> {
    const href = findLinkOrThrow(doc, LINK_REL_CHECKIN_NEXT_MAJOR);

    return this.checkinRequest(href, properties, content, contentType, options, filename);
  }

  /**
   * Checks in a document as the next minor version.
   * POST to the `checkin-next-minor` link relation.
   * @param doc The document to check in.
   * @param properties Optional properties to update during checkin.
   * @param content Optional new binary content.
   * @param contentType The MIME type of the new content (required if content is provided).
   * @param options Checkin options.
   * @param filename Optional filename for format detection.
   * @returns The checked-in document.
   */
  async checkinNextMinor(
    doc: Linkable,
    properties?: Record<string, unknown>,
    content?: Blob | Buffer,
    contentType?: string,
    options?: CheckInOptions,
    filename?: string,
  ): Promise<HttpResponse<Document>> {
    const href = findLinkOrThrow(doc, LINK_REL_CHECKIN_NEXT_MINOR);

    return this.checkinRequest(href, properties, content, contentType, options, filename);
  }

  /**
   * Shared implementation for checkin requests.
   */
  private async checkinRequest(
    href: string,
    properties?: Record<string, unknown>,
    content?: Blob | Buffer,
    contentType?: string,
    options?: CheckInOptions,
    filename?: string,
  ): Promise<HttpResponse<Document>> {
    // Determine format
    const queryParams: Record<string, string | boolean | undefined> = {};
    let format: string | undefined = options?.format;

    if (!format && filename) {
      const ext = getExtensionFromFilename(filename);
      if (ext) {
        format = getDocumentumFormat(ext);
      }
    }

    if (format) {
      queryParams['format'] = format;
    }

    if (content) {
      // Multipart checkin: metadata + content
      const metadata: MultipartMetadata = {
        properties: properties ?? {},
      };
      if (filename) {
        const nameWithoutExt = filename.lastIndexOf('.') > 0
          ? filename.substring(0, filename.lastIndexOf('.'))
          : filename;
        if (!metadata.properties.object_name) {
          metadata.properties.object_name = nameWithoutExt;
        }
      }

      const multipartBody = buildMultipartBody(
        metadata,
        content,
        filename ?? 'content',
      );

      return this.request<Document>('POST', href, {
        body: multipartBody,
        queryParams,
      });
    }

    // Metadata-only checkin
    const body = properties ? { properties } : {};
    return this.request<Document>('POST', href, {
      body,
      queryParams,
      headers: {
        'Content-Type': 'application/vnd.emc.documentum+json',
      },
    });
  }

  // ────────────────────────────────────────
  // Deletion
  // ────────────────────────────────────────

  /**
   * Deletes a resource via the `delete` link relation.
   * Falls back to `self` or `edit` if no `delete` link is found.
   * @param resource The resource to delete.
   */
  async delete(resource: Linkable): Promise<HttpResponse<void>> {
    // Try delete link first, then self, then edit
    const href = findLinkOptional(resource, LINK_REL_DELETE)
      ?? findLinkOptional(resource, 'self')
      ?? findLinkOptional(resource, 'edit');

    if (!href) {
      throw new Error('No deletable link found on resource (delete, self, or edit)');
    }

    return this.request<void>('DELETE', href);
  }

  // ────────────────────────────────────────
  // Options → Query Parameters
  // ────────────────────────────────────────

  private feedOptionsToParams(
    options?: FeedOptions,
  ): Record<string, string | number | boolean | undefined> | undefined {
    if (!options) return undefined;
    return {
      ...(options.inline !== undefined ? { inline: options.inline } : {}),
      ...(options.itemsPerPage !== undefined ? { 'items-per-page': options.itemsPerPage } : {}),
      ...(options.page !== undefined ? { page: options.page } : {}),
      ...(options.includeTotal !== undefined ? { 'include-total': options.includeTotal } : {}),
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
      ...(options.sort !== undefined ? { sort: options.sort } : {}),
    };
  }

  private singleOptionsToParams(
    options?: SingleOptions,
  ): Record<string, string | number | boolean | undefined> | undefined {
    if (!options) return undefined;
    return {
      ...(options.view !== undefined ? { view: options.view } : {}),
      ...(options.links !== undefined ? { links: options.links } : {}),
      ...(options.format !== undefined ? { format: options.format } : {}),
      ...(options.modifier !== undefined ? { modifier: options.modifier } : {}),
    };
  }
}