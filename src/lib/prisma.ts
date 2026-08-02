import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { CONFIG } from '../config';

const prismaClientSingleton = (): PrismaClient => {
  const connectionString = CONFIG.DATABASE_URL;
  
  if (!connectionString) {
    console.warn('⚠️  DATABASE_URL is missing! Prisma Client might not be fully initialized.');
    return new PrismaClient(); 
  }

  const needsSsl =
    connectionString.includes('railway') ||
    connectionString.includes('rlwy.net') ||
    connectionString.includes('neon.tech') ||
    connectionString.includes('render.com');

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    idleTimeoutMillis: 10000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  const adapter = new PrismaPg(pool as any);
  return new PrismaClient({ adapter });
};

declare global {
  var prisma: PrismaClient | undefined;
}

const prisma: PrismaClient = globalThis.prisma ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma;
