import { Schema, model } from 'mongoose';

export const NOTIFICATION_TYPES = [
  'TASK_ASSIGNED', 'TASK_UPDATED', 'TASK_COMPLETED', 'MENTION', 'COMMENT', 'DEADLINE', 'INVITATION', 'PROJECT_UPDATE', 'AI_ALERT', 'BILLING',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const notificationSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    link: { type: String, default: '' },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);
notificationSchema.index({ userId: 1, workspaceId: 1, read: 1, createdAt: -1 });
export const Notification = model('Notification', notificationSchema);

const auditSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    targetType: String,
    targetId: String,
    metadata: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ workspaceId: 1, createdAt: -1 });
export const AuditLog = model('AuditLog', auditSchema);

const usageSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestType: { type: String, required: true },
    credits: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
usageSchema.index({ workspaceId: 1, createdAt: -1 });
export const Usage = model('UsageRecord', usageSchema);

// Stripe event ids already handled, so redelivered webhooks are ignored. Old entries expire on their own.
const webhookEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true },
  type: String,
  createdAt: { type: Date, default: Date.now, expires: 30 * 24 * 3600 },
});
export const WebhookEvent = model('WebhookEvent', webhookEventSchema);
