# RFC: TypeScript Client Design for Documentum Content Server

**RFC Number:** 001  
**Status:** Proposed  
**Date:** 30 March 2026

## Summary

This RFC proposes a design for `ootd`, a TypeScript client library for OpenText Documentum Content Server via its REST Services API. The design prioritizes idiomatic TypeScript usage, leverages the dual HTTP client architecture defined in ADR-001, and deliberately excludes D2 and custom extensions.

---

## 1. Motivation

The Documentum ecosystem has two mature REST client implementations:

- **`documentum-rest-client-java`** — A feature-rich Java client supporting XML and JSON, with business logic centralized in the client interface.
- **`documentum-rest-client-dotnet`** — A .NET client with self-navigating domain objects, JSON-only, and extensive D2 support.

Both are tied to their respective language ecosystems. A modern TypeScript client is needed to serve the JavaScript/Node.js ecosystem, with the following goals:

1. **Idiomatic TypeScript** — Leverage TypeScript's type system, discriminated unions (per ADR-001), async/await, and module organization.
2. **Dual HTTP support** — Work with both `axios` and native `fetch`, as defined in ADR-001.
3. **No D2/extensions** — Focus solely on core Content Server functionality, unlike the .NET client.
4. **Minimal abstraction** — Follow ADR-001's principle of zero normalization overhead; return native response types.

---

## 2. Design Principles

### 2.1. Core Philosophy

The client shall embody three guiding principles:

| Principle | Description |
|---|---|
| **HATEOAS-driven** | All resource URLs are discovered via hypermedia links. The client never constructs URLs beyond the home document endpoint. |
| **Discriminated Union Responses** | HTTP responses are returned in their native format (`AxiosResponse` or `Response`), discriminated by runtime detection of the HTTP agent. |
| **Minimal Abstraction** | No wrapper classes or normalization layers. Users interact with native HTTP response objects. |

### 2.2. Exclusion of D2 and Custom Extensions

Unlike the .NET client, this implementation excludes:

- D2 configuration models (`D2Document`, `D2Repository`, tasks, C2 views)
- Custom extensions (email import, retention)

This keeps the package lightweight and focused on core Content Server operations.

---

## 3. Architecture

### 3.1. High-Level Structure

```
ootd/
├── index.ts                 # Public API entry point
├── client/
│   ├── DocumentumClient.ts  # Main client class
│   ├── builder.ts           # Fluent builder for client construction
│   └── navigation.ts        # State-aware link navigation helpers
├── resources/
│   ├── HomeDocument.ts      # Entry point resource
│   ├── Repository.ts         # Repository resource
│   ├── Cabinet.ts           # Cabinet (top-level folder)
│   ├── Folder.ts            # Folder resource
│   ├── Document.ts          # Document resource
│   ├── Content.ts           # Content rendition handling
│   ├── User.ts              # User resource
│   ├── Group.ts             # Group resource
│   ├── ACL.ts               # Access control list
│   ├── Relation.ts          # Relations between objects
│   ├── Feed.ts              # Generic feed/collection handling
│   └── types/                # Type system and aspects
├── operations/
│   ├── checkout.ts          # Version control operations
│   ├── lifecycle.ts         # Lifecycle operations
│   ├── query.ts             # DQL and search operations
│   └── batch.ts             # Batch operation support
├── links/
│   ├── LinkRelation.ts       # Link relation constants and helpers
│   └── LinkValidator.ts      # Link existence and state validation
├── options/
│   ├── FeedOptions.ts        # Collection query options
│   ├── SingleOptions.ts      # Single resource options
│   └── SearchOptions.ts      # Search-specific options
├── models/
│   ├── Link.ts               # Hypermedia link model
│   ├── PersistentObject.ts   # Base model for all objects
│   └── errors/
│       ├── RestError.ts      # Structured error handling
│       └── ValidationError.ts # Navigation validation errors
├── http/
│   └── typeGuards.ts         # Type guards for response discrimination
└── streaming/
    └── StreamHandler.ts      # ReadableStream handling for axios/fetch
```

### 3.2. Client Construction

Following the Builder pattern from the Java client, but with TypeScript idioms and a mandatory initialization step:

```typescript
import { DocumentumClient } from 'ootd';
import axios from 'axios';

// Using axios (if installed)
const client = new DocumentumClient.Builder()
  .baseUrl('https://documentum-server/dctm-rest')
  .credentials('user', 'password')
  .repository('REPO01')
  .build();

// Or using native fetch (if axios is not installed)
const client = new DocumentumClient.Builder()
  .baseUrl('https://documentum-server/dctm-rest')
  .credentials('user', 'password')
  .repository('REPO01')
  .build(); // Automatically uses fetch if axios unavailable

// ============================================================
// MANDATORY: Initialize client before any operations
// ============================================================
// This step performs the "handshake" — fetches the Home Document
// and acquires CSRF tokens from server headers. No business
// operations can proceed until initialization completes.
await client.initialize();

// Now the client is ready for use
const home = await client.getHomeDocument();
```

#### 3.2.1. Gated Initialization Design

The client enforces a two-phase lifecycle to eliminate "blind spot" requests:

| Phase | Method | Purpose |
|---|---|---|
| **Construction** | `new Builder().build()` | Creates client instance, configures base URL, credentials, repository |
| **Initialization** | `client.initialize()` | Fetches Home Document, acquires CSRF token, validates repository access |
| **Operational** | All other methods | Business operations (requires prior `initialize()`) |

**Why gated initialization?**

- **CSRF Token Acquisition**: The Home Document response contains CSRF token headers (for REST Services v7.2+). These must be captured before any mutating requests.
- **Security Headers**: Prevents requests that might lack necessary security headers.
- **Early Failure**: Validates repository existence and accessibility up-front rather than on first business operation.
- **State Awareness**: The initialized client has the Home Document cached for link traversal.

```typescript
// Error: Client not initialized
const client = new DocumentumClient.Builder()
  .baseUrl('https://documentum-server/dctm-rest')
  .credentials('user', 'password')
  .repository('REPO01')
  .build();

// Throws ClientNotInitializedError
await client.getCabinets();

// Correct: Initialize first
await client.initialize();
await client.getCabinets(); // OK
```

### 3.3. Response Types (ADR-001)

The client returns discriminated union types:

```typescript
import { AxiosResponse } from 'axios';

type HttpResponse<T> = AxiosResponse<T> | Response;

// Type guard
function isAxiosResponse<T>(resp: HttpResponse<T>): resp is AxiosResponse<T> {
  return 'data' in resp && 'config' in resp;
}
```

For streaming responses, the discriminated union includes `ReadableStream`:

```typescript
type HttpStreamResponse = AxiosResponse<NodeJS.ReadableStream> | Response;

// In fetch: Response.body is a ReadableStream | null
// In axios (Node.js): response.data is NodeJS.ReadableStream when responseType is 'stream'
```

---

## 4. Resource Model Design

### 4.1. Base Types

```typescript
// Base for any resource containing hypermedia links
interface Linkable {
  links: Link[];
}

// Link representation
interface Link {
  rel: string;
  href: string;
  hrefTemplate?: string;
  title?: string;
  type?: string;
}

// Base for all persistent objects
interface PersistentObject extends Linkable {
  id: string;                    // r_object_id
  name?: string;                 // object_name
  type: string;                 // dm_type name
  properties: Record<string, unknown>;
}
```

### 4.2. Feed and Entry (Collections)

```typescript
interface Feed<T extends Linkable> extends Linkable {
  entries: Entry<T>[];
  total?: number;
  itemsPerPage?: number;
  page?: number;
}

interface Entry<T extends Linkable> {
  id: string;
  title?: string;
  updated?: string;
  content: T;
}
```

### 4.3. Domain Resources

Each resource extends `PersistentObject` and carries its domain-specific properties:

```typescript
interface Document extends PersistentObject {
  // Document-specific properties
  contentSize?: number;
  contentType?: string;
  lockOwner?: string;
  isCheckedOut?: boolean;
  versionLabel?: string[];
}

interface Folder extends PersistentObject {
  // Folder-specific properties
  path?: string;
}

interface Cabinet extends Folder {
  // Cabinet-specific properties
}
```

---

## 5. API Surface

### 5.1. Entry Point and Initialization

```typescript
interface DocumentumClient {
  // Gated initialization — MUST be called before any operations
  initialize(): Promise<void>;

  // Bootstrap (requires prior initialization)
  getHomeDocument(): Promise<HttpResponse<HomeDocument>>;
  getProductInfo(): Promise<HttpResponse<ProductInfo>>;
  getRepositories(): Promise<HttpResponse<Feed<Repository>>>;
}
```

### 5.2. Navigation — Cabinets, Folders, Documents

```typescript
interface DocumentumClient {
  // Cabinets
  getCabinets(options?: FeedOptions): Promise<HttpResponse<Feed<Cabinet>>>;
  getCabinet(id: string, options?: SingleOptions): Promise<HttpResponse<Cabinet>>;
  createCabinet(cabinet: Partial<Cabinet>): Promise<HttpResponse<Cabinet>>;

  // Folders (under cabinet or parent folder)
  getFolders(parent: Linkable, options?: FeedOptions): Promise<HttpResponse<Feed<Folder>>>;
  getFolder(id: string, options?: SingleOptions): Promise<HttpResponse<Folder>>;
  createFolder(parent: Linkable, folder: Partial<Folder>): Promise<HttpResponse<Folder>>;

  // Documents
  getDocuments(parent: Linkable, options?: FeedOptions): Promise<HttpResponse<Feed<Document>>>;
  getDocument(id: string, options?: SingleOptions): Promise<HttpResponse<Document>>;
  createDocument(
    parent: Linkable,
    doc: Partial<Document>
  ): Promise<HttpResponse<Document>>;
  createDocumentWithContent(
    parent: Linkable,
    doc: Partial<Document>,
    content: ReadableStream | Blob | Buffer,
    contentType: string
  ): Promise<HttpResponse<Document>>;
}
```

### 5.3. Content

```typescript
interface DocumentumClient {
  getContents(doc: Document): Promise<HttpResponse<Feed<Content>>>;
  getPrimaryContent(doc: Document): Promise<HttpResponse<ReadableStream>>;
  uploadContent(
    doc: Document,
    content: ReadableStream | Blob | Buffer,
    contentType: string
  ): Promise<HttpResponse<Content>>;
}
```

#### 5.3.1. Streaming Support (ReadableStream)

The client supports `ReadableStream` for both downloads and uploads, providing a modern, high-performance way to handle large content across different environments (Node.js/Browser).

**Download (Content Retrieval):**

```typescript
// Fetch the content as a stream
const response = await client.getPrimaryContent(document);
const stream = isAxiosResponse(response)
  ? response.data as NodeJS.ReadableStream  // axios with responseType: 'stream'
  : response.body as ReadableStream;         // native fetch

// Process the stream
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // Process chunk (value is Uint8Array)
  processChunk(value);
}
```

**Upload (Content Creation):**

```typescript
// Create a ReadableStream from a file or other source
const fileStream = fs.createReadStream('large-file.pdf');
const stream = ReadableStream.from(fileStream);

await client.uploadContent(document, stream, 'application/pdf');
```

**Cross-Client Streaming Handling:**

| HTTP Agent | Download Stream | Upload Stream |
|---|---|---|
| **fetch** | `Response.body` (ReadableStream) | Pass `ReadableStream` directly to `body` option |
| **axios** (Node.js) | Requires `responseType: 'stream'` → `response.data` (Node.js Readable) | Convert to Node.js Readable or use `FormData` with stream |
| **axios** (Browser) | `response.data` (Blob) | Pass `Blob` or use `FormData` |

The `streaming/StreamHandler.ts` module provides utilities to handle these differences transparently, converting between stream types as needed while preserving the ADR-001 principle of minimal abstraction.

### 5.4. Version Management

```typescript
interface DocumentumClient {
  checkout(doc: Document): Promise<HttpResponse<Document>>;
  cancelCheckout(doc: Document): Promise<HttpResponse<void>>;
  checkinNextMajor(doc: Document, content?: Blob | Buffer): Promise<HttpResponse<Document>>;
  checkinNextMinor(doc: Document, content?: Blob | Buffer): Promise<HttpResponse<Document>>;
  getVersionHistory(doc: Document, options?: FeedOptions): Promise<HttpResponse<Feed<Document>>>;
}
```

### 5.5. Query and Search

```typescript
interface DocumentumClient {
  executeDQL(repository: Repository, dql: string, options?: FeedOptions & { includeTotal?: boolean }): Promise<HttpResponse<Feed<PersistentObject>>>;
  search(repository: Repository, query: string, options?: SearchOptions): Promise<HttpResponse<Feed<PersistentObject>>>;
}
```

### 5.6. Users and Groups

```typescript
interface DocumentumClient {
  getUsers(repository: Repository, options?: FeedOptions): Promise<HttpResponse<Feed<User>>>;
  getUser(id: string): Promise<HttpResponse<User>>;
  createUser(repository: Repository, user: Partial<User>): Promise<HttpResponse<User>>;

  getGroups(repository: Repository, options?: FeedOptions): Promise<HttpResponse<Feed<Group>>>;
  getGroup(id: string): Promise<HttpResponse<Group>>;
  addUserToGroup(group: Group, user: User): Promise<HttpResponse<void>>;
}
```

---

## 6. Link-Driven Navigation

Following the HATEOAS principle, resources carry their own navigation capabilities:

```typescript
// Instead of client.getCabinet(id), use:
const home = await client.getHomeDocument();
const repos = await followLinks(home, 'repositories');
const repo = await followLink(repos, 'self');
const cabinets = await followLinks(repo, 'cabinets');
const cabinet = cabinets.entries[0];
const docs = await followLinks(cabinet, 'documents');

// Helper to follow link relations
function followLinks<T extends Linkable>(resource: T, rel: string): Promise<HttpResponse<Feed<any>>>;
function followLink<T extends Linkable>(resource: T, rel: string): Promise<HttpResponse<T>>;
```

This mirrors the .NET client's self-navigating model objects, but operates at the client level to maintain the ADR-001 principle of no abstraction overhead.

### 6.1. State-Aware Navigation Helpers

The navigation module (`client/navigation.ts`) provides **state-aware** link following with pre-flight validation:

```typescript
import { Navigation, LinkRelation } from 'ootd';

// State-aware navigation with validation
const cabinet = await Navigation.followWithValidation(
  client,
  repository,
  LinkRelation.CABINETS,
  { validateState: true }  // Check resource state before following
);

// Pre-flight checks:
// 1. Existence: Does the link relation exist?
// 2. State: Does the resource state allow this action?

// Example: Cannot checkout a locked document
const doc = await client.getDocument(id);
try {
  const checkedOut = await Navigation.followWithValidation(
    client,
    doc,
    LinkRelation.CHECKOUT
  );
} catch (error) {
  if (error instanceof ValidationError) {
    console.log(`Cannot checkout: ${error.reason}`);
    // Possible reasons:
    // - LINK_MISSING: Relation doesn't exist
    // - STATE_FORBIDDEN: Document is locked by another user
    // - STATE_REQUIRED: Required properties missing for this action
  }
}
```

#### 6.1.1. LinkRelation Enum

Strongly-typed link relation constants replace stringly-typed relations:

```typescript
enum LinkRelation {
  SELF = 'self',
  REPOSITORIES = 'repositories',
  CABINETS = 'cabinets',
  FOLDERS = 'folders',
  DOCUMENTS = 'documents',
  CONTENTS = 'contents',
  PRIMARY_CONTENT = 'primary-content',
  VERSIONS = 'versions',
  CHECKOUT = 'checkout',
  CANCEL_CHECKOUT = 'cancel-checkout',
  CHECKIN_NEXT_MAJOR = 'checkin-next-major',
  CHECKIN_NEXT_MINOR = 'checkin-next-minor',
  LOCK = 'lock',
  UNLOCK = 'unlock',
  // ... other relations
}
```

#### 6.1.2. ValidationError

Pre-flight validation failures return a `ValidationError` before any network request:

```typescript
interface ValidationError extends Error {
  code: 'LINK_MISSING' | 'STATE_FORBIDDEN' | 'STATE_REQUIRED';
  resource: Linkable;
  relation: string;
  reason: string;
  details?: Record<string, unknown>;
}

// Validation checks by operation type:
const stateRequirements: Record<string, { requiredProperties?: string[]; forbiddenProperties?: string[] }> = {
  [LinkRelation.CHECKOUT]: {
    forbiddenProperties: ['r_lock_owner'], // Cannot checkout if already locked
  },
  [LinkRelation.CANCEL_CHECKOUT]: {
    requiredProperties: ['r_lock_owner'], // Must be locked to cancel checkout
  },
  [LinkRelation.CHECKIN_NEXT_MAJOR]: {
    requiredProperties: ['r_lock_owner'],
  },
};
```

#### 6.1.3. Navigation API

```typescript
class Navigation {
  // Basic link following
  static async follow<T extends Linkable>(
    client: DocumentumClient,
    resource: T,
    relation: LinkRelation
  ): Promise<HttpResponse<T>>;

  static async followFeed<T extends Linkable>(
    client: DocumentumClient,
    resource: T,
    relation: LinkRelation
  ): Promise<HttpResponse<Feed<T>>>;

  // State-aware with validation
  static async followWithValidation<T extends Linkable>(
    client: DocumentumClient,
    resource: T,
    relation: LinkRelation,
    options?: { validateState?: boolean }
  ): Promise<HttpResponse<T>>;

  // Check validity without making a request
  static validateLink(
    resource: Linkable,
    relation: LinkRelation
  ): ValidationError | null;

  static validateState(
    resource: PersistentObject,
    relation: LinkRelation
  ): ValidationError | null;
}
```

---

## 7. Query Options

Type-safe options objects (inspired by the .NET client):

```typescript
interface FeedOptions {
  inline?: boolean;
  itemsPerPage?: number;
  page?: number;
  includeTotal?: boolean;
  filter?: string;
  sort?: string;
}

interface SingleOptions {
  view?: string;
  links?: boolean;
  format?: string;
  modifier?: string;
}

interface SearchOptions {
  query?: string;
  searchType?: string;
  maxResults?: number;
}
```

---

## 8. Authentication

### 8.1. Basic Authentication

Default and primary authentication mechanism:

```typescript
const client = new DocumentumClient.Builder()
  .baseUrl('https://documentum-server/dctm-rest')
  .credentials('user', 'password')
  .build();
```

The client adds the `Authorization: Basic <base64>` header to every request.

### 8.2. CSRF Token Support (REST Services v7.2+) — Gated Initialization

The Java client implements the CSRF client token protocol. This client mirrors that support with the gated initialization model:

```typescript
const client = new DocumentumClient.Builder()
  .baseUrl('https://documentum-server/dctm-rest')
  .credentials('user', 'password')
  .enableCsrfProtection(true)  // Default: true
  .build();

// ============================================================
// MANDATORY: Gated initialization acquires CSRF token
// ============================================================
await client.initialize();  // Fetches Home Document and captures CSRF headers
```

**How the gated initialization acquires the CSRF token:**

1. **Builder Configuration**: The client is configured with `enableCsrfProtection(true)` (default).
2. **Initialization Phase**: When `client.initialize()` is called:
   - The client makes a GET request to the Home Document endpoint.
   - The server responds with CSRF token headers (e.g., `DCTM-CSRF-TOKEN`).
   - The client extracts the token name and value from the response headers.
   - The token is stored internally for use on subsequent mutating requests.
3. **Operational Phase**: On any mutating request (POST, PUT, DELETE):
   - The client automatically adds the CSRF header using the stored token.
   - If no token was acquired (e.g., server doesn't support CSRF), requests proceed without the header.

**Why this approach eliminates the "blind spot":**

- The CSRF token acquisition happens **before** any business operations can execute.
- There is no window where a mutating request might go out without the CSRF header.
- If the server requires CSRF but doesn't provide a token during initialization, the client fails fast with a clear error.

```typescript
// Error scenarios

// 1. CSRF required but server didn't provide token
try {
  await client.initialize();
} catch (error) {
  if (error instanceof CsrfTokenError) {
    console.log('Server requires CSRF but did not provide token');
  }
}

// 2. Using client before initialization
const client2 = new DocumentumClient.Builder()
  .baseUrl('https://documentum-server/dctm-rest')
  .credentials('user', 'password')
  .build();

await client2.getCabinets(); // Throws ClientNotInitializedError
```

---

## 9. Error Handling

Errors are returned as structured `RestError` objects, parsed from the response body:

```typescript
interface RestError {
  code?: string;
  message: string;
  details?: Array<{
    code?: string;
    message: string;
  }>;
}

// Usage
const response = await client.getDocument('invalid-id');
if (!response.ok) {
  if (isAxiosResponse(response)) {
    const error = response.data as RestError;
    console.error(error.message);
  } else {
    const error = await response.json() as RestError;
    console.error(error.message);
  }
}
```

---

## 10. Batch Operations

Support for Documentum's batch endpoint:

```typescript
interface BatchRequest {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  resource: string; // Relative URI
  body?: unknown;
}

interface DocumentumClient {
  executeBatch(requests: BatchRequest[]): Promise<HttpResponse<BatchResponse[]>>;
}
```

---

## 11. Comparison with Reference Clients

| Aspect | Java Client | .NET Client | ootd (This RFC) |
|---|---|---|---|
| API surface | Interface (~80 methods) | Generic `RestController` + domain objects | Client class with grouped methods |
| Domain logic location | Client interface | Domain objects (`DocumentExec`, etc.) | Client + link-following helpers |
| Serialization | XML (JAXB) + JSON (Jackson) | JSON only | JSON only |
| HTTP agents | Spring `RestTemplate` | `HttpClient` | `axios` or `fetch` (ADR-001) |
| Response handling | Wrapped in client | Injected into models | Discriminated union (ADR-001) |
| Query options | String varargs | Typed classes | Typed interfaces |
| Async model | Optional dynamic proxy | Blocking `.Result` | Native `async/await` |
| D2 support | None | Full | None (excluded) |
| Custom extensions | None | Email, retention | None (excluded) |
| Paging | Client methods | Feed methods | Client methods + Feed helpers |

---

## 12. Future Considerations

While out of scope for the initial release, the following could be added later:

1. **TypeScript type generation** — Generate TypeScript interfaces from the Documentum repository's type definitions.
2. **Reactive streams** — Add RxJS observables for those who prefer reactive programming.
3. **Plugin architecture** — Allow registering custom serializers or interceptors.
4. **Kerberos/NTLM auth** — Add integrated Windows authentication support (as in .NET client).

---

## 13. Implementation Roadmap

### Phase 1: Core Infrastructure

- [ ] Client builder with HTTP agent detection (ADR-001)
- [ ] Basic authentication
- [ ] Home document and repository discovery
- [ ] Link relation constants (`LinkRelation` enum)
- [ ] Error handling infrastructure
- [ ] **Gated initialization with CSRF token acquisition**
- [ ] **State-aware navigation helpers with validation**
- [ ] **Streaming support (ReadableStream)**

### Phase 2: Core Resources

- [ ] Cabinet, Folder, Document CRUD
- [ ] Content upload/download (with streaming)
- [ ] Version management (checkout, checkin)
- [ ] Feed/Entry handling with paging

### Phase 3: Extended Features

- [ ] User and Group management
- [ ] DQL execution
- [ ] Search
- [ ] ACLs and permissions

### Phase 4: Advanced Features

- [ ] Batch operations
- [ ] Lifecycle management
- [ ] Relations
- [ ~~] CSRF token support~~ (moved to Phase 1)

---

## 14. Open Questions

1. **Should the client include a mock/test server for development?**  
   The Java client includes extensive sample code; this could be provided as a separate package.

2. **How to handle repository selection?**  
   The Java client accepts a repository name at construction. Should `ootd` require a repository, or allow operating across multiple repositories from a single client instance?

3. **Should we provide a React Query or similar integration?**  
   For frontend use, hooks for data fetching libraries would improve ergonomics.

---

## 15. References

- ADR-001: Dual HTTP Client Support for RESTful Client Package
- `documentum-rest-client-java`: Enterprise-Content-Management/documentum-rest-client-java
- `documentum-rest-client-dotnet`: Enterprise-Content-Management/documentum-rest-client-dotnet
- Documentum REST Services API Documentation
