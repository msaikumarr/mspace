import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';
import { ROLES } from '../config/rbac';

const workspaceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    plan: { type: String, enum: ['free', 'pro', 'business'], default: 'free' },
    subscription: {
      status: { type: String, enum: ['active', 'canceled', 'past_due'], default: 'active' },
      currentPeriodEnd: Date,
      cancelAtPeriodEnd: { type: Boolean, default: false },
      // Stripe references. Never serialised (see the toJSON transform in config/db.ts).
      stripeCustomerId: String,
      stripeSubscriptionId: String,
    },
  },
  { timestamps: true },
);
workspaceSchema.index({ 'subscription.stripeCustomerId': 1 }, { sparse: true });
workspaceSchema.index({ 'subscription.stripeSubscriptionId': 1 }, { sparse: true });
export type WorkspaceDoc = HydratedDocument<InferSchemaType<typeof workspaceSchema>>;
export const Workspace = model('Workspace', workspaceSchema);

const memberSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, required: true },
  },
  { timestamps: true },
);
memberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
memberSchema.index({ userId: 1 });
export type MemberDoc = HydratedDocument<InferSchemaType<typeof memberSchema>>;
export const Member = model('WorkspaceMember', memberSchema);

const inviteSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    email: { type: String, required: true, lowercase: true },
    role: { type: String, enum: ROLES, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
inviteSchema.index({ workspaceId: 1, email: 1 }, { unique: true });
inviteSchema.index({ email: 1 });
export const Invite = model('Invite', inviteSchema);
