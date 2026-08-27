export interface CacheOptions {
  redisUrl: string; // URL of the Redis instance. E.g., 'redis://localhost:6379/0' or 'redis://another-host:6380/0'
  password?: string; // Optional password for Redis authentication
  name?: string; // Name to identify this cache instance (useful for logs)
  // Here you can add other client-specific Redis configuration options if needed
}
