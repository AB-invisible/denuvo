import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { CONFIG } from '../config';

const prismaClientSingleton = () => {
  const connectionString = CONFIG.DATABASE_URL;
  
  if (!connectionString) {
    console.warn('⚠️  DATABASE_URL is missing! Prisma Client might not be fully initialized.');
    return new PrismaClient(); 
  }

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const adapter = new PrismaPg(pool as any);
  return new PrismaClient({ adapter });
};

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

const prisma = globalThis.prisma ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma;
