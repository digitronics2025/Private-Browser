import { z } from 'zod';
import { clientLimitSettings } from './agent-permission-model.js';
export * from './agent-permission-model.js';

export const agentClasses = z.strictObject({
  read: z.boolean(), view: z.boolean(), interact: z.boolean(), files: z.boolean(), diagnostic: z.boolean(),
});

const boundedLimit = ({ min, max }: { min: number; max: number }) =>
  z.number().int().min(min).transform((value) => Math.min(value, max));
export const clientLimits = z.strictObject({
  actionsPerMinute: boundedLimit(clientLimitSettings.actionsPerMinute),
  tabs: boundedLimit(clientLimitSettings.tabs),
  idleMs: boundedLimit(clientLimitSettings.idleMs),
  sessionMs: boundedLimit(clientLimitSettings.sessionMs),
});
export type ClientLimits = z.output<typeof clientLimits>;
export const originRules = z.array(z.string().trim().min(1).max(300)).max(30);
const spaceCommon = {
  name: z.string().trim().min(1).max(60),
  classes: agentClasses,
  downloadQuotaMb: z.number().int().min(1).max(1_000),
  clientIds: z.array(z.uuid()).max(12),
};
export const agentSpaceSettings = z.discriminatedUnion('trust', [
  z.strictObject({ ...spaceCommon, trust: z.literal('work'), origins: originRules, outside: z.enum(['observe', 'view', 'deny']) }),
  z.strictObject({ ...spaceCommon, trust: z.literal('open-web') }),
]);
export type AgentSpaceSettings = z.output<typeof agentSpaceSettings>;
