// Plans and quotas are data, not code paths. Override at runtime with PLANS_JSON (merged per plan).
export type PlanId = 'free' | 'pro' | 'business';
export interface Plan {
  id: PlanId;
  name: string;
  priceMonthly: number;
  maxMembers: number;
  maxProjects: number;
  aiRequestsPerMonth: number;
  storageMb: number;
  features: { rag: boolean; meetings: boolean; advancedAnalytics: boolean; auditLogs: boolean; apiAccess: boolean };
}

const defaults: Record<PlanId, Plan> = {
  free: {
    id: 'free', name: 'Free', priceMonthly: 0, maxMembers: 3, maxProjects: 3, aiRequestsPerMonth: 15, storageMb: 50,
    features: { rag: false, meetings: false, advancedAnalytics: false, auditLogs: false, apiAccess: false },
  },
  pro: {
    id: 'pro', name: 'Pro', priceMonthly: 12, maxMembers: 25, maxProjects: 50, aiRequestsPerMonth: 500, storageMb: 2048,
    features: { rag: true, meetings: true, advancedAnalytics: true, auditLogs: false, apiAccess: false },
  },
  business: {
    id: 'business', name: 'Business', priceMonthly: 39, maxMembers: 500, maxProjects: 1000, aiRequestsPerMonth: 5000, storageMb: 51200,
    features: { rag: true, meetings: true, advancedAnalytics: true, auditLogs: true, apiAccess: true },
  },
};

function load(): Record<PlanId, Plan> {
  const out = JSON.parse(JSON.stringify(defaults)) as Record<PlanId, Plan>;
  if (process.env.PLANS_JSON) {
    const o = JSON.parse(process.env.PLANS_JSON) as Record<string, Partial<Plan>>;
    for (const k of Object.keys(o) as PlanId[]) {
      if (out[k]) Object.assign(out[k], o[k], { features: { ...out[k].features, ...(o[k].features || {}) } });
    }
  }
  return out;
}

export const PLANS = load();
export const getPlan = (id: string): Plan => PLANS[id as PlanId] || PLANS.free;
