export type Role = 'owner' | 'admin' | 'manager' | 'member' | 'viewer';
export const ROLES: Role[] = ['owner', 'admin', 'manager', 'member', 'viewer'];
export const STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface User { id: string; name: string; email: string; avatarColor: string; title?: string; isPlatformAdmin?: boolean; emailVerified?: boolean; needsEmailVerification?: boolean }
export interface Workspace { id: string; name: string; slug: string; plan: 'free' | 'pro' | 'business'; role: Role }
export interface MemberRow { id: string; role: Role; joinedAt: string; user: User & { lastActiveAt?: string } }
export interface Project {
  id: string; name: string; description: string; status: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED';
  memberIds: string[]; startDate?: string; deadline?: string; color: string; taskCount?: number; doneCount?: number;
}
export interface Task {
  id: string; projectId: string; title: string; description: string; status: Status; priority: Priority;
  assigneeId: string | null; createdBy: string; dueDate?: string | null; labels: string[]; position: number;
  completedAt?: string; source: 'manual' | 'ai' | 'meeting'; activity: { userId: string; action: string; at: string }[]; createdAt: string; updatedAt: string;
}
export interface Comment { id: string; taskId: string; text: string; createdAt: string; user: { id: string; name: string; avatarColor: string } }
export interface Channel { id: string; name: string; type: 'channel' | 'dm'; participantIds: string[]; unread: number }
export interface Message {
  id: string; channelId: string; userId: string; text: string; createdAt: string; editedAt?: string; deleted: boolean; replyTo: string | null;
  user?: { id: string; name: string; avatarColor: string }; reactions: { emoji: string; userIds: string[] }[]; attachment?: { name: string; url: string; mime?: string };
}
export interface Notification { id: string; type: string; title: string; body: string; link: string; read: boolean; createdAt: string }
export interface DocumentRow {
  id: string; name: string; size: number; status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED'; error?: string; pageCount: number; chunkCount: number;
  projectId: string | null; createdAt: string; uploadedBy?: { name: string } | string;
}
export interface Source { documentId: string; name: string; pageNumber: number; snippet: string }
export interface Candidate { title: string; description: string; priority: Priority; assigneeId: string | null; assigneeName: string | null; dueDate: string | null }
export interface Meeting {
  id: string; title: string; status: 'TRANSCRIBING' | 'PROCESSING' | 'READY' | 'FAILED'; source?: 'text' | 'audio'; error?: string; audio?: { name: string; size: number }; summary: string; decisions: string[]; deadlines: string[]; createdAt: string; transcript?: string;
  actionItems: { title: string; description: string; priority: Priority; assigneeId?: string; assigneeName?: string; dueDate?: string; approved: boolean }[];
}
export interface Plan {
  id: 'free' | 'pro' | 'business'; name: string; priceMonthly: number; maxMembers: number; maxProjects: number; aiRequestsPerMonth: number; storageMb: number;
  features: { rag: boolean; meetings: boolean; advancedAnalytics: boolean; auditLogs: boolean; apiAccess: boolean };
}
