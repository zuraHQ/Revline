import { ConvexError, v } from 'convex/values';
import { PROJECT_MEDIA_LIMIT } from '../lib/editor/limits';
import { internalMutation, type MutationCtx } from './_generated/server';
import { assetDocument, imageGenerationValidator } from './schema';
import { projectIdentity, projectRun } from './lib/project_data';
import { internal } from './_generated/api';
import { requireEditorAccess } from './lib/billing_access';
import { consumeFairUse } from './lib/account_limits';
import { recordAssetStorage } from './lib/storage_accounting';
import { hydrateAsset } from './lib/asset_analysis';
import { projectMediaPrefix } from './lib/media_storage';
import type { Id } from './_generated/dataModel';

const scope = { ownerId: v.string(), projectId: v.id('projects'), runId: v.string() };
async function requireCapacity(ctx: MutationCtx, args: { ownerId: string; projectId: Id<'projects'>; runId: string }, count: number) {
  const project = await projectRun(ctx, args.projectId, args.ownerId);
  if (!project.aiRunning || project.aiRunId !== args.runId) throw new ConvexError('AI run is no longer active');
  await requireEditorAccess(ctx, args.ownerId);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new ConvexError('Generate between 1 and 4 image variants.');
  const assets = await ctx.db.query('assets').withIndex('by_ownerId_projectId', q => q.eq('ownerId', args.ownerId).eq('projectId', args.projectId)).take(PROJECT_MEDIA_LIMIT);
  if (assets.length + count > PROJECT_MEDIA_LIMIT) throw new ConvexError(`A project supports up to ${PROJECT_MEDIA_LIMIT} media files. Remove unused media before generating images.`);
}

/** Check paid access and space before making a provider call. */
export const prepare = internalMutation({ args: { ...scope, count: v.number() }, returns: v.null(), handler: async (ctx, args) => {
  await requireCapacity(ctx, args, args.count);
  await consumeFairUse(ctx, args.ownerId, 'imageGenerations', args.count);
  return null;
} });

/** A lost save acknowledgement must never delete an asset that actually committed. */
export const cleanup = internalMutation({ args: { ...scope, keys: v.array(v.string()) }, returns: v.null(), handler: async (ctx, args) => {
  await projectIdentity(ctx, args.projectId, args.ownerId);
  for (const key of args.keys) {
    if (!key.startsWith(projectMediaPrefix(args.ownerId, args.projectId))) throw new ConvexError('Generated image key is outside this project');
    const saved = await ctx.db.query('assets').withIndex('by_owner_project_r2Key', q => q.eq('ownerId', args.ownerId).eq('projectId', args.projectId).eq('r2Key', key)).first();
    if (!saved) await ctx.scheduler.runAfter(0, internal.r2.deleteObject, { key });
  }
  return null;
} });

/** One transaction attaches every variant, with the same accounting as uploaded media. */
export const save = internalMutation({
  args: { ...scope, provenance: imageGenerationValidator, images: v.array(v.object({ r2Key: v.string(), size: v.number(), width: v.number(), height: v.number() })) },
  returns: v.array(assetDocument),
  handler: async (ctx, args) => {
    await requireCapacity(ctx, args, args.images.length);
    const saved = [];
    for (const [index, image] of args.images.entries()) {
      if (!image.r2Key.startsWith(projectMediaPrefix(args.ownerId, args.projectId))) throw new ConvexError('Generated image key is outside this project');
      const id = await ctx.db.insert('assets', { ownerId: args.ownerId, projectId: args.projectId, ...image, fileName: `Generated plate ${index + 1}.png`, contentType: 'image/png', kind: 'image', imageGeneration: args.provenance, createdAt: Date.now() });
      const asset = (await ctx.db.get(id))!;
      await recordAssetStorage(ctx, asset);
      saved.push(await hydrateAsset(ctx, asset));
    }
    return saved;
  },
});
