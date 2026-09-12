export interface ClearableAccountSession {
  clearData(): Promise<void>;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
  clearHostResolverCache(): Promise<void>;
  closeAllConnections(): Promise<void>;
  cookies: { get(filter: Record<string, never>): Promise<unknown[]> };
  getCacheSize(): Promise<number>;
}

/** Clear only the supplied partition, including Chromium data types added later. */
export async function clearAndVerifyAccountSession(target: ClearableAccountSession): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await target.closeAllConnections();
    await target.clearData();
    await target.clearStorageData();
    await target.clearCache();
    await target.clearAuthCache();
    await target.clearHostResolverCache();
    const [cookies, cacheBytes] = await Promise.all([target.cookies.get({}), target.getCacheSize()]);
    if (cookies.length === 0 && cacheBytes === 0) return;
  }
  throw new Error('Account Space browsing data could not be completely verified as cleared');
}
