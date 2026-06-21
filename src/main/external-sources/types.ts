export interface ExternalSourceProvider {
  id: string;
  displayName: string;
  domains: string[];
  syncDomain(domain: string): Promise<ExternalDocument[]>;
}

export interface ExternalDocument {
  source: string;
  domain: string;
  external_id: string;
  title: string;
  url: string;
  content: string;
  metadata_json: string;
  updated_at: string;
}

export interface SyncResult {
  ok: boolean;
  documents: number;
  chunks: number;
  error?: string;
}
