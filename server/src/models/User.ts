import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';
import { verificationRequired } from '../config/mail';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Absent for accounts that only sign in with a social provider (they can set one via "forgot password").
    passwordHash: { type: String, select: false },
    // True once we know the person controls this address: created via a verified social sign-in, or completed a password reset.
    emailVerified: { type: Boolean, default: false },
    verifyTokenHash: { type: String, select: false }, // sha256 of the emailed link's token; the token itself is never stored
    verifyTokenExpires: { type: Date, select: false },
    verifySentAt: { type: Date, select: false }, // for the resend cooldown
    identities: {
      type: [{ provider: { type: String, required: true }, subject: { type: String, required: true }, email: String, linkedAt: { type: Date, default: Date.now }, _id: false }],
      default: [],
    },
    avatarColor: { type: String, default: '#6366f1' },
    title: { type: String, default: '' },
    isPlatformAdmin: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now },
    resetTokenHash: { type: String, select: false },
    resetTokenExpires: { type: Date, select: false },
  },
  { timestamps: true },
);

userSchema.index({ 'identities.provider': 1, 'identities.subject': 1 }, { unique: true, partialFilterExpression: { 'identities.provider': { $exists: true } } });

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);

export const publicUser = (u: UserDoc) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  avatarColor: u.avatarColor,
  title: u.title,
  isPlatformAdmin: u.isPlatformAdmin,
  emailVerified: u.emailVerified,
  // true when this server insists on verified addresses and this one is not yet: the UI asks them to confirm it
  needsEmailVerification: verificationRequired() && !u.emailVerified,
});
