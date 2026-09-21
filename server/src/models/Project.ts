import { Schema, model } from 'mongoose';

export const TASK_STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const;
export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

const projectSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 5000 },
    status: { type: String, enum: ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED'], default: 'ACTIVE' },
    memberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    startDate: Date,
    deadline: Date,
    color: { type: String, default: '#6366f1' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
projectSchema.index({ workspaceId: 1, createdAt: -1 });
export const Project = model('Project', projectSchema);

const activitySchema = new Schema(
  { userId: { type: Schema.Types.ObjectId, ref: 'User' }, action: String, at: { type: Date, default: Date.now } },
  { _id: false },
);

const taskSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 10000 },
    status: { type: String, enum: TASK_STATUSES, default: 'TODO' },
    priority: { type: String, enum: TASK_PRIORITIES, default: 'MEDIUM' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dueDate: Date,
    labels: [{ type: String, maxlength: 30 }],
    position: { type: Number, default: 0 },
    completedAt: Date,
    deadlineNotified: { type: Boolean, default: false },
    source: { type: String, enum: ['manual', 'ai', 'meeting'], default: 'manual' },
    attachments: [{ name: String, url: String }],
    activity: { type: [activitySchema], default: [] },
  },
  { timestamps: true },
);
taskSchema.index({ workspaceId: 1, projectId: 1, status: 1 });
taskSchema.index({ workspaceId: 1, assigneeId: 1 });
taskSchema.index({ workspaceId: 1, dueDate: 1 });
export const Task = model('Task', taskSchema);

const commentSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: 5000 },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);
commentSchema.index({ workspaceId: 1, taskId: 1, createdAt: 1 });
export const Comment = model('Comment', commentSchema);
