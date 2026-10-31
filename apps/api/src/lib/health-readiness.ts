export function isCoreApiReady(database: boolean, redis: boolean): boolean {
  return database && redis;
}
