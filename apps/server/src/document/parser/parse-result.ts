export interface ParsedImage {
  path: string;
  bytes: Buffer;
  contentType: string;
}

export interface ParsedDocument {
  markdown: string;
  images: ParsedImage[];
  warnings: string[];
  parser: string;
}

/** Private server state. Never include this in a public document response. */
export interface MineruCheckpoint {
  batchId: string;
  uploadUrl: string;
  uploaded: boolean;
}

export interface ParseOptions {
  checkpoint?: MineruCheckpoint;
  onCheckpoint?: (checkpoint: MineruCheckpoint) => Promise<void>;
  onProgress?: (stage: string) => Promise<void>;
}
