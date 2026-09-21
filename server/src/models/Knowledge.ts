import { Schema, model } from 'mongoose';

const documentSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    name: { type: String, required: true },
    mimeType: String,
    ext: String,
    size: Number,
    storagePath: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'PROCESSING', 'READY', 'FAILED'], default: 'PENDING' },
    error: String,
    pageCount: { type: Number, default: 0 },
    chunkCount: { type: Number, default: 0 },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
documentSchema.index({ workspaceId: 1, createdAt: -1 });
export const DocumentModel = model('Document', documentSchema);

const chunkSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, required: true },
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  pageNumber: { type: Number, default: 1 },
  chunkIndex: { type: Number, required: true },
  text: { type: String, required: true },
  embedding: { type: [Number], select: false },
});
chunkSchema.index({ workspaceId: 1, documentId: 1, chunkIndex: 1 });
export const DocChunk = model('DocumentChunk', chunkSchema);

const actionItemSchema = new Schema({
  title: String,
  description: String,
  priority: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], default: 'MEDIUM' },
  assigneeName: String,
  assigneeId: { type: Schema.Types.ObjectId, ref: 'User' },
  dueDate: Date,
  approved: { type: Boolean, default: false },
  taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
});

const meetingSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    title: { type: String, required: true },
    transcript: { type: String, default: '' }, // filled in by transcription for recordings
    status: { type: String, enum: ['TRANSCRIBING', 'PROCESSING', 'READY', 'FAILED'], default: 'PROCESSING' },
    source: { type: String, enum: ['text', 'audio'], default: 'text' },
    // The recording is deleted as soon as it has been transcribed (or has finally failed); `ref` is internal and never serialised.
    audio: { ref: { type: String, select: false }, name: String, size: Number },
    error: String, // why processing failed, shown to the user
    usageId: { type: Schema.Types.ObjectId, select: false }, // the credit charged for transcription, refunded if it fails for good
    summary: { type: String, default: '' },
    decisions: [String],
    deadlines: [String],
    actionItems: [actionItemSchema],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
meetingSchema.index({ workspaceId: 1, createdAt: -1 });
export const Meeting = model('Meeting', meetingSchema);

const aiConversationSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, default: 'New conversation' },
    messages: [
      {
        role: { type: String, enum: ['user', 'assistant'] },
        content: String,
        sources: [{ documentId: String, name: String, pageNumber: Number, snippet: String }],
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);
aiConversationSchema.index({ workspaceId: 1, userId: 1, updatedAt: -1 });
export const AiConversation = model('AiConversation', aiConversationSchema);
