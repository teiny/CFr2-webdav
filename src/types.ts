// 文件名：src/types.ts
export interface Env {
  BUCKET: R2Bucket;
  USERNAME: string;
  PASSWORD: string;
  BUCKET_NAME: string;
}

export interface CacheableResponse {
  response: Response;
  expiry: number;
}

export interface WebDAVProps {
  href: string;
  creationdate: string | undefined;
  displayname: string | undefined;
  getcontentlanguage: string | undefined;
  getcontentlength: string;
  getcontenttype: string | undefined;
  getetag: string | undefined;
  getlastmodified: string | undefined;
  resourcetype: string;
  deadProperties?: StoredProperty[];
  quotaUsedBytes?: string;
  quotaSupported?: boolean;
}

export interface StoredProperty {
  name: string;
  namespace: string;
  xml: string;
}
