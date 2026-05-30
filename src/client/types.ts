import type { Linkable, PersistentObject } from '../types/linkable.js';

export interface Credentials {
  username: string;
  password: string;
}

export interface DocumentumClientConfig {
  baseUrl: string;
  credentials: Credentials;
  repository: string;
  httpAgent?: typeof fetch | unknown;
  enableCsrfProtection?: boolean;
}

export interface FeedOptions {
  inline?: boolean;
  itemsPerPage?: number;
  page?: number;
  includeTotal?: boolean;
  filter?: string;
  sort?: string;
}

export interface SingleOptions {
  view?: string;
  links?: boolean;
  format?: string;
  modifier?: string;
}

export interface SearchOptions {
  query?: string;
  searchType?: string;
  maxResults?: number;
}

export interface BatchRequest {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  resource: string;
  body?: unknown;
}

export interface HomeDocument extends Linkable {
  vendor?: string;
  product?: string;
  version?: string;
}

export interface ProductInfo extends Linkable {
  name?: string;
  version?: string;
  build?: string;
}

export interface Repository extends Linkable {
  id: string;
  name: string;
  description?: string;
  servers?: string[];
}

export interface User extends PersistentObject {
  email?: string;
  userLoginName?: string;
  userSource?: string;
}

export interface Group extends PersistentObject {
  groupName?: string;
  groupDescription?: string;
  groupClass?: number;
}