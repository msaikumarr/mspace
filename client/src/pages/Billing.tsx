import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../services/api';
import { useBilling } from '../hooks/useData';
import { useAuth, useWorkspace } from '../store/auth';
import { Badge, Button, Card, Loading, Meter, PageHeader, toast } from '../components/ui';
import { cn, fmtDate } from '../utils';
import type { Plan } from '../types';

const FEATURE_LABELS: Record<string, string> = { rag: 'Document Q&A (RAG)', meetings: 'Meeting assistant', advancedAnalytics: 'Advanced analytics', auditLogs: 'Audit logs', apiAccess: 'API access' };

interface Subscription { status: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; hasBillingAccount?: boolean; hasSubscription?: boolean }
type PaymentMode = 'stripe' | 'simulated' | 'disabled';

export default function Billing() {
  const ws = useWorkspace()!;
  const qc = useQueryClient();
  const q = useBilling();
  const [params, setParams] = useSearchParams();
  const returning = params.get('checkout');
  const [activating, setActivating] = useState(returning === 'success');
  const announcedCancel = useRef(false); // effects run twice in development; announce only once
  const canManage = ['owner', 'admin'].includes(ws.role);

  const showPlan = (id: Plan['id']) =>
    useAuth.getState().setWorkspaces(useAuth.getState().workspaces.map((w) => (w.id === ws.id ? { ...w, plan: id } : w)));

  const change = useMutation({
    mutationFn: (plan: string) => post<{ plan: Plan; subscription: Subscription }>('/billing/change-plan', { plan }),
    onSuccess: (d, requested) => {
      showPlan(d.plan.id);
      qc.invalidateQueries({ queryKey: ['ws'] });
      // With Stripe, cancelling keeps the paid plan until the period ends, so describe what actually happened.
      toast.success(d.plan.id !== requested && requested === 'free' ? `Your ${d.plan.name} plan will end at the close of the billing period` : d.plan.id === requested ? `Switched to the ${d.plan.name} plan` : 'Plan updated');
    },
    onError: toast.error,
  });
  const goTo = { onSuccess: (r: { url: string }) => window.location.assign(r.url), onError: toast.error };
  const checkout = useMutation({ mutationFn: (plan: string) => post<{ url: string }>('/billing/checkout', { plan }), ...goTo });
  const portal = useMutation({ mutationFn: () => post<{ url: string }>('/billing/portal'), ...goTo });

  // Back from Stripe Checkout: the webhook that activates the plan can lag the redirect by a few seconds.
  useEffect(() => {
    if (returning === 'canceled' && !announcedCancel.current) {
      announcedCancel.current = true;
      toast.info('Checkout canceled. You were not charged.');
      setParams({}, { replace: true });
    }
    if (returning !== 'success') return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const b = await get<{ plan: Plan }>('/billing').catch(() => null);
      if (b && b.plan.id !== 'free') {
        clearInterval(timer);
        showPlan(b.plan.id);
        qc.invalidateQueries({ queryKey: ['ws'] });
        setActivating(false);
        setParams({}, { replace: true });
        toast.success(`You're on the ${b.plan.name} plan. Thank you!`);
      } else if (tries >= 15) {
        clearInterval(timer);
        setActivating(false);
        setParams({}, { replace: true });
        toast.info('Still confirming your payment. This can take a minute, so check back shortly.');
      }
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returning]);

  if (q.isLoading || !q.data) return <Loading />;
  const { plan, usage, plans, subscription: sub, paymentMode } = q.data as { plan: Plan; usage: any; plans: Plan[]; subscription: Subscription; paymentMode: PaymentMode };
  const stripeMode = paymentMode === 'stripe';
  const ends = sub.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd, true) : '';

  const actionFor = (p: Plan): { label: string; run?: () => void; disabled?: boolean; primary?: boolean } => {
    if (paymentMode === 'disabled') return { label: p.id === plan.id ? 'Current plan' : `Switch to ${p.name}`, disabled: true };
    if (p.id === plan.id) {
      return stripeMode && p.id !== 'free' && sub.cancelAtPeriodEnd ? { label: 'Resume plan', run: () => change.mutate(p.id), primary: true } : { label: 'Current plan', disabled: true };
    }
    const up = p.priceMonthly > plan.priceMonthly;
    if (!stripeMode) return { label: up ? `Upgrade to ${p.name}` : `Switch to ${p.name}`, run: () => change.mutate(p.id), primary: up };
    if (p.id === 'free') {
      return sub.cancelAtPeriodEnd
        ? { label: 'Cancellation scheduled', disabled: true }
        : { label: 'Cancel subscription', run: () => confirm(`Cancel your ${plan.name} subscription? You keep it until ${ends || 'the end of the billing period'}.`) && change.mutate('free') };
    }
    if (!sub.hasSubscription) return { label: `Upgrade to ${p.name}`, run: () => checkout.mutate(p.id), primary: true };
    return { label: up ? `Upgrade to ${p.name}` : `Switch to ${p.name}`, run: () => change.mutate(p.id), primary: up };
  };

  const busy = (id: string) => (change.isPending && change.variables === id) || (checkout.isPending && checkout.variables === id);
  const manage = stripeMode && sub.hasBillingAccount && canManage ? <Button variant="secondary" loading={portal.isPending} onClick={() => portal.mutate()}>Manage billing</Button> : undefined;

  return (
    <div>
      <PageHeader
        title="Billing & usage"
        subtitle={`You're on the ${plan.name} plan${ends && plan.id !== 'free' ? (sub.cancelAtPeriodEnd ? ` · ends ${ends}` : ` · renews ${ends}`) : ''}`}
        actions={manage}
      />

      {paymentMode === 'simulated' && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b>Demo billing:</b> no payment provider is connected, so changing plans is instant and free. Set the <code>STRIPE_*</code> variables on the server to charge for real.
        </div>
      )}
      {paymentMode === 'disabled' && (
        <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Plan changes are unavailable because payments are not configured on this server.</div>
      )}
      {activating && <div role="status" className="mb-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">Payment received. Activating your plan…</div>}
      {stripeMode && sub.status === 'past_due' && (
        <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span><b>Your last payment failed.</b> Update your payment method to keep your {plan.name} plan.</span>
          {manage}
        </div>
      )}
      {stripeMode && sub.cancelAtPeriodEnd && plan.id !== 'free' && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Your {plan.name} plan ends on <b>{ends}</b>. You keep full access until then, and you can resume it at any time.
        </div>
      )}

      <Card className="mb-8 grid gap-5 p-5 sm:grid-cols-2">
        <Meter label="Members" used={usage.members.used} limit={usage.members.limit} />
        <Meter label="Projects" used={usage.projects.used} limit={usage.projects.limit} />
        <Meter label="AI requests this month" used={usage.aiRequests.used} limit={usage.aiRequests.limit} />
        <Meter label="Storage" used={usage.storageMb.used} limit={usage.storageMb.limit} format={(n) => `${n} MB`} />
      </Card>
      <div className="grid gap-5 md:grid-cols-3">
        {plans.map((p) => {
          const current = p.id === plan.id;
          const a = actionFor(p);
          return (
            <Card key={p.id} className={cn('flex flex-col p-6', current && 'border-brand-500 ring-2 ring-brand-200')}>
              <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">{p.name}</h3>{current && <Badge tone="brand">Current</Badge>}</div>
              <p className="mt-2 text-3xl font-bold">${p.priceMonthly}<span className="text-sm font-normal text-slate-500">/month</span></p>
              <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-600">
                <li>✓ Up to {p.maxMembers} members</li><li>✓ Up to {p.maxProjects} projects</li><li>✓ {p.aiRequestsPerMonth.toLocaleString()} AI requests / month</li><li>✓ {p.storageMb >= 1024 ? `${p.storageMb / 1024} GB` : `${p.storageMb} MB`} storage</li>
                {Object.entries(FEATURE_LABELS).map(([k, label]) => <li key={k} className={p.features[k as keyof Plan['features']] ? '' : 'text-slate-300 line-through'}>{p.features[k as keyof Plan['features']] ? '✓' : '✕'} {label}</li>)}
              </ul>
              <Button className="mt-5" variant={a.primary ? 'primary' : 'secondary'} disabled={a.disabled || !canManage} loading={busy(p.id)} onClick={a.run}>{a.label}</Button>
            </Card>
          );
        })}
      </div>
      {!canManage && <p className="mt-4 text-sm text-slate-400">Only owners and admins can change the plan.</p>}
    </div>
  );
}
