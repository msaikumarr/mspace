import { Schema, model } from 'mongoose';

const channelSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true, lowercase: true, maxlength: 50 },
    type: { type: String, enum: ['channel', 'dm'], default: 'channel' },
    // for DMs: exactly the two participants; for channels: empty (all members)
    participantIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    dmKey: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
channelSchema.index({ workspaceId: 1, name: 1 }, { unique: true, partialFilterExpression: { type: 'channel' } });
channelSchema.index({ workspaceId: 1, dmKey: 1 }, { unique: true, partialFilterExpression: { dmKey: { $type: 'string' } } });
export const Channel = model('Channel', channelSchema);

const messageSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    channelId: { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: '', maxlength: 8000 },
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    reactions: [{ emoji: String, userIds: [{ type: Schema.Types.ObjectId }] }],
    readBy: [{ type: Schema.Types.ObjectId }],
    attachment: { name: String, url: String, path: String, mime: String },
    editedAt: Date,
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);
messageSchema.index({ workspaceId: 1, channelId: 1, createdAt: -1 });
export const Message = model('Message', messageSchema);
