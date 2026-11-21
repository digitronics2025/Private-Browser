export function verifyReleaseCandidate(installer: string, stagedFile?: string): Promise<{
  filename: string;
  sizeBytes: number;
  sha256: string;
}>;
