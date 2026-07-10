import { execute as postpanel } from './postpanel';
import { execute as closepanel } from './closepanel';
import { execute as settokens } from './settokens';
import { execute as removegame } from './removegame';
import { execute as stock } from './stock';
import { execute as cooldown } from './cooldown';
import { execute as mycooldown } from './mycooldown';
import { execute as staffstats } from './staffstats';
import { execute as onduty } from './onduty';
import { execute as profile } from './profile';
import { execute as lookup } from './lookup';
import { execute as test } from './test';
import { execute as tokengen } from './tokengen';
import { execute as setsteampass } from './setsteampass';
import { execute as autogen } from './autogen';
import { execute as game } from './game';
import { execute as setmode } from './setmode';
import { execute as getmode } from './getmode';
import { execute as excludeAuto } from './excludeAuto';
import { execute as lowstock } from './lowstock';
import { execute as request } from './request';
import { execute as requests } from './requests';
import { execute as promo } from './promo';
import { execute as redeem } from './redeem';
import { execute as tenantstats } from './tenantstats';
import { execute as trust } from './trust';
import { execute as waitlist } from './waitlist';
import { execute as restockall } from './restockall';
import { execute as steamhealth } from './steamhealth';
import { execute as steamaccount } from './steamaccount';

export const commandHandlers: Record<string, (interaction: any) => Promise<void>> = {
  postpanel,
  closepanel,
  settokens,
  removegame,
  stock,
  cooldown,
  mycooldown,
  staffstats,
  onduty,
  profile,
  lookup,
  test,
  tokengen,
  setsteampass,
  autogen,
  game,
  setmode,
  getmode,
  'exclude-auto': excludeAuto,
  lowstock,
  request,
  requests,
  promo,
  redeem,
  'tenant-stats': tenantstats,
  trust,
  waitlist,
  restockall,
  steamhealth,
  steamaccount,
};
