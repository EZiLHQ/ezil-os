// Use --schema ./src/server/lib/pool/migration-schema.ts for drizzle-kit generate
// until the pool table can be exported from the main schema barrel.
export * from '../../db/schema';
export * from './schema';
