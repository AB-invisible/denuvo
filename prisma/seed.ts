import { syncGamesFromFile } from '../src/utils/syncManager';
import prisma from '../src/lib/prisma';
import { client } from '../src/client';
import { CONFIG } from '../src/config';

async function main() {
  console.log('Starting seed process...');
  
  // We need to wait for client to be ready if we want logging to work, 
  // but for a raw seed, we might just want the DB sync.
  // syncGamesFromFile handles both.
  
  await syncGamesFromFile();

  console.log('Seed completed successfully');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
