import { v } from 'convex/values';
import { MAX_MODEL_BYTES, PROJECT_MEDIA_LIMIT } from '../lib/editor/limits';
import { issueUpload, consumeUpload } from './uploads';
import { projectIdentity } from './lib/project_data';
import { requireEditorAccess } from './lib/billing_access';
import { recordAssetStorage } from './lib/storage_accounting';
import { z } from 'zod';
import { internal } from './_generated/api';
import { httpAction, internalMutation, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { mediaConfig } from './lib/media_storage';
import { openUpload, signPartUrl } from './r2';
import { signMediaToken, verifyMediaToken } from '../lib/storage/media-tokens';
import { localUploadScript } from '../lib/storage/local-upload-script';
import { publicMcpOrigin } from './lib/mcp_origin';

const metadataInput = z.object({ size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), width: z.number().int().min(1).max(16384).optional(), height: z.number().int().min(1).max(16384).optional(), duration: z.number().positive().optional() }).strict();
const uploadScope = z.object({ ownerId: z.string().min(1), projectId: z.string().min(1), fileName: z.string().trim().min(1).max(255), contentType: z.string().regex(/^(?:(video|image|audio)\/[\w.+-]+|model\/gltf-binary)$/) });
type UploadScope = z.infer<typeof uploadScope>;
export function mediaKind(contentType: string) {
  if (/^model\/gltf-binary$/.test(contentType)) return 'model';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  throw new Error('Choose a video, image or audio file.');
}

/** Prepares multipart media uploads or a scoped native upload for small GLB models. */
async function prepareLocalUpload(ctx: ActionCtx, scope: UploadScope, metadata: z.infer<typeof metadataInput>) {
  const kind = mediaKind(scope.contentType);
  if (kind === 'model') return { modelUploadUrl: publicUploadUrl(await ctx.runMutation(internal.mcpUploads.modelUploadUrl, { ownerId: scope.ownerId, projectId: scope.projectId as Id<'projects'> })) };
  if (kind !== 'image' && !metadata.duration) throw new Error('This media has no readable duration.');
  const upload = await openUpload(ctx, { projectId: scope.projectId as Id<'projects'>, fileName: scope.fileName, contentType: scope.contentType, kind, ...metadata }, scope.ownerId);
  const lease = await ctx.runQuery(internal.r2.getLease, { uploadId: upload.uploadId, ownerId: scope.ownerId });
  const urls = await Promise.all(Array.from({ length: upload.partCount }, (_, index) => signPartUrl(lease, index + 1)));
  return { ...upload, urls };
}

/** The ticketed /uploads URL under the MCP server's public address (/mcp/upload/model), so agents only see Revline's own domain. */
function publicUploadUrl(url: string) {
  const ticket = new URL(url).searchParams.get('ticket') ?? '';
  return `${publicMcpOrigin()}/mcp/upload/model?ticket=${encodeURIComponent(ticket)}`;
}

export async function startLocalUpload(ctx: ActionCtx, scope: UploadScope, filePath: string) {
  const kind = mediaKind(scope.contentType), projectId = scope.projectId as Id<'projects'>;
  await ctx.runQuery(internal.r2.authorize, { ownerId: scope.ownerId, projectId, kind, contentType: scope.contentType });
  // The public MCP address (tryrevline.com in production), never the deployment's *.convex.site URL.
  const site = publicMcpOrigin();
  if (!site) throw new Error('Upload endpoint is not configured.');
  const { secret } = mediaConfig();
  const token = await signMediaToken(secret, { operation: 'prepareUpload', upload: scope, expires: Date.now() + 3600_000 });
  return { script: localUploadScript({ filePath, kind, endpoint: `${site}/mcp/upload`, token }), next: kind === 'model' ? 'Run the script with sh and Node 22+. It uploads the self-contained GLB (up to 32 MB) and prints its assetId. Attach that assetId as scene media; no finishUpload or addMedia call is needed.' : 'Run this script with sh (Node 22+ and ffprobe must be installed). It reads size, dimensions and duration, uploads the file, and prints JSON. Pass that whole JSON object as the arguments to finishUpload. The script expires in one hour.' };
}

export const prepare = httpAction(async (ctx, request) => {
  const { secret } = mediaConfig();
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  const grant = await verifyMediaToken(secret, token);
  const scope = uploadScope.safeParse(grant?.upload);
  if (grant?.operation !== 'prepareUpload' || !scope.success) return Response.json({ error: 'Upload access expired. Call uploadMedia again.' }, { status: 401 });
  const text = await request.text();
  if (text.length > 4096) return Response.json({ error: 'Upload metadata is too large.' }, { status: 413 });
  try {
    const input: unknown = JSON.parse(text);
    const model = z.object({ storageId: z.string().min(1) }).strict().safeParse(input);
    if (mediaKind(scope.data.contentType) === 'model' && model.success) return Response.json({ assetId: await ctx.runMutation(internal.mcpUploads.finishModel, { ownerId: scope.data.ownerId, projectId: scope.data.projectId as Id<'projects'>, fileName: scope.data.fileName, storageId: model.data.storageId as Id<'_storage'> }) });
    const metadata = metadataInput.parse(input);
    return Response.json(await prepareLocalUpload(ctx, scope.data, metadata), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 1000) : 'Could not prepare this upload.' }, { status: 400 });
  }
});

/** Small self-contained models use the existing scoped Convex storage path; no media worker job. */
export const modelUploadUrl = internalMutation({ args: { ownerId: v.string(), projectId: v.id('projects') }, returns: v.string(), handler: async (ctx, args) => {
  await projectIdentity(ctx, args.projectId, args.ownerId);
  await requireEditorAccess(ctx, args.ownerId);
  return issueUpload(ctx, args.ownerId, args.projectId);
} });
export const finishModel = internalMutation({ args: { ownerId: v.string(), projectId: v.id('projects'), storageId: v.id('_storage'), fileName: v.string() }, returns: v.id('assets'), handler: async (ctx, args) => {
  await projectIdentity(ctx, args.projectId, args.ownerId);
  await requireEditorAccess(ctx, args.ownerId);
  const file = await ctx.db.system.get(args.storageId);
  if (!file || file.contentType !== 'model/gltf-binary' || file.size > MAX_MODEL_BYTES || !file.size) throw new Error('Use a self-contained GLB model under 32 MB.');
  const count = await ctx.db.query('assets').withIndex('by_ownerId_projectId', q => q.eq('ownerId', args.ownerId).eq('projectId', args.projectId)).take(PROJECT_MEDIA_LIMIT);
  if (count.length >= PROJECT_MEDIA_LIMIT) throw new Error(`A project supports up to ${PROJECT_MEDIA_LIMIT} media files.`);
  await consumeUpload(ctx, args.storageId, args.ownerId, args.projectId);
  const id = await ctx.db.insert('assets', { ...args, kind: 'model', contentType: file.contentType, size: file.size, createdAt: Date.now() });
  await recordAssetStorage(ctx, (await ctx.db.get(id))!);
  return id;
} });
