import prisma from '../lib/prisma';
import { CONFIG } from '../config';

export async function toggleDuty(staffId: string): Promise<boolean> {
  const current = await prisma.dutyStatus.findUnique({ where: { staffId } });
  const newState = current ? !current.isOnDuty : true;

  await prisma.dutyStatus.upsert({
    where: { staffId },
    update: { isOnDuty: newState, lastUpdated: new Date() },
    create: { staffId, isOnDuty: newState, lastUpdated: new Date() }
  });

  return newState;
}

export async function getActiveStaffCount(): Promise<number> {
  return await prisma.dutyStatus.count({
    where: { isOnDuty: true }
  });
}

export async function checkDutyAutoReset() {
  const resetThreshold = new Date();
  resetThreshold.setHours(resetThreshold.getHours() - (CONFIG.DUTY_RESET_HOURS || 8));

  // Reset all staff who have been on duty longer than the threshold
  const resetResult = await prisma.dutyStatus.updateMany({
    where: {
      isOnDuty: true,
      lastUpdated: { lte: resetThreshold }
    },
    data: {
      isOnDuty: false,
      lastUpdated: new Date()
    }
  });

  if (resetResult.count > 0) {
    console.log(`[DutyManager] Auto-reset duty for ${resetResult.count} staff members.`);
  }
}

export async function isStaffOnDuty(staffId: string): Promise<boolean> {
  const status = await prisma.dutyStatus.findUnique({ where: { staffId } });
  return status?.isOnDuty || false;
}
